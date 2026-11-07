// ============================================================
// vet402 — Base block time follow-ups (2026-11-07, independent review).
//
//   1. A block-time schedule that no longer matches the chain is a critical
//      failure: monitor-health answers 503, so smoke checks and ALERTS see it.
//   2. The late-settlement Base reader turns times into blocks with the
//      schedule, not 2 s per block (windows on both sides of the change).
//   3. The first settlement run on Base reaches back 7 days of TIME.
//   4. Settlement block times inside a window follow the schedule, so a
//      window that straddles the change is not linearly interpolated.
// No RPC, no DB.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BASE_BLOCK_TIME_SCHEDULE as S, firstBlockAtOrAfter, timestampOfBlock } from "@/lib/chain/block-clock";
import { blockScheduleVerdict } from "@/lib/health/index-lag";
import { makeBaseTransferReader } from "@/lib/settlements/recover-late";
import { EVM_INDEX_CHAINS, evmBlockTimeOf, initialLookbackBlocksAt } from "@/lib/settlements/index-evm";

const DAY = 86_400;
const CHANGE = 53_556_127n;
const TIP_1107 = 54_127_372n;
const utc = (iso: string) => Date.parse(iso) / 1000;

test("schedule drift beyond 60 s is critical; within it is ok", () => {
  const block = TIP_1107;
  const ts = timestampOfBlock(S, block);
  assert.deepEqual(blockScheduleVerdict(block, ts), { driftSeconds: 0, drift: false });
  assert.deepEqual(blockScheduleVerdict(block, ts + 60), { driftSeconds: 60, drift: false });
  assert.deepEqual(blockScheduleVerdict(block, ts + 61), { driftSeconds: 61, drift: true });
  assert.deepEqual(blockScheduleVerdict(block, ts - 3_600), { driftSeconds: -3_600, drift: true });
});

test("deep health turns a schedule drift into criticalFailure (monitor-health answers 503)", () => {
  const src = readFileSync(join(__dirname, "..", "src/lib/health/deep-checks.ts"), "utf8");
  assert.match(src, /if \(scheduleDrift\) \{[\s\S]{0,200}criticalFailure = true;/);
  const monitor = readFileSync(join(__dirname, "..", "src/app/api/cron/monitor-health/route.ts"), "utf8");
  assert.match(monitor, /result\.criticalFailure \? 503 : 200/);
});

function fakeBaseClient(head: bigint) {
  const reads: { fromBlock: bigint; toBlock: bigint }[] = [];
  const client = {
    getBlock: async (q: { blockTag?: string; blockNumber?: bigint }) => {
      const n = q.blockTag === "latest" ? head : q.blockNumber!;
      return { number: n, timestamp: BigInt(timestampOfBlock(S, n)) };
    },
    getLogs: async (q: { fromBlock: bigint; toBlock: bigint }) => {
      reads.push({ fromBlock: q.fromBlock, toBlock: q.toBlock });
      return [];
    },
  };
  return { client: client as never, reads };
}

const q = (fromIso: string, toIso: string) => ({
  network: "eip155:8453",
  payer: "0x00000000000000000000000000000000000000c1",
  payTo: "0x00000000000000000000000000000000000000b1",
  from: new Date(fromIso),
  to: new Date(toIso),
});

/** The block range a reader covered, across however many chunks it used. */
function covered(reads: { fromBlock: bigint; toBlock: bigint }[]) {
  const sorted = [...reads].sort((a, b) => (a.fromBlock < b.fromBlock ? -1 : 1));
  for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i]!.fromBlock, sorted[i - 1]!.toBlock + 1n, "chunks are contiguous");
  return { fromBlock: sorted[0]!.fromBlock, toBlock: sorted.at(-1)!.toBlock };
}

test("late-settlement Base reader: a window after the change maps to its exact blocks (± 60)", async () => {
  const { client, reads } = fakeBaseClient(TIP_1107);
  await makeBaseTransferReader(client)(q("2026-11-06T12:00:00Z", "2026-11-06T12:30:00Z"));
  const from = firstBlockAtOrAfter(S, utc("2026-11-06T12:00:00Z"));
  const to = firstBlockAtOrAfter(S, utc("2026-11-06T12:30:00Z"));
  assert.deepEqual(covered(reads), { fromBlock: from - 60n, toBlock: to + 60n });
  assert.equal(to - from, 9_000n, "30 minutes at 0.2 s");
});

