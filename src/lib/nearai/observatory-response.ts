import { getNearAiStore } from "./store";
import type { NearAiPublicSnapshot } from "./read-public";

/** Daily NEAR AI probe cron: `0 9 * * *` (09:00 UTC). */
export const NEARAI_PROBE_UTC_HOUR = 9;

export type NearAiNoRunYet = {
  status: "no_run_yet";
  next_run_utc: string;
  models: [];
};

export type NearAiObservatoryBody = NearAiPublicSnapshot | NearAiNoRunYet;

export function nextNearAiRunUtc(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const todayRun = Date.UTC(y, m, d, NEARAI_PROBE_UTC_HOUR, 0, 0, 0);
  const target = now.getTime() < todayRun ? todayRun : Date.UTC(y, m, d + 1, NEARAI_PROBE_UTC_HOUR, 0, 0, 0);
  return new Date(target).toISOString();
}

export function nearAiNoRunYet(now?: Date): NearAiNoRunYet {
  return { status: "no_run_yet", next_run_utc: nextNearAiRunUtc(now), models: [] };
}

export async function readNearAiObservatory(): Promise<NearAiObservatoryBody> {
  const snapshot = await getNearAiStore().getLatestPublicSnapshot();
  if (!snapshot) return nearAiNoRunYet();
  return snapshot;
}