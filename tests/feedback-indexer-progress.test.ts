// ============================================================
// vet402 — NewFeedback の索引は、読めた分だけ進む（2026-10-13）。
//
// 以前は 1 回の run の全範囲（最大 400,000 ブロック）を 1 度に読み、全部読めたときだけ
// 書いて checkpoint を進めた。途中の 1 chunk が落ちると全部を捨て、次の回も同じ先頭から。
// 遅れた索引ほど 1 回の範囲が広く、落ちる見込みも高いので、追いつけない形だった。
// ここが固定すること:
//   1. 区切りごとに「読む → 書く → checkpoint」。全部読めた回の結果と checkpoint は以前と同じ
//   2. 途中で読み先が落ちたら、手前の区切りまでは書いて進め、partial で返す
//   3. 最初の区切りで落ちたら throw。何も書かず、checkpoint も動かさない
//   4. 行を書けなかった区切りの先へ checkpoint は進まない（その範囲が二度と読まれなくなる）
//   5. 持ち時間を超えたら新しい区切りを始めずに止まる
//   6. checkpoint は「最後に読み終えたブロック」。読み手は checkpoint + 1 から tail を読むので、
//      途中で止まった回の後も、索引と tail の間に数えられないブロックが無い
//   7. 読んでいる途中の区切りが返ってこなくても、壁時計で待つのをやめる
// DB も RPC も使わない（差し替え口 deps）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { indexFeedbackEvents, type FeedbackIndexDeps } from "@/lib/indexer/feedback-indexer";
import { FEEDBACK_COVERAGE_CHECKPOINT, FEEDBACK_INDEX_CHECKPOINT } from "@/lib/db/feedback-index";
import type { FeedbackEventRow } from "@/lib/db/feedback-index-writer";
import { DeadlineExceededError } from "@/lib/util/deadline";

const TIP = 52_556_796n;
const START = 52_339_334n; // 10/8 から本番の checkpoint が止まっていたブロック
const COVERAGE = 51_100_000n;

type World = {
  checkpoints: Map<string, bigint>;
  checkpointWrites: { scope: string; lastBlock: bigint }[][];
  rows: FeedbackEventRow[];
  segments: { from: bigint; to: bigint }[];
  pruneCalls: bigint[];
  clock: number;
};

function makeWorld(over?: {
  failAtSegment?: number;
  failWith?: Error;
  recordFailsAtSegment?: number;
  /** この番号の区切りの読み取りが、いつまでも返ってこない。 */
  hangAtSegment?: number;
  msPerSegment?: number;
  checkpoint?: bigint | null;
}): { world: World; deps: FeedbackIndexDeps } {
  const world: World = {
    checkpoints: new Map<string, bigint>([[FEEDBACK_COVERAGE_CHECKPOINT, COVERAGE]]),
    checkpointWrites: [],
    rows: [],
    segments: [],
    pruneCalls: [],
    clock: 0,
  };
  if (over?.checkpoint !== null) world.checkpoints.set(FEEDBACK_INDEX_CHECKPOINT, over?.checkpoint ?? START);
  let recordCalls = 0;

  const deps: FeedbackIndexDeps = {
    client: { getBlockNumber: async () => TIP },
    getLogs: async (_client, params) => {
      const index = world.segments.length;
      world.segments.push({ from: params.fromBlock, to: params.toBlock });
      world.clock += over?.msPerSegment ?? 10;
      if (over?.hangAtSegment === index) return new Promise<never>(() => {});
      if (over?.failAtSegment === index) {
        throw (
          over.failWith ??
          Object.assign(new Error("RPC Request failed.\n\nURL: https://rpc.example/v2/SECRETKEY\n\nDetails: request limit reached"), {
            code: -32011,
            details: "request limit reached",
          })
        );
      }
      // 区切りごとに 2 件: 先頭と末尾のブロック。
      return [params.fromBlock, params.toBlock].map((blockNumber, i) => ({
        args: { agentId: 7n, clientAddress: "0x00000000000000000000000000000000000000c1" },
        blockNumber,
        logIndex: i,
        transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
      }));
    },
    getCheckpoint: async (scope) => world.checkpoints.get(scope) ?? null,
    setCheckpoints: async (entries) => {
      world.checkpointWrites.push(entries.map((e) => ({ scope: e.scope, lastBlock: e.lastBlock })));
      for (const e of entries) {
        // 本番の GREATEST と同じ: 巻き戻さない。
        const prev = world.checkpoints.get(e.scope);
        if (prev === undefined || e.lastBlock > prev) world.checkpoints.set(e.scope, e.lastBlock);
      }
    },
    record: async (rows) => {
      const call = recordCalls++;
      if (over?.recordFailsAtSegment === call) throw new Error("db write failed");
      world.rows.push(...rows);
      return rows.length;
    },
    prune: async (_chainId, before) => {
      world.pruneCalls.push(before);
      return 0;
    },
    now: () => world.clock,
  };
  return { world, deps };
}