test("late-settlement Base reader: a window before and one across the change land on the right blocks", async () => {
  const { client, reads } = fakeBaseClient(TIP_1107);
  // Entirely in the 2 s era. 2 s per block counted back from a 0.2 s head lands ~9 days late.
  await makeBaseTransferReader(client)(q("2026-11-04T10:00:00Z", "2026-11-04T10:30:00Z"));
  const f1 = firstBlockAtOrAfter(S, utc("2026-11-04T10:00:00Z"));
  const t1 = firstBlockAtOrAfter(S, utc("2026-11-04T10:30:00Z"));
  assert.deepEqual(covered(reads), { fromBlock: f1 - 60n, toBlock: t1 + 60n });
  assert.equal(t1 - f1, 900n);
  reads.length = 0;
  // Across the change point.
  await makeBaseTransferReader(client)(q("2026-11-05T17:50:00Z", "2026-11-05T18:10:00Z"));
  const f2 = firstBlockAtOrAfter(S, utc("2026-11-05T17:50:00Z"));
  const t2 = firstBlockAtOrAfter(S, utc("2026-11-05T18:10:00Z"));
  assert.ok(f2 < CHANGE && t2 > CHANGE);
  assert.deepEqual(covered(reads), { fromBlock: f2 - 60n, toBlock: t2 + 60n });
  // 17:50:01 → 18:00:01 is 300 blocks of 2 s; 18:00:01 → 18:10:00 is 599 s × 5 blocks.
  assert.equal(t2 - f2, 300n + 2_995n);
});

test("late-settlement Base reader: the window end never passes the head", async () => {
  const { client, reads } = fakeBaseClient(TIP_1107);
  await makeBaseTransferReader(client)(q("2026-11-07T01:40:00Z", "2026-11-07T02:00:00Z"));
  assert.equal(covered(reads).toBlock, TIP_1107);
});

test("first settlement run on Base reaches back 7 days of time; other chains keep their block counts", () => {
  const base = EVM_INDEX_CHAINS.find((c) => c.chainId === 8453)!;
  assert.equal(base.initialLookbackDays, 7);
  const back = initialLookbackBlocksAt(base, TIP_1107);
  assert.equal(back, 816_520n);
  const seconds = timestampOfBlock(S, TIP_1107) - timestampOfBlock(S, TIP_1107 - back);
  assert.ok(seconds <= 7 * DAY && seconds >= 7 * DAY - 1, `${seconds}s`);
  const later = firstBlockAtOrAfter(S, utc("2026-11-20T00:00:00Z"));
  assert.equal(initialLookbackBlocksAt(base, later), 7n * 432_000n);
  const arc = EVM_INDEX_CHAINS.find((c) => c.chainId === 5042)!;
  assert.equal(initialLookbackBlocksAt(arc, 10_000_000n), 86_400n * 7n);
});

test("settlement block times follow the schedule inside a window that straddles the change", () => {
  const base = EVM_INDEX_CHAINS.find((c) => c.chainId === 8453)!;
  const from = 53_550_000n;
  const to = 53_600_000n;
  const t0 = timestampOfBlock(S, from) * 1000;
  const t1 = timestampOfBlock(S, to) * 1000;
  const at = evmBlockTimeOf(base, from, t0, to, t1);
  for (const n of [from, CHANGE - 1n, CHANGE, CHANGE + 5n, 53_580_000n, to]) {
    assert.equal(at(n).getTime(), timestampOfBlock(S, n) * 1000, `block ${n}`);
  }
  // A chain without a schedule keeps the measured-ends linear interpolation.
  const arc = EVM_INDEX_CHAINS.find((c) => c.chainId === 5042)!;
  const lin = evmBlockTimeOf(arc, 0n, 0, 100n, 100_000);
  assert.equal(lin(50n).getTime(), 50_000);
});

// ---- the late-settlement Base reader reads its window in chunks (2026-11-07 review) ----

