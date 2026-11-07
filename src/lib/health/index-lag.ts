import {
  BASE_BLOCK_TIME_SCHEDULE,
  SCHEDULE_DRIFT_TOLERANCE_SECONDS,
  scheduleDriftSeconds,
  type ChainClock,
} from "@/lib/chain/block-clock";

/**
 * Index lag in chain TIME (2026-11-07).
 *
 * The deep health check used to compare `tip - checkpoint` with block counts
 * derived from Base's old 2 s block time (43,200 = "a day"). At 0.2 s blocks
 * the same count is 2.4 hours, so the checks fired on lag that was healthy and
 * would have stayed quiet past the real limit had the block time moved the
 * other way. A lag is a length of time; the clock turns blocks into seconds.
 */
export type IndexLag = {
  blocksBehind: bigint;
  secondsBehind: number;
  lagging: boolean;
};

export function indexLag(
  clock: ChainClock,
  checkpoint: bigint,
  tip: bigint,
  maxLagSeconds: number,
): IndexLag {
  const blocksBehind = tip - checkpoint;
  const secondsBehind = clock.secondsBetween(checkpoint, tip);
  return { blocksBehind, secondsBehind, lagging: secondsBehind > maxLagSeconds };
}

/** Settlement index: more than a day behind is an outage (criticalFailure), as before — now a day of time. */
export const SETTLEMENTS_INDEX_MAX_LAG_SECONDS = 86_400;

/**
 * Base's block-time schedule against one real block (2026-11-07). A drift past
 * the tolerance means Base changed its block time again and every day-window
 * built on the schedule is the wrong length — a critical failure, so
 * monitor-health answers 503 and the smoke check and ALERTS see it.
 */
export function blockScheduleVerdict(block: bigint, timestamp: number): { driftSeconds: number; drift: boolean } {
  const driftSeconds = scheduleDriftSeconds(BASE_BLOCK_TIME_SCHEDULE, block, timestamp);
  return { driftSeconds, drift: Math.abs(driftSeconds) > SCHEDULE_DRIFT_TOLERANCE_SECONDS };
}
