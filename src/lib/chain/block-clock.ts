/**
 * Block ↔ time arithmetic (2026-11-07).
 *
 * WHY THIS FILE EXISTS. Every "last N days" window in this codebase used to be
 * `tip - N * blocksPerDay`, with Base pinned at 43,200 blocks a day (2 s
 * blocks). Base moved to 0.2 s blocks at block 53,556,127
 * (2026-11-05T18:00:01Z, measured on mainnet.base.org): from there on a "day"
 * is 432,000 blocks, and the old constant quietly turned a 7-day window into
 * ~17 hours and a 2-day tail limit into ~4.8 hours.
 *
 * A single new constant would not be right either: any window that reaches
 * back across the change point mixes 2 s blocks and 0.2 s blocks, so
 * `tip - 7 * 432_000` would reach ~58 days back on 2026-11-07. The window has
 * to be decided by block TIME, not by block COUNT.
 *
 * Base is an OP Stack chain: its block timestamps follow a fixed schedule
 * (genesis + n × block time), so the first block at or after a given time can
 * be computed exactly from the schedule with zero RPC calls. The request path
 * cannot afford a timestamp binary search (≈22 sequential eth_getBlockByNumber
 * calls), and does not need one. What the schedule cannot do is notice the
 * NEXT block-time change — so `scheduleDriftSeconds` exists for the deep health
 * check to compare the schedule against a real block, and say so loudly.
 *
 * Chains without a schedule fall back to their constant `blocksPerDay`, which
 * is exactly the arithmetic they used before (pinned by tests).
 */

export const SECONDS_PER_DAY = 86_400;

/**
 * One stretch of a chain's history with a constant block time.
 * timestamp(n) = fromTimestamp + floor((n - fromBlock) × msPerBlock / 1000)
 * for fromBlock ≤ n < next segment's fromBlock.
 */
export type BlockTimeSegment = {
  fromBlock: bigint;
  /** Unix seconds of `fromBlock`. */
  fromTimestamp: number;
  msPerBlock: number;
};

/**
 * Base mainnet, measured 2026-11-07 against https://mainnet.base.org:
 *  - block 0 = 1686789347 (2023-06-15), then exactly 2 s per block up to and
 *    including 53,556,127 (1793901601 = 2026-11-05T18:00:01Z);
 *  - from 53,556,127 on, 5 blocks per second: 53,556,127..53,556,131 all carry
 *    1793901601, 53,556,132 carries 1793901602, and 54,127,372 carried
 *    1794015850 — exactly 1793901601 + floor((54,127,372 - 53,556,127) / 5).
 * tests/block-clock.test.ts pins these samples.
 */
export const BASE_BLOCK_TIME_SCHEDULE: readonly BlockTimeSegment[] = [
  { fromBlock: 0n, fromTimestamp: 1_686_789_347, msPerBlock: 2_000 },
  { fromBlock: 53_556_127n, fromTimestamp: 1_793_901_601, msPerBlock: 200 },
];

function segmentForBlock(schedule: readonly BlockTimeSegment[], block: bigint): BlockTimeSegment {
  let seg = schedule[0]!;
  for (const s of schedule) if (s.fromBlock <= block) seg = s;
  return seg;
}

/** Unix seconds of `block` according to the schedule. */
export function timestampOfBlock(schedule: readonly BlockTimeSegment[], block: bigint): number {
  const seg = segmentForBlock(schedule, block);
  const offset = block > seg.fromBlock ? block - seg.fromBlock : 0n;
  return seg.fromTimestamp + Number((offset * BigInt(seg.msPerBlock)) / 1000n);
}

/**
 * First block whose timestamp is ≥ `timestamp` (block 0 when the time is
 * before the schedule starts).
 */
export function firstBlockAtOrAfter(schedule: readonly BlockTimeSegment[], timestamp: number): bigint {
  let seg = schedule[0]!;
  for (const s of schedule) if (s.fromTimestamp <= timestamp) seg = s;
  if (timestamp <= seg.fromTimestamp) return seg.fromBlock;
  // Smallest k with floor(k × ms / 1000) ≥ d  ⇔  k ≥ d × 1000 / ms  ⇒  k = ceil(d × 1000 / ms).
  const ms = BigInt(seg.msPerBlock);
  const d = BigInt(Math.ceil(timestamp - seg.fromTimestamp)) * 1000n;
  return seg.fromBlock + (d + ms - 1n) / ms;
}

/**
 * How a caller turns "the last N seconds ending at block X" into blocks.
 * Both methods take the END block because, across a block-time change, the
 * answer depends on where the window sits.
 */
export type ChainClock = {
  /** Blocks in the `seconds` that end at block `end` (the window's first block is `end - result`). */
  blocksIn(seconds: number, end: bigint): bigint;
  /** Seconds of chain time between `from` and `to` (0 when to ≤ from). */
  secondsBetween(from: bigint, to: bigint): number;
};

/** The arithmetic every chain used before 2026-11-07: one constant rate. */
export function constantClock(blocksPerDay: number): ChainClock {
  return {
    blocksIn: (seconds) => BigInt(Math.ceil((seconds * blocksPerDay) / SECONDS_PER_DAY)),
    secondsBetween: (from, to) => (to > from ? (Number(to - from) * SECONDS_PER_DAY) / blocksPerDay : 0),
  };
}

export function scheduleClock(schedule: readonly BlockTimeSegment[]): ChainClock {
  return {
    blocksIn: (seconds, end) => {
      const start = firstBlockAtOrAfter(schedule, timestampOfBlock(schedule, end) - seconds);
      return end > start ? end - start : 0n;
    },
    secondsBetween: (from, to) =>
      to > from ? timestampOfBlock(schedule, to) - timestampOfBlock(schedule, from) : 0,
  };
}

/** Accepts the old numeric form so existing callers (other chains, tests) keep their arithmetic. */
export function asClock(rate: number | ChainClock): ChainClock {
  return typeof rate === "number" ? constantClock(rate) : rate;
}

/**
 * Schedule vs reality, in seconds (positive = the chain is ahead of the
 * schedule). Non-zero means the block time changed again and every window
 * built on the schedule is wrong; the deep health check reports it.
 */
export function scheduleDriftSeconds(
  schedule: readonly BlockTimeSegment[],
  block: bigint,
  actualTimestamp: number,
): number {
  return actualTimestamp - timestampOfBlock(schedule, block);
}

/** Drift the deep health check tolerates before calling the schedule stale. */
export const SCHEDULE_DRIFT_TOLERANCE_SECONDS = 60;
