// ============================================================
// vet402 — day windows are lengths of TIME, not block counts (2026-11-07).
//
// Base moved from 2 s to 0.2 s blocks at block 53,556,127 (2026-11-05T18:00:01Z).
// The code used 43,200 blocks as "a day", so the 7-day feedback window became
// ~17 hours and every lag threshold shrank 10x. These tests pin:
//   1. the schedule against real mainnet samples (measured 2026-11-07),
//   2. windows that straddle the change point (until 2026-11-12T18:00Z) are 7 days of time,
//   3. lag at 0.2 s is judged in seconds (tail, settlements, owner index),
//   4. chains without a schedule keep the old constant arithmetic.
// No RPC, no DB.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BASE_BLOCK_TIME_SCHEDULE,
  constantClock,
  firstBlockAtOrAfter,
  scheduleClock,
  scheduleDriftSeconds,
  timestampOfBlock,
} from "@/lib/chain/block-clock";
import { CHAINS, chainClock } from "@/lib/chain/chains";
import { agentResolveTailMaxBlocks } from "@/lib/chain/agent-resolve-window";
import { feedbackWindowFromBlock, planFeedbackSources, tailMaxBlocks } from "@/lib/chain/feedback-window";
import { indexLag, SETTLEMENTS_INDEX_MAX_LAG_SECONDS } from "@/lib/health/index-lag";
import { EVM_INDEX_CHAINS, evmIndexLag } from "@/lib/settlements/index-evm";

const S = BASE_BLOCK_TIME_SCHEDULE;
const BASE = scheduleClock(S);
const DAY = 86_400;
const CHANGE = 53_556_127n;
/** Live tip read from mainnet.base.org on 2026-11-07 (01:44:10Z). */
const TIP_1107 = 54_127_372n;
const FLOOR = 41_663_783n;
const utc = (iso: string) => Date.parse(iso) / 1000;
/** Block whose timestamp is exactly `iso` in the 0.2 s era (first of its second). */
const blockAt = (iso: string) => firstBlockAtOrAfter(S, utc(iso));

test("schedule matches mainnet samples on both sides of the change", () => {
  const samples: [bigint, number][] = [
    [0n, 1_686_789_347],
    [53_556_000n, 1_793_901_347],
    [53_556_125n, 1_793_901_597],
    [53_556_126n, 1_793_901_599],
    [CHANGE, 1_793_901_601],
    [53_556_128n, 1_793_901_601],
    [53_556_131n, 1_793_901_601],
    [53_556_132n, 1_793_901_602],
    [53_556_137n, 1_793_901_603],
    [53_557_000n, 1_793_901_775],
    [53_937_211n, 1_793_977_817],
    [54_078_286n, 1_794_006_032],
    [54_084_291n, 1_794_007_233],
    [TIP_1107, 1_794_015_850],
  ];
  for (const [block, ts] of samples) {
    assert.equal(timestampOfBlock(S, block), ts, `block ${block}`);
    assert.equal(scheduleDriftSeconds(S, block, ts), 0);
  }
});

test("firstBlockAtOrAfter is the exact inverse: first block with timestamp ≥ t", () => {
  for (const block of [1n, 41_663_783n, 53_556_126n, CHANGE, 53_556_132n, 53_600_003n, TIP_1107]) {
    for (const dt of [-3, -1, 0, 1, 2, 7]) {
      const t = timestampOfBlock(S, block) + dt;
      const first = firstBlockAtOrAfter(S, t);
      assert.ok(timestampOfBlock(S, first) >= t, `ts(${first}) ≥ ${t}`);
      if (first > 0n) assert.ok(timestampOfBlock(S, first - 1n) < t, `ts(${first - 1n}) < ${t}`);
    }
  }
  assert.equal(firstBlockAtOrAfter(S, 0), 0n);
});

test("Base is 432,000 blocks a day now, and chainClock(8453) follows the schedule", () => {
  assert.equal(CHAINS[8453].blocksPerDay, 432_000);
  const end = blockAt("2026-11-20T00:00:00Z");
  assert.equal(chainClock(8453).blocksIn(DAY, end), 432_000n);
  assert.equal(BASE.blocksIn(DAY, end), 432_000n);
  // Fully in the 2 s era it is the old 43,200.
  assert.equal(BASE.blocksIn(DAY, 53_000_000n), 43_200n);
});

