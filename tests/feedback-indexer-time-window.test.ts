// ============================================================
// vet402 — the NewFeedback index keeps its days in chain TIME (2026-11-07).
//
// Retention was 35 × 43,200 blocks. After Base moved to 0.2 s blocks
// (53,556,127, 2026-11-05T18:00Z) that was 3.5 days of history and shrinking,
// so each run deleted rows the 7-day scoring window needs and dragged the
// coverage floor forward; a forward scan never brings it back. Pinned here:
//   1. bootstrap (8 d) and retention (35 d) are lengths of time at 0.2 s
//   2. a floor newer than the bootstrap time is backfilled backwards, newest first,
//      and the floor moves down only after that segment's rows are written
//   3. the backfill never runs before the forward scan reached the tip, never throws,
//      and a time budget / failed read keeps what it already wrote
// DB and RPC are swapped out (deps).
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { indexFeedbackEvents, type FeedbackIndexDeps } from "@/lib/indexer/feedback-indexer";
import { FEEDBACK_COVERAGE_CHECKPOINT, FEEDBACK_INDEX_CHECKPOINT } from "@/lib/db/feedback-index";
import type { FeedbackEventRow } from "@/lib/db/feedback-index-writer";
import { BASE_BLOCK_TIME_SCHEDULE as S, firstBlockAtOrAfter, timestampOfBlock } from "@/lib/chain/block-clock";

const DAY = 86_400;
const TIP = firstBlockAtOrAfter(S, Date.parse("2026-11-20T00:00:00Z") / 1000);
const daysBack = (d: number) => firstBlockAtOrAfter(S, timestampOfBlock(S, TIP) - d * DAY);

type World = {
  checkpoints: Map<string, bigint>;
  rows: FeedbackEventRow[];
  reads: { from: bigint; to: bigint }[];
  lowered: bigint[];
  pruneCalls: bigint[];
  clock: number;
};

function makeWorld(over: {
  checkpoint: bigint;
  coverage: bigint;
  msPerRead?: number;
  failReadAt?: number;
}): { world: World; deps: FeedbackIndexDeps } {
  const world: World = {
    checkpoints: new Map([
      [FEEDBACK_INDEX_CHECKPOINT, over.checkpoint],
      [FEEDBACK_COVERAGE_CHECKPOINT, over.coverage],
    ]),
    rows: [],
    reads: [],
    lowered: [],
    pruneCalls: [],
    clock: 0,
  };
  const deps: FeedbackIndexDeps = {
    client: { getBlockNumber: async () => TIP },
    getLogs: async (_client, params) => {
      const i = world.reads.length;
      world.reads.push({ from: params.fromBlock, to: params.toBlock });
      world.clock += over.msPerRead ?? 10;
      if (over.failReadAt === i) throw Object.assign(new Error("rpc down"), { details: "rpc down" });
      return [params.fromBlock, params.toBlock].map((blockNumber, n) => ({
        args: { agentId: 7n, clientAddress: "0x00000000000000000000000000000000000000c1" },
        blockNumber,
        logIndex: n,
        transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
      }));
    },
    getCheckpoint: async (scope) => world.checkpoints.get(scope) ?? null,
    setCheckpoints: async (entries) => {
      for (const e of entries) {
        const prev = world.checkpoints.get(e.scope); // production: GREATEST
        if (prev === undefined || e.lastBlock > prev) world.checkpoints.set(e.scope, e.lastBlock);
      }
    },
    record: async (rows) => {
      world.rows.push(...rows);
      return rows.length;
    },
    prune: async (_chainId, before) => {
      world.pruneCalls.push(before);
      return 0;
    },
    lowerCoverage: async (lastBlock) => {
      // production: LEAST, and only ever called after record()
      const prev = world.checkpoints.get(FEEDBACK_COVERAGE_CHECKPOINT)!;
      if (lastBlock < prev) world.checkpoints.set(FEEDBACK_COVERAGE_CHECKPOINT, lastBlock);
      world.lowered.push(lastBlock);
    },
    now: () => world.clock,
  };
  return { world, deps };
}

