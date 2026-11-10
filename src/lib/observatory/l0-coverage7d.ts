// coverage7d（公開集計）を上げるための L0 列の定義。分母・分子の式は reader.ts のまま変えない。
import { sql, type SQL } from "drizzle-orm";
import { REPROBE_MIN_INTERVAL_MS } from "./l0-rule-change-reprobe";

/** getCoverageShare / state API と同じ 7 日窓。 */
export const L0_COVERAGE7D_WINDOW_DAYS = 7;

/** 普通の L0 列の登録ドメインあたり開始間隔（優先の下限と同じ）。 */
export const L0_NORMAL_DOMAIN_INTERVAL_MS = REPROBE_MIN_INTERVAL_MS;

/** Vercel cron（c1）の 1 回あたり既定件数（maxDuration 300・並行 40・1 秒間隔の上限内）。 */
export const L0_CRON_C1_DEFAULT_LIMIT = 4500;

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
 * 1 日に「枠として予約できる」L0 件数と、ホスト間隔＋maxDuration で詰まる上限の小さい方。
 * 実プローブ成功率・SSRF 飛ばし・リース衝突は含めない（要確認）。
 */
export function l0ProbeEffectiveDailyCapacity(input: L0DailyCapacityInput): {
  scheduledPerRun: number;
  timeBoundPerRun: number;
  effectivePerRun: number;
  effectivePerDay: number;
} {
  const domainIntervalMs = input.domainIntervalMs ?? REPROBE_MIN_INTERVAL_MS;
  const scheduledPerRun = Math.max(0, input.limitPerRun - input.priorityCap);
  const slots = Math.floor((input.maxDurationSec * 1000) / Math.max(domainIntervalMs, 1));
  const timeBoundPerRun = slots * Math.max(1, input.concurrency);
  const effectivePerRun = Math.min(scheduledPerRun, timeBoundPerRun);
  return {
    scheduledPerRun,
    timeBoundPerRun,
    effectivePerRun,
    effectivePerDay: effectivePerRun * Math.max(0, input.cronL0RunsPerDay),
  };
}

/**
 * 窓外優先で有効新規が概ね effectivePerDay 件/日増えると仮定した単純積み上げ（7 日窓の落ちは未モデル・要確認）。
 */
export function projectCoverage7dMeasured(
  baseline: { activeEndpoints: number; measuredLast7d: number },
  effectiveNewProbesPerDay: number,
  days: number,
): { measured: number; activeEndpoints: number } {
  const activeEndpoints = baseline.activeEndpoints;
  const measured = Math.min(
    activeEndpoints,
    baseline.measuredLast7d + effectiveNewProbesPerDay * Math.max(0, days),
  );
  return { measured, activeEndpoints };
}