test("7-day feedback window on 2026-11-07 reaches back 7 days of time, not 17 hours", () => {
  const from = feedbackWindowFromBlock(TIP_1107, 7, BASE, FLOOR);
  assert.equal(from, 53_310_852n);
  const seconds = timestampOfBlock(S, TIP_1107) - timestampOfBlock(S, from);
  assert.ok(seconds <= 7 * DAY && seconds > 7 * DAY - 2, `${seconds}s`);
  // What the fixed 43,200 blocks/day produced: 302,400 blocks = ~17 hours at 0.2 s.
  const old = feedbackWindowFromBlock(TIP_1107, 7, 43_200, FLOOR);
  assert.equal(old, TIP_1107 - 302_400n);
  assert.ok(BASE.secondsBetween(old, TIP_1107) < 18 * 3600);
  // A single new constant would overshoot by weeks: 3,024,000 blocks back crosses the change.
  const constant = feedbackWindowFromBlock(TIP_1107, 7, 432_000, FLOOR);
  assert.ok(BASE.secondsBetween(constant, TIP_1107) > 50 * DAY);
});

test("windows that straddle the change point stay 7 days long until 2026-11-12T18:00Z and after", () => {
  for (const iso of ["2026-11-05T18:00:01Z", "2026-11-06T00:00:00Z", "2026-11-09T12:00:00Z", "2026-11-12T17:00:00Z", "2026-11-12T17:59:59Z", "2026-11-12T18:00:01Z", "2026-11-13T00:00:00Z"]) {
    const tip = blockAt(iso);
    const from = feedbackWindowFromBlock(tip, 7, BASE, FLOOR);
    const seconds = BASE.secondsBetween(from, tip);
    assert.ok(seconds <= 7 * DAY && seconds >= 7 * DAY - 2, `${iso}: ${seconds}s`);
  }
  // 11/12 17:00Z: the window starts in the 2 s era (before the change), so it mixes both rates.
  const tip = blockAt("2026-11-12T17:00:00Z");
  const from = feedbackWindowFromBlock(tip, 7, BASE, FLOOR);
  assert.ok(from < CHANGE);
  assert.equal(tip - from, 3_007_795n);
  // From 11/12 18:00:01Z on, the whole window is 0.2 s: exactly 7 × 432,000 blocks.
  const later = blockAt("2026-11-12T19:00:00Z");
  assert.equal(later - feedbackWindowFromBlock(later, 7, BASE, FLOOR), 3_024_000n);
});

test("tail and agent-resolve limits are 2 days of time at 0.2 s", () => {
  // At the 11/07 tip, 2 days back crosses the change: 571,245 blocks of 0.2 s + 29,275 of 2 s.
  assert.equal(tailMaxBlocks(BASE, TIP_1107), 600_520n);
  const later = blockAt("2026-11-10T00:00:00Z");
  assert.equal(tailMaxBlocks(BASE, later), 864_000n);
  assert.equal(agentResolveTailMaxBlocks(BASE, later), 864_000n);
  // The old numeric form is unchanged for chains without a schedule.
  assert.equal(tailMaxBlocks(43_200), 86_400n);
  assert.equal(agentResolveTailMaxBlocks(7_200), 14_400n);
});

test("feedback plan at 0.2 s: the production gap of 11/07 01:44Z is a readable tail, not index_behind_tip", () => {
  // indexer checkpoint 54,078,286 (11/06 23:00Z) vs tip 54,127,372: 49,086 blocks = 9,818 s.
  const index = { coverageStart: 52_566_286n, checkpoint: 54_078_286n, entries: [] };
  const fromBlock = feedbackWindowFromBlock(TIP_1107, 7, BASE, FLOOR);
  const plan = planFeedbackSources({ index, fromBlock, latestBlock: TIP_1107, tailMax: tailMaxBlocks(BASE, TIP_1107), allowFullScan: false });
  assert.equal(plan.kind, "index_and_tail");
  // A checkpoint just over 2 days of time behind is index_behind_tip.
  const stale = { ...index, checkpoint: firstBlockAtOrAfter(S, timestampOfBlock(S, TIP_1107) - 2 * DAY) - 1n };
  const plan2 = planFeedbackSources({ index: stale, fromBlock, latestBlock: TIP_1107, tailMax: tailMaxBlocks(BASE, TIP_1107), allowFullScan: false });
  assert.deepEqual(plan2, { kind: "unavailable", reason: "index_behind_tip" });
  // The 7-day window opening before the coverage floor is window_not_covered (never an undercount).
  const young = { ...index, coverageStart: fromBlock + 1n };
  const plan3 = planFeedbackSources({ index: young, fromBlock, latestBlock: TIP_1107, tailMax: tailMaxBlocks(BASE, TIP_1107), allowFullScan: false });
  assert.deepEqual(plan3, { kind: "unavailable", reason: "window_not_covered" });
});

