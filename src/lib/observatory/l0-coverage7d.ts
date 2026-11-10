// coverage7d（公開集計）を上げるための L0 列の定義。分母・分子の式は reader.ts のまま変えない。
import { sql, type SQL } from "drizzle-orm";
import { REPROBE_MIN_INTERVAL_MS } from "./l0-rule-change-reprobe";

/** getCoverageShare / state API と同じ 7 日窓。 */
export const L0_COVERAGE7D_WINDOW_DAYS = 7;

/** 普通の L0 列の登録ドメインあたり開始間隔（優先の下限と同じ）。 */
export const L0_NORMAL_DOMAIN_INTERVAL_MS = REPROBE_MIN_INTERVAL_MS;

/** Vercel cron（c1）の 1 回あたり既定件数（maxDuration 300・ホスト混在前提）。 */
export const L0_CRON_C1_DEFAULT_LIMIT = 4500;

/** runL0ProbeBatch の壁時計上限（route maxDuration 300 より少し短く、返却の余白）。 */
export const L0_PROBE_BATCH_BUDGET_MS = 280_000;

/** pct1 で 22.4% を超えるのに要る分子（分母 131,995 固定・要確認の丸め）。 */
export const COVERAGE7D_MEASURED_PCT_TARGET = 22.4;
export const COVERAGE7D_MEASURED_COUNT_TARGET = 29_633;

/** 直近 7 日に L0 行があるか（endpoint エイリアスは既定 e）。 */
export function l0ProbedWithinCoverage7dSql(endpointAlias = "e"): SQL {
  return sql`EXISTS (
    SELECT 1 FROM x402_l0_probes p
    WHERE p.endpoint_id = ${sql.raw(endpointAlias)}.id
      AND p.probed_at > now() - interval '7 days'
  )`;
}

/** 列の先頭キー: 0 = 窓の外（優先）, 1 = 窓の内（後回し）。 */
export function l0Coverage7dQueueClassSql(): SQL {
  return sql`CASE WHEN ${l0ProbedWithinCoverage7dSql("e")} THEN 1 ELSE 0 END`;
}

/** 2026-11-09 公開値（オーナー報告）。 projection の起点。 */
export const COVERAGE7D_BASELINE_2026_11_09 = {
  activeEndpoints: 131_995,
  measuredLast7d: 28_822,
  pct: 21.8,
} as const;

export type L0DailyCapacityInput = {
  cronL0RunsPerDay: number;
  limitPerRun: number;
  priorityCap: number;
  maxDurationSec: number;
  concurrency: number;
  domainIntervalMs?: number;
};

/**
 * 1 実行で開始しうる L0 件数の上限。
 * 同一登録ドメインは同時 1 件・開始間隔 domainIntervalMs なので、
 * ホスト混在時は concurrency 本のレーン × 各 floor(T/interval)、
 * 1 ドメインに偏ると 1 レーン分（floor(T/interval)）だけになる。
 */
export function l0ProbeStartsPerRunBounds(input: L0DailyCapacityInput): {
  scheduledPerRun: number;
  slotsPerLane: number;
  diverseHostStarts: number;
  singleDomainStarts: number;
} {
  const domainIntervalMs = input.domainIntervalMs ?? REPROBE_MIN_INTERVAL_MS;
  const scheduledPerRun = Math.max(0, input.limitPerRun - input.priorityCap);
  const slotsPerLane = Math.floor((input.maxDurationSec * 1000) / Math.max(domainIntervalMs, 1));
  const diverseHostStarts = Math.min(scheduledPerRun, slotsPerLane * Math.max(1, input.concurrency));
  const singleDomainStarts = Math.min(scheduledPerRun, slotsPerLane);
  return { scheduledPerRun, slotsPerLane, diverseHostStarts, singleDomainStarts };
}

/** 1 日に「枠として予約できる」L0 件数（ホスト混在前提の effectivePerRun × cron 回数）。 */
export function l0ProbeEffectiveDailyCapacity(input: L0DailyCapacityInput): {
  scheduledPerRun: number;
  slotsPerLane: number;
  diverseHostStarts: number;
  singleDomainStarts: number;
  effectivePerRun: number;
  effectivePerDay: number;
} {
  const bounds = l0ProbeStartsPerRunBounds(input);
  const effectivePerRun = bounds.diverseHostStarts;
  return {
    ...bounds,
    effectivePerRun,
    effectivePerDay: effectivePerRun * Math.max(0, input.cronL0RunsPerDay),
  };
}

/**
 * 窓外優先で有効新規（窓に入っていなかった endpoint）が概ね effectivePerDay 件/日増えると仮定。
 * 窓内の再プローブを後回しにすると、均しで measuredLast7d/7 件/日が 7 日窓から落ちうる（単純積み上げ・要確認）。
 */
export function projectCoverage7dMeasured(
  baseline: { activeEndpoints: number; measuredLast7d: number },
  effectiveNewProbesPerDay: number,
  days: number,
  opts?: { deferInWindowReprobe?: boolean },
): { measured: number; activeEndpoints: number } {
  const defer = opts?.deferInWindowReprobe ?? true;
  const dailyChurn = defer
    ? baseline.measuredLast7d / L0_COVERAGE7D_WINDOW_DAYS
    : 0;
  const netPerDay = effectiveNewProbesPerDay - dailyChurn;
  const activeEndpoints = baseline.activeEndpoints;
  const measured = Math.min(
    activeEndpoints,
    baseline.measuredLast7d + netPerDay * Math.max(0, days),
  );
  return { measured, activeEndpoints };
}