test("steady state at 0.2 s: one short tail, retention cut at 35 days of time, no backfill", async () => {
  const coverage = daysBack(30);
  const { world, deps } = makeWorld({ checkpoint: TIP - 4_500n, coverage });
  const result = await indexFeedbackEvents({ deps });

  assert.equal(world.reads.length, 1);
  assert.deepEqual(world.reads[0], { from: TIP - 4_500n, to: TIP });
  assert.equal(result.backfill, undefined);
  assert.deepEqual(world.lowered, []);
  // 35 days of chain time (this one reaches back across the 11/05 change), not
  // 35 × 43,200 = 1,512,000 blocks, which at 0.2 s is 3.5 days.
  assert.deepEqual(world.pruneCalls, [daysBack(35)]);
  const kept = timestampOfBlock(S, TIP) - timestampOfBlock(S, daysBack(35));
  assert.ok(kept <= 35 * DAY && kept >= 35 * DAY - 1, `${kept}s`);
  assert.equal(timestampOfBlock(S, TIP) - timestampOfBlock(S, TIP - 1_512_000n), 302_400);
  assert.equal(world.checkpoints.get(FEEDBACK_COVERAGE_CHECKPOINT), coverage);
});

test("a floor newer than 8 days is backfilled backwards to the bootstrap time, floor lowered segment by segment", async () => {
  const damaged = daysBack(3.5); // what the block-count retention left behind
  const { world, deps } = makeWorld({ checkpoint: TIP - 4_500n, coverage: damaged });
  const result = await indexFeedbackEvents({ segmentBlocks: 400_000n, deps });

  const target = daysBack(8);
  // forward read first, then backwards, contiguous, newest first, ending exactly at the bootstrap block
  assert.deepEqual(world.reads[0], { from: TIP - 4_500n, to: TIP });
  const back = world.reads.slice(1);
  assert.equal(back[0]!.to, damaged - 1n);
  for (let i = 1; i < back.length; i++) assert.equal(back[i]!.to, back[i - 1]!.from - 1n);
  assert.equal(back.at(-1)!.from, target);
  assert.equal(back.length, Math.ceil(Number(damaged - target) / 400_000));
  // the floor only ever moves down to a segment's start, after its rows were recorded
  assert.deepEqual(world.lowered, back.map((r) => r.from));
  assert.equal(world.checkpoints.get(FEEDBACK_COVERAGE_CHECKPOINT), target);
  assert.equal(result.coverageStart, target.toString());
  assert.deepEqual(result.backfill, { fromBlock: target.toString(), toBlock: (damaged - 1n).toString(), events: back.length * 2 });
  assert.ok(world.rows.some((r) => r.blockNumber === target));
  assert.equal(world.checkpoints.get(FEEDBACK_INDEX_CHECKPOINT), TIP);
  // the 7-day window is covered again
  assert.ok(target <= daysBack(7));
});

test("backfill stops at the time budget and keeps what it wrote", async () => {
  const damaged = daysBack(3.5);
  const { world, deps } = makeWorld({ checkpoint: TIP - 4_500n, coverage: damaged, msPerRead: 100 });
  const result = await indexFeedbackEvents({ segmentBlocks: 100_000n, timeBudgetMs: 350, deps });

  // forward (100 ms) + 3 backfill segments (300 ms) → budget hit before the 4th
  assert.equal(world.reads.length, 4);
  const lowest = world.reads.at(-1)!.from;
  assert.equal(world.checkpoints.get(FEEDBACK_COVERAGE_CHECKPOINT), lowest);
  assert.equal(result.backfill?.stoppedBy, "time_budget");
  assert.equal(result.backfill?.fromBlock, lowest.toString());
  assert.equal(result.partial, false, "the forward scan itself completed");
});

test("a failed backfill read does not throw and does not lower the floor for that segment", async () => {
  const damaged = daysBack(3.5);
  const { world, deps } = makeWorld({ checkpoint: TIP - 4_500n, coverage: damaged, failReadAt: 2 });
  const result = await indexFeedbackEvents({ segmentBlocks: 400_000n, deps });

  assert.equal(world.lowered.length, 1, "only the first backfill segment landed");
  assert.equal(world.checkpoints.get(FEEDBACK_COVERAGE_CHECKPOINT), world.reads[1]!.from);
  assert.match(result.backfill?.stoppedBy ?? "", /^rpc:/);
  assert.equal(world.checkpoints.get(FEEDBACK_INDEX_CHECKPOINT), TIP);
});

test("no backfill while the forward scan has not reached the tip", async () => {
  const damaged = daysBack(3.5);
  const { world, deps } = makeWorld({ checkpoint: TIP - 900_000n, coverage: damaged });
  const result = await indexFeedbackEvents({ maxBlocks: 400_000n, deps });

  assert.equal(result.caughtUp, false);
  assert.equal(result.backfill, undefined);
  assert.deepEqual(world.lowered, []);
  assert.ok(world.reads.every((r) => r.from >= TIP - 900_000n));
});
