// coverage7d（公開集計）を上げるための L0 列の定義。分母・分子の式は reader.ts のまま変えない。
import { sql, type SQL } from "drizzle-orm";
import { PRIORITY_REQUEST_TOTAL_MS } from "./reprobe-priority-const";
import { REPROBE_MIN_INTERVAL_MS } from "./l0-rule-change-reprobe";

/** getCoverageShare / state API と同じ 7 日窓。 */
export const L0_COVERAGE7D_WINDOW_DAYS = 7;

/** 窓の内で落ちかけとみなす境界（直近この日数に行が無いが 7 日窓には残っている）。 */
export const L0_COVERAGE7D_RETENTION_GRACE_DAYS = 6;

/** 普通の L0 列の登録ドメインあたり開始間隔（優先の下限と同じ）。 */
export const L0_NORMAL_DOMAIN_INTERVAL_MS = REPROBE_MIN_INTERVAL_MS;

/** Vercel cron（c1）の 1 回あたり既定件数（maxDuration 300・ホスト混在前提）。 */
export const L0_CRON_C1_DEFAULT_LIMIT = 4500;

/** l0-probe ルートの maxDuration（ms）。 */
export const L0_CRON_MAX_DURATION_MS = 300_000;

/** ルート冒頭の verification ドレイン予算（requests.ts の DRAIN_BUDGET_MS と同じ）。 */
export const L0_CRON_DRAIN_BUDGET_MS = 45_000;

/** 打ち切り後も 1 件分は返り切ってから HTTP を返す余白（ms）+ DB 書き込みの見積もり。 */
export const L0_PROBE_ROUTE_TAIL_MS = PRIORITY_REQUEST_TOTAL_MS + 5_000;

/**
 * runL0ProbeBatch の壁時計上限（drain のあと・返却 tail 手前）。
 * 見込み算術の batch 予算もこれに合わせる。
 */
export const L0_PROBE_BATCH_BUDGET_MS =
  L0_CRON_MAX_DURATION_MS - L0_CRON_DRAIN_BUDGET_MS - L0_PROBE_ROUTE_TAIL_MS;

/** 優先段の最悪時間（reprobe-priority-const のコメントと同じ）。 */
export const L0_PROBE_PRIORITY_RESERVE_MS = 55_000;

/** 候補 SELECT（settlement_daily 含む）の見積もり。 */
export const L0_PROBE_CANDIDATE_SELECT_RESERVE_MS = 15_000;

/** 見込み算術で通常列の開始前に差し引く合計（優先と SELECT を別枠）。 */
export const L0_PROBE_RUN_RESERVE_MS =
  L0_PROBE_PRIORITY_RESERVE_MS + L0_PROBE_CANDIDATE_SELECT_RESERVE_MS;

/** 1 件の L0 が返るまでの上限（優先段と同じ。runWithDomainInterval の実効間隔の上限）。 */
export const L0_PROBE_RETURN_MS = PRIORITY_REQUEST_TOTAL_MS;

/**
 * 同一ドメイン同時 1 件の下での 1 レーンあたり開始間隔の見積もり（ms）。
 * max(間隔, 返り上限)。実装もこの上限を使う。
 */
export const L0_PROBE_SCHEDULE_HOLD_MS = L0_PROBE_RETURN_MS;

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

/**
 * 列の先頭キー: 0 = 窓の内で落ちかけ（先に再測定）, 1 = 窓の外（新規）, 2 = 窓の内で余裕（後回し）。
 * lp.last_probed_at は候補 SELECT の LATERAL と並べて使う。
 */
export function l0Coverage7dQueueClassSql(): SQL {
  const in7d = l0ProbedWithinCoverage7dSql("e");
  return sql`CASE
    WHEN ${in7d}
      AND lp.last_probed_at IS NOT NULL
      AND lp.last_probed_at <= now() - make_interval(days => ${L0_COVERAGE7D_RETENTION_GRACE_DAYS})
    THEN 0
    WHEN NOT (${in7d}) THEN 1
    ELSE 2
  END`;
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
  /** 1 レーンの返り見積もり（ms）。既定は L0_PROBE_SCHEDULE_HOLD_MS。 */
  probeScheduleHoldMs?: number;
  batchBudgetMs?: number;
  priorityReserveMs?: number;
  candidateSelectReserveMs?: number;
  /** 候補に含まれる登録ドメイン数。並行数未満のときはレーンが減る。 */
  distinctRegisteredDomains?: number;
};

function runReserveMs(input: L0DailyCapacityInput): number {
  const priority = input.priorityReserveMs ?? L0_PROBE_PRIORITY_RESERVE_MS;
  const select = input.candidateSelectReserveMs ?? L0_PROBE_CANDIDATE_SELECT_RESERVE_MS;
  return priority + select;
}

/**
 * 1 実行で開始しうる L0 件数の上限。
 * 残り予算 / max(間隔, 返り見積もり) を 1 レーンあたりとし、
 * 登録ドメインが concurrency 未満ならレーン数を絞る。
 */
export function l0ProbeStartsPerRunBounds(input: L0DailyCapacityInput): {
  scheduledPerRun: number;
  remainingBudgetMs: number;
  startSpacingMs: number;
  slotsPerLane: number;
  laneCount: number;
  diverseHostStarts: number;
  singleDomainStarts: number;
} {
  const domainIntervalMs = input.domainIntervalMs ?? REPROBE_MIN_INTERVAL_MS;
  const holdMs = input.probeScheduleHoldMs ?? L0_PROBE_SCHEDULE_HOLD_MS;
  const batchBudgetMs = input.batchBudgetMs ?? L0_PROBE_BATCH_BUDGET_MS;
  const remainingBudgetMs = Math.max(0, batchBudgetMs - runReserveMs(input));
  const startSpacingMs = Math.max(domainIntervalMs, holdMs);
  const slotsPerLane = Math.floor(remainingBudgetMs / Math.max(startSpacingMs, 1));
  const scheduledPerRun = Math.max(0, input.limitPerRun - input.priorityCap);
  const laneCount = Math.min(
    Math.max(1, input.concurrency),
    Math.max(1, input.distinctRegisteredDomains ?? input.concurrency),
  );
  const diverseHostStarts = Math.min(scheduledPerRun, slotsPerLane * laneCount);
  const singleDomainStarts = Math.min(scheduledPerRun, slotsPerLane);
  return {
    scheduledPerRun,
    remainingBudgetMs,
    startSpacingMs,
    slotsPerLane,
    laneCount,
    diverseHostStarts,
    singleDomainStarts,
  };
}

/** 1 日に「枠として予約できる」L0 件数（ホスト混在前提の effectivePerRun × cron 回数）。 */
export function l0ProbeEffectiveDailyCapacity(input: L0DailyCapacityInput): {
  scheduledPerRun: number;
  remainingBudgetMs: number;
  startSpacingMs: number;
  slotsPerLane: number;
  laneCount: number;
  diverseHostStarts: number;
  singleDomainStarts: number;
  effectivePerRun: number;
  effectivePerDay: number;
} {
  const bounds = l0ProbeStartsPerRunBounds(input);
  const laneLimited =
    (input.distinctRegisteredDomains ?? input.concurrency) < input.concurrency
      ? bounds.singleDomainStarts
      : bounds.diverseHostStarts;
  const effectivePerRun = laneLimited;
  return {
    ...bounds,
    effectivePerRun,
    effectivePerDay: effectivePerRun * Math.max(0, input.cronL0RunsPerDay),
  };
}

export type ProjectCoverage7dOpts = {
  /** 窓の落ちかけ再測定に先に使う 1 日あたりの件数（既定: min(日あたり落ち, effectivePerDay)）。 */
  retentionProbesPerDay?: number;
};

/**
 * 落ちかけ再測定で起点を維持し、残り枠で窓外の新規 endpoint を積む見込み（単純積み上げ・要確認）。
 * 1 日の開始数が落ちかけ維持に足りないときは、不足分だけ 7 日窓から落ちる前提で分子を下げる。
 */
export function projectCoverage7dMeasured(
  baseline: { activeEndpoints: number; measuredLast7d: number },
  effectiveProbesPerDay: number,
  days: number,
  opts?: ProjectCoverage7dOpts,
): { measured: number; activeEndpoints: number; retentionPerDay: number; outOfWindowPerDay: number; fallOffShortfallPerDay: number } {
  const dailyFallOff = baseline.measuredLast7d / L0_COVERAGE7D_WINDOW_DAYS;
  const retentionPerDay =
    opts?.retentionProbesPerDay ?? Math.min(dailyFallOff, effectiveProbesPerDay);
  const outOfWindowPerDay = Math.max(0, effectiveProbesPerDay - retentionPerDay);
  const fallOffShortfallPerDay = Math.max(0, dailyFallOff - retentionPerDay);
  const activeEndpoints = baseline.activeEndpoints;
  const netPerDay = outOfWindowPerDay - fallOffShortfallPerDay;
  const measured = Math.min(activeEndpoints, baseline.measuredLast7d + netPerDay * Math.max(0, days));
  return { measured, activeEndpoints, retentionPerDay, outOfWindowPerDay, fallOffShortfallPerDay };
}