const indexCheckpoint = (w: World) => w.checkpoints.get(FEEDBACK_INDEX_CHECKPOINT);

test("every segment readable: the whole backlog is read once, gap-free, and the checkpoint lands on the tip", async () => {
  const { world, deps } = makeWorld();
  const result = await indexFeedbackEvents({ maxBlocks: 400_000n, segmentBlocks: 20_000n, deps });

  // 217,463 ブロック → 20,000 ずつ 11 区切り。重複も穴もない。
  assert.equal(world.segments.length, 11);
  assert.equal(world.segments[0]!.from, START);
  assert.equal(world.segments.at(-1)!.to, TIP);
  for (let i = 1; i < world.segments.length; i++) {
    assert.equal(world.segments[i]!.from, world.segments[i - 1]!.to + 1n);
  }

  assert.equal(result.caughtUp, true);
  assert.equal(result.partial, false);
  assert.equal(result.stoppedBy, undefined);
  assert.equal(result.fromBlock, START.toString());
  assert.equal(result.toBlock, TIP.toString());
  assert.equal(result.events, 22);
  assert.equal(result.inserted, 22);
  assert.equal(world.rows.length, 22);
  // 追いついた回の checkpoint は tip（以前と同じ値）。
  assert.equal(indexCheckpoint(world), TIP);
  // 途中の checkpoint は、その区切りで最後に読み終えたブロック（行を書いた後に進む）。
  assert.equal(world.checkpointWrites[0]![0]!.lastBlock, START + 20_000n - 1n);
  assert.equal(world.checkpointWrites[0]![0]!.lastBlock, world.segments[0]!.to);
  // floor は最後の 1 文でだけ動く（途中は元の値のまま書く）。
  for (const write of world.checkpointWrites.slice(0, -1)) {
    assert.equal(write.find((e) => e.scope === FEEDBACK_COVERAGE_CHECKPOINT)!.lastBlock, COVERAGE);
  }
  assert.equal(world.pruneCalls.length, 1);
});

test("the endpoint dies on the third segment: the first two are kept and the checkpoint moves exactly that far", async () => {
  const { world, deps } = makeWorld({ failAtSegment: 2 });
  const result = await indexFeedbackEvents({ maxBlocks: 400_000n, segmentBlocks: 20_000n, deps });

  assert.equal(result.partial, true);
  assert.equal(result.caughtUp, false);
  assert.equal(result.toBlock, (START + 40_000n - 1n).toString());
  assert.equal(result.events, 4);
  assert.equal(result.inserted, 4);
  // 読み先の言い分だけを 1 行で。URL と鍵は出さない。
  assert.equal(result.stoppedBy, "rpc:request limit reached");
  assert.ok(!JSON.stringify(result).includes("SECRETKEY"));

  // 進んだのは読めた 2 区切りぶんだけ: checkpoint は 2 つ目の区切りの最後のブロック。
  assert.equal(indexCheckpoint(world), START + 40_000n - 1n);
  assert.equal(world.rows.length, 4);
  assert.ok(world.rows.every((r) => r.blockNumber < START + 40_000n));
  // 4 つ目以降は読みに行っていない。
  assert.equal(world.segments.length, 3);
});

