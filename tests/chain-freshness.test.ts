// ============================================================
// vet402 — data freshness by chain, measured in chain time (2026-11-08).
//
// Pins:
//   1. the expected interval comes from the schedule (Base) or blocksPerDay,
//   2. a measured interval 2x off either way is "drift" (Base 2 s -> 0.2 s would have tripped it),
//   3. lag is the gap between two real block timestamps, not blocks x a constant,
//   4. a chain that cannot be read says so ("chain not read"), never ok,
//   5. /api/health and its two uptime monitors are untouched: freshness lives on /status.
// No RPC, no DB.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  expectedMsPerBlock,
  intervalVerdict,
  measuredMsPerBlock,
  readEvmChainFreshness,
} from "@/lib/health/chain-freshness";
import { BASE_BLOCK_TIME_SCHEDULE } from "@/lib/chain/block-clock";

test("expected interval: schedule's newest segment, else blocksPerDay", () => {
  assert.equal(expectedMsPerBlock({ blocksPerDay: 432_000n, blockTimeSchedule: BASE_BLOCK_TIME_SCHEDULE }), 200);
  assert.equal(expectedMsPerBlock({ blocksPerDay: 86_400n }), 1000);
});

test("interval drift: 2x either way, unknown when not measured", () => {
  assert.equal(intervalVerdict(2000, 200), "drift"); // the 2026-11-05 Base change against the old constant
  assert.equal(intervalVerdict(200, 2000), "drift");
  assert.equal(intervalVerdict(1000, 1500), "ok");
  assert.equal(intervalVerdict(1000, null), "unknown");
  assert.equal(intervalVerdict(1000, 0), "unknown");
});

test("measured interval from two block timestamps", () => {
  assert.equal(measuredMsPerBlock(0n, 100, 1000n, 300), 200);
  assert.equal(measuredMsPerBlock(10n, 100, 10n, 100), null);
});

function reader(tip: bigint, tsOf: (n: bigint) => number) {
  return {
    getBlockNumber: async () => tip,
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, timestamp: BigInt(tsOf(blockNumber)) }),
  };
}

test("lag is tip time minus checkpoint time, from the chain", async () => {
  // 0.2 s blocks: 18,000 blocks behind = 3,600 s. A 2 s constant would have said 36,000 s.
  const r = await readEvmChainFreshness(
    { caip2: "eip155:8453", blocksPerDay: 432_000n, blockTimeSchedule: BASE_BLOCK_TIME_SCHEDULE },
    { lastBlock: 82_000n, updatedAt: new Date("2026-11-08T00:00:00Z") },
    reader(100_000n, (n) => Math.floor(Number(n) / 5)),
  );
  assert.equal(r.secondsBehind, 3600);
  assert.equal(r.measuredMsPerBlock, 200);
  assert.equal(r.interval, "ok");
  assert.equal(r.label, "Base");
  assert.equal(r.note, null);
});

test("a chain whose interval moved is flagged", async () => {
  const r = await readEvmChainFreshness(
    { caip2: "eip155:42220", blocksPerDay: 86_400n },
    { lastBlock: 99_000n, updatedAt: null },
    reader(100_000n, (n) => Number(n) * 3),
  );
  assert.equal(r.interval, "drift");
});

test("a chain that cannot be read is not ok", async () => {
  const r = await readEvmChainFreshness(
    { caip2: "eip155:42220", blocksPerDay: 86_400n },
    { lastBlock: 1n, updatedAt: new Date() },
    { getBlockNumber: async () => { throw new Error("rpc down"); }, getBlock: async () => { throw new Error("x"); } },
  );
  assert.equal(r.interval, "unknown");
  assert.equal(r.secondsBehind, null);
  assert.equal(r.note, "chain not read");
});

test("caught up: checkpoint at the tip is 0 s behind", async () => {
  const r = await readEvmChainFreshness(
    { caip2: "eip155:42220", blocksPerDay: 86_400n },
    { lastBlock: 100_000n, updatedAt: new Date() },
    reader(100_000n, (n) => Number(n)),
  );
  assert.equal(r.secondsBehind, 0);
});

test("/status shows freshness by chain; /api/health public body is unchanged", () => {
  const status = readFileSync("src/app/status/page.tsx", "utf8");
  assert.match(status, /readChainFreshness\(/);
  assert.match(status, /Data freshness, by chain/);
  const health = readFileSync("src/app/api/health/route.ts", "utf8");
  assert.match(health, /return NextResponse\.json\(\{ status \}, \{ status: httpStatus \}\);/);
  assert.doesNotMatch(health, /chain-freshness/);
});
