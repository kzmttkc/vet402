// L0 cron の時刻。公開文に時刻を直書きせず、vercel.json の l0-probe から出す。
import vercelConfig from "../../../vercel.json";

export const L0_PROBE_CRON_PATH = "/api/cron/l0-probe";

type CronRow = { path?: string; schedule?: string };

export function l0ProbeCronSchedules(
  crons: readonly CronRow[] = (vercelConfig as { crons?: CronRow[] }).crons ?? [],
): string[] {
  return crons
    .filter((row) => row.path === L0_PROBE_CRON_PATH && typeof row.schedule === "string" && row.schedule !== "")
    .map((row) => row.schedule as string);
}

/**
 * coverage の回（窓の外を先に測る L0・drain と優先の段は無い・2026-11-10）。
 * 申し立ての測り直しの時刻（l0ProbeScheduleLabel）には入れない（優先の段があるのは l0-probe の回だけ）。
 */
export const L0_COVERAGE_CRON_PATH = "/api/cron/l0-coverage";

export function l0CoverageCronSchedules(
  crons: readonly CronRow[] = (vercelConfig as { crons?: CronRow[] }).crons ?? [],
): string[] {
  return crons
    .filter((row) => row.path === L0_COVERAGE_CRON_PATH && typeof row.schedule === "string" && row.schedule !== "")
    .map((row) => row.schedule as string);
}

/** 1 日の L0 の回の種類（coverage7d の見込み）。l0-probe は full、l0-coverage は coverage。 */
export function l0CronRunModesPerDay(
  crons: readonly CronRow[] = (vercelConfig as { crons?: CronRow[] }).crons ?? [],
): ("full" | "coverage")[] {
  return [
    ...l0ProbeCronSchedules(crons).map(() => "full" as const),
    ...l0CoverageCronSchedules(crons).map(() => "coverage" as const),
  ];
}

/** 日次の cron（分 時 * * *）を "HH:MM UTC" にする。日次でない式はそのまま返す。 */
export function formatDailyUtcCron(schedule: string): string {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length < 5) return schedule;
  const [minute, hour, dom, month, dow] = parts;
  if (dom !== "*" || month !== "*" || dow !== "*") return schedule;
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return schedule;
  const h = Number(hour);
  const m = Number(minute);
  if (h > 23 || m > 59) return schedule;
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")} UTC`;
}

/** 公開文に入れる L0 の予定時刻。複数本あれば ", " でつなぐ。 */
export function l0ProbeScheduleLabel(crons?: readonly CronRow[]): string {
  const times = l0ProbeCronSchedules(crons).map(formatDailyUtcCron);
  if (times.length === 0) return "the time set for the L0 cron";
  return times.join(", ");
}