test("after a run that stopped midway, no block is left between the index and the reader's tail", async () => {
  const { world, deps } = makeWorld({ failAtSegment: 2 });
  await indexFeedbackEvents({ maxBlocks: 400_000n, segmentBlocks: 20_000n, deps });
  const checkpoint = indexCheckpoint(world)!;

  // 読み手（erc8004.ts の fetchRecentFeedbackStats）は checkpoint + 1n から tail を読む。
  const tailStart = checkpoint + 1n;
  // 索引に入った最後のブロック = checkpoint（差し替えの読み先は区切りの両端に 1 件ずつ返す）。
  const maxWritten = world.rows.reduce((m, r) => (r.blockNumber > m ? r.blockNumber : m), 0n);
  assert.equal(maxWritten, checkpoint);
  // 読めた区切りは START から checkpoint までを穴なく覆う。
  const read = world.segments.slice(0, 2);
  assert.equal(read[0]!.from, START);
  assert.equal(read[1]!.from, read[0]!.to + 1n);
  assert.equal(read[1]!.to, checkpoint);
  // tail の最初のブロックは、読めなかった区切りの最初のブロック。間に 1 ブロックも無い。
  assert.equal(tailStart, world.segments[2]!.from);
  assert.equal(tailStart - maxWritten, 1n);
});

test("the next run resumes at the checkpoint block (one block re-read, none skipped)", async () => {
  const first = makeWorld({ failAtSegment: 2 });
  await indexFeedbackEvents({ maxBlocks: 400_000n, segmentBlocks: 20_000n, deps: first.deps });
  const resumeAt = indexCheckpoint(first.world)!;
  assert.equal(resumeAt, START + 40_000n - 1n);

  const second = makeWorld({ checkpoint: resumeAt });
  const result = await indexFeedbackEvents({ maxBlocks: 400_000n, segmentBlocks: 20_000n, deps: second.deps });
  assert.equal(second.world.segments[0]!.from, resumeAt);
  assert.equal(result.caughtUp, true);
  assert.equal(indexCheckpoint(second.world), TIP);
  // 2 回を合わせて、START..TIP に読まれないブロックが無い（回の境目は 1 ブロックだけ重なる）。
  const all = [...first.world.segments.slice(0, 2), ...second.world.segments];
  assert.equal(all[0]!.from, START);
  assert.equal(all.at(-1)!.to, TIP);
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i]!.from <= all[i - 1]!.to + 1n, `gap before ${all[i]!.from}`);
    assert.ok(all[i]!.from >= all[i - 1]!.to, `more than one block re-read at ${all[i]!.from}`);
  }
});

test("the endpoint dies on the first segment: it throws, writes nothing and moves no checkpoint", async () => {
  const { world, deps } = makeWorld({ failAtSegment: 0 });
  await assert.rejects(
    indexFeedbackEvents({ maxBlocks: 400_000n, segmentBlocks: 20_000n, deps }),
    (e: unknown) => (e as { code?: number }).code === -32011,
  );
  assert.equal(world.rows.length, 0);
  assert.equal(world.checkpointWrites.length, 0);
  assert.equal(indexCheckpoint(world), START);
  assert.equal(world.pruneCalls.length, 0);
});

test("rows that could not be written stop the run before the checkpoint passes them", async () => {
  const { world, deps } = makeWorld({ recordFailsAtSegment: 1 });
  await assert.rejects(
    indexFeedbackEvents({ maxBlocks: 400_000n, segmentBlocks: 20_000n, deps }),
    /db write failed/,
  );
  // 1 つ目の区切りは書けたので、そこまでは進む。書けなかった 2 つ目の先へは進まない。
  assert.equal(indexCheckpoint(world), START + 20_000n - 1n);
  assert.ok(world.rows.every((r) => r.blockNumber < START + 20_000n));
});