test("deep health: settlements lag is a day of TIME (the 11/07 lag of 190,161 blocks was 10.6 h, not an outage)", () => {
  // Production 11/07 01:44Z: checkpoint 53,937,211, tip 54,127,372.
  const lag = indexLag(BASE, 53_937_211n, TIP_1107, SETTLEMENTS_INDEX_MAX_LAG_SECONDS);
  assert.equal(lag.blocksBehind, 190_161n);
  assert.equal(lag.secondsBehind, 38_033);
  assert.equal(lag.lagging, false, "old rule (> 43,200 blocks) called this critical");
  const tip = blockAt("2026-11-10T00:00:00Z");
  assert.equal(indexLag(BASE, tip - 432_000n, tip, SETTLEMENTS_INDEX_MAX_LAG_SECONDS).lagging, false);
  assert.equal(indexLag(BASE, tip - 432_005n, tip, SETTLEMENTS_INDEX_MAX_LAG_SECONDS).lagging, true);
  // Across the change: checkpoint in the 2 s era (11/05 17:00:01Z), tip a day later in the 0.2 s era.
  // Fewer than 432,000 blocks, so any single constant would call it fine; in time it is over a day.
  const cp = firstBlockAtOrAfter(S, utc("2026-11-05T17:00:00Z"));
  const late = blockAt("2026-11-06T17:00:03Z");
  assert.ok(late - cp < 432_000n, `${late - cp} blocks`);
  assert.equal(indexLag(BASE, cp, late, DAY).secondsBehind, 86_402);
  assert.equal(indexLag(BASE, cp, late, DAY).lagging, true);
  assert.equal(indexLag(BASE, cp, blockAt("2026-11-06T17:00:00Z"), DAY).lagging, false);
});

test("settlement indexer lag uses Base's schedule; other chains keep blocksPerDay", () => {
  const base = EVM_INDEX_CHAINS.find((c) => c.chainId === 8453)!;
  assert.equal(base.blocksPerDay, 432_000n);
  assert.equal(base.blockTimeSchedule, BASE_BLOCK_TIME_SCHEDULE);
  // 2.2 hours of runs (40,000 blocks) used to be the per-run cap: equal to the launchd interval,
  // so a backlog could never shrink. The cap is ~22 hours of chain time again.
  assert.ok(BASE.secondsBetween(TIP_1107, TIP_1107 + base.maxBlocksPerRun) >= 22 * 3600);
  const tip = blockAt("2026-11-10T00:00:00Z");
  assert.equal(evmIndexLag(base, tip, tip - 432_000n), null);
  assert.equal(evmIndexLag(base, tip, tip - 432_005n), 432_005n);
  assert.equal(evmIndexLag(base, TIP_1107, 53_937_211n), null, "10.6 h behind is not a day");
  const arc = EVM_INDEX_CHAINS.find((c) => c.chainId === 5042)!;
  assert.equal(arc.blockTimeSchedule, undefined);
  assert.equal(evmIndexLag(arc, 1_000_000n, 1_000_000n - 86_401n), 86_401n);
});

test("constantClock reproduces the pre-2026-11-07 arithmetic exactly", () => {
  for (const perDay of [7_200, 40_000, 43_200, 86_400, 89_111, 310_500]) {
    const c = constantClock(perDay);
    for (const days of [2, 7, 8, 35]) {
      assert.equal(c.blocksIn(days * DAY, 0n), BigInt(Math.ceil(days * perDay)));
    }
    assert.equal(c.secondsBetween(0n, BigInt(perDay)), DAY);
  }
});

test("drift detection: a schedule that no longer matches the chain is visible", () => {
  // If Base changed block time again, a real block would disagree with the schedule.
  const block = blockAt("2026-12-01T00:00:00Z");
  assert.equal(scheduleDriftSeconds(S, block, utc("2026-12-01T00:00:00Z")), 0);
  assert.equal(scheduleDriftSeconds(S, block, utc("2026-12-01T00:05:00Z")), 300);
});