function chunkingBaseClient(head: bigint, opts: { maxRange: bigint; failChunkFrom?: bigint; transferAt?: bigint[] }) {
  const reads: { fromBlock: bigint; toBlock: bigint }[] = [];
  const client = {
    chain: { id: 8453 },
    transport: { url: "https://indexer.example/base" },
    getBlock: async (q: { blockTag?: string; blockNumber?: bigint }) => {
      const n = q.blockTag === "latest" ? head : q.blockNumber!;
      return { number: n, timestamp: BigInt(timestampOfBlock(S, n)) };
    },
    getLogs: async (q: { fromBlock: bigint; toBlock: bigint }) => {
      reads.push({ fromBlock: q.fromBlock, toBlock: q.toBlock });
      if (q.toBlock - q.fromBlock + 1n > opts.maxRange) throw new Error(`block range exceeds ${opts.maxRange}`);
      if (opts.failChunkFrom !== undefined && q.fromBlock <= opts.failChunkFrom && opts.failChunkFrom <= q.toBlock) {
        throw Object.assign(new Error("upstream answered 500"), { code: -32000, details: "internal error" });
      }
      return (opts.transferAt ?? [])
        .filter((b) => b >= q.fromBlock && b <= q.toBlock)
        .map((b) => ({
          blockNumber: b,
          transactionHash: `0x${b.toString(16).padStart(64, "0")}`,
          args: { from: "0x00000000000000000000000000000000000000c1", to: "0x00000000000000000000000000000000000000b1", value: 10_000n },
        }));
    },
  };
  return { client: client as never, reads };
}

async function withChunkBlocks<T>(blocks: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.GET_LOGS_CHUNK_BLOCKS;
  process.env.GET_LOGS_CHUNK_BLOCKS = blocks;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.GET_LOGS_CHUNK_BLOCKS;
    else process.env.GET_LOGS_CHUNK_BLOCKS = prev;
  }
}

test("late-settlement Base reader: a window wider than one RPC range is read in contiguous chunks", async () => {
  const fromIso = "2026-11-06T12:00:00Z";
  const toIso = "2026-11-06T12:32:00Z"; // ≈ 9,720 blocks with the 60-block margins
  const from = firstBlockAtOrAfter(S, utc(fromIso)) - 60n;
  const to = firstBlockAtOrAfter(S, utc(toIso)) + 60n;
  const early = from + 10n;
  const late = to - 10n;
  const { client, reads } = chunkingBaseClient(TIP_1107, { maxRange: 1_000n, transferAt: [early, late] });
  const out = await withChunkBlocks("1000", () => makeBaseTransferReader(client)(q(fromIso, toIso)));

  assert.ok(to - from + 1n > 9_000n);
  assert.ok(reads.length >= 10, `${reads.length} reads`);
  assert.ok(reads.every((r) => r.toBlock - r.fromBlock + 1n <= 1_000n), "no read is wider than the RPC allows");
  const sorted = [...reads].sort((a, b) => (a.fromBlock < b.fromBlock ? -1 : 1));
  assert.equal(sorted[0]!.fromBlock, from);
  assert.equal(sorted.at(-1)!.toBlock, to);
  for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i]!.fromBlock, sorted[i - 1]!.toBlock + 1n);
  assert.deepEqual(out?.map((t) => t.blockTime), [early, late].map((b) => new Date(timestampOfBlock(S, b) * 1000).toISOString()));
});

test("late-settlement Base reader: a failed chunk fails the read (unread), never a 'no transfer' answer", async () => {
  const fromIso = "2026-11-06T12:00:00Z";
  const toIso = "2026-11-06T12:32:00Z";
  const from = firstBlockAtOrAfter(S, utc(fromIso)) - 60n;
  const { client, reads } = chunkingBaseClient(TIP_1107, { maxRange: 1_000n, failChunkFrom: from + 4_500n, transferAt: [] });
  await assert.rejects(
    withChunkBlocks("1000", () => makeBaseTransferReader(client)(q(fromIso, toIso))),
    /upstream answered 500/,
  );
  assert.ok(reads.length >= 2, "other chunks were read, and the answer still is not 'none'");
  // The caller turns a thrown read into an unread row (it does not decide the row has no transfer).
  const src = readFileSync(join(__dirname, "..", "src/lib/settlements/recover-late.ts"), "utf8");
  assert.match(src, /readFailure = error \?\? new Error\("the transfer read failed"\);\s*return null;/);
  assert.match(src, /else noteUnread\("the transfer read failed", list\.length, readFailure\);\s*continue;/);
});