test("past the time budget no new segment starts; what was read is kept", async () => {
  // 1 区切り 100 秒かかる読み先。新しい区切りを始めてよいのは 200 秒まで → 2 区切りで止まる。
  const { world, deps } = makeWorld({ msPerSegment: 100_000 });
  const result = await indexFeedbackEvents({ maxBlocks: 400_000n, segmentBlocks: 20_000n, deps });
  assert.equal(world.segments.length, 2);
  assert.equal(result.partial, true);
  assert.equal(result.stoppedBy, "time_budget");
  assert.equal(result.caughtUp, false);
  assert.equal(indexCheckpoint(world), START + 40_000n - 1n);
  assert.equal(world.rows.length, 4);
});

test("a segment read that never comes back is abandoned at the hard stop; earlier segments are kept", async () => {
  const { world, deps } = makeWorld({ hangAtSegment: 1 });
  const started = Date.now();
  const result = await indexFeedbackEvents({ maxBlocks: 400_000n, segmentBlocks: 20_000n, hardStopMs: 80, deps });
  assert.ok(Date.now() - started < 5_000, "the run waited for a read that never returns");
  assert.equal(result.partial, true);
  assert.equal(result.stoppedBy, "hard_stop");
  assert.equal(indexCheckpoint(world), START + 20_000n - 1n);
  assert.equal(world.rows.length, 2);
  // 最後の checkpoint と prune まで走る（関数ごと殺されると、ここに来ない）。
  assert.equal(world.pruneCalls.length, 1);
});

test("the first segment never comes back: it throws at the hard stop and moves nothing", async () => {
  const { world, deps } = makeWorld({ hangAtSegment: 0 });
  await assert.rejects(
    indexFeedbackEvents({ maxBlocks: 400_000n, segmentBlocks: 20_000n, hardStopMs: 50, deps }),
    DeadlineExceededError,
  );
  assert.equal(world.checkpointWrites.length, 0);
  assert.equal(world.rows.length, 0);
});

test("a zero budget still tries the first segment (never 'succeeds' without reading)", async () => {
  const { world, deps } = makeWorld();
  const result = await indexFeedbackEvents({ maxBlocks: 400_000n, segmentBlocks: 20_000n, timeBudgetMs: 0, deps });
  assert.equal(world.segments.length, 1);
  assert.equal(result.partial, true);
  assert.equal(indexCheckpoint(world), START + 20_000n - 1n);
});

test("maxBlocks still caps one run, and a capped run is not called partial", async () => {
  const { world, deps } = makeWorld();
  const result = await indexFeedbackEvents({ maxBlocks: 50_000n, segmentBlocks: 20_000n, deps });
  // 以前と同じ: fromBlock + maxBlocks まで（両端を含む）。
  assert.equal(result.toBlock, (START + 50_000n).toString());
  assert.equal(result.caughtUp, false);
  assert.equal(result.partial, false);
  // checkpoint は最後に読んだブロック（以前は +1 を書いていて、tail がそのブロックを飛ばした）。
  assert.equal(indexCheckpoint(world), START + 50_000n);
  assert.equal(world.segments.length, 3);
});

test("steady state (one cron interval behind) is a single segment and a single checkpoint write, as before", async () => {
  const { world, deps } = makeWorld({ checkpoint: TIP - 10_800n });
  const result = await indexFeedbackEvents({ deps });
  assert.equal(world.segments.length, 1);
  assert.deepEqual(world.segments[0], { from: TIP - 10_800n, to: TIP });
  assert.equal(world.checkpointWrites.length, 1);
  assert.equal(result.caughtUp, true);
  assert.equal(result.partial, false);
});
