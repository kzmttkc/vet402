// coverage7d（公開集計）を上げるための L0 列の定義と、7 日後の見込み（下限）。
// 分母・分子の式は reader.ts の getCoverageShare のまま変えない。変えるのは L0 の確認の量と順番だけ。
//
// 2026-11-10（c36.rr3 の指摘を閉じる形）:
//   - 1 件がレーンを占める最悪の時間 = 要求の上限（10.5 秒）＋行の DB の予算（1.5 秒）= 12 秒。
//     ランナーはこの時間でレーンを空ける（runWithDomainInterval の laneHoldMaxMs）。ドメインは要求が終わるまで離さない。
//   - 期限はルートの開始から数える。drain・優先の選定・優先の段・候補 SELECT は上限で打ち切る。
//     各段の上限 + 普通の列の窓 + 最後の書き込みの余白 + 返却の余白 = maxDuration 300 秒。
//   - 量: drain と優先つきの l0-probe（10:30 UTC・従来どおり）に加え、窓の外を先に測る coverage の回を 1 日 6 本。
//   - 順番: 窓の内の更新を 1 回 L0_COVERAGE7D_IN_WINDOW_PER_RUN 件まで先に（切らさない）、残りは窓の外。
//   - 見込み: 窓の外の行は 7 日の間に同じ出品を 2 度数えない（2 度目は窓の内になる）。7 日後の分子 ≥ 7 日間に
//     書いた窓の外の行の数。起点 28,822 の残りを当てにしない下限。
import { sql, type SQL } from "drizzle-orm";
import { PRIORITY_REQUEST_TOTAL_MS } from "./reprobe-priority-const";
import { REPROBE_MIN_INTERVAL_MS } from "./l0-rule-change-reprobe";
import { pct1 } from "@/lib/util/pct";

/** getCoverageShare / state API と同じ 7 日窓。 */
export const L0_COVERAGE7D_WINDOW_DAYS = 7;

/** 1 回の実行で、窓の内（直近 7 日に行がある）出品を先に測り直す上限。残りの枠は窓の外へ。 */
export const L0_COVERAGE7D_IN_WINDOW_PER_RUN = 100;

/** 普通の L0 列の登録ドメインあたり開始間隔（優先の下限と同じ）。 */
export const L0_NORMAL_DOMAIN_INTERVAL_MS = REPROBE_MIN_INTERVAL_MS;

/** Vercel cron（c1・l0-probe）の 1 回あたり既定件数。 */
export const L0_CRON_C1_DEFAULT_LIMIT = 4500;
/** coverage の回（l0-coverage）の 1 回あたり件数。 */
export const L0_COVERAGE_RUN_LIMIT = 4500;
/** cron の回の並行（レーン数）。同じ登録ドメインは同時 1 件なので、別ドメインがこの数まで同時に走る。 */
export const L0_CRON_CONCURRENCY = 40;

/** l0-probe / l0-coverage ルートの maxDuration（ms）。 */
export const L0_CRON_MAX_DURATION_MS = 300_000;
/** ランナーが返ってから HTTP を返し切るまでの余白。 */
export const L0_ROUTE_RETURN_SAFETY_MS = 5_000;
/**
 * drain（公開の再検証キュー）に待つ上限。drainVerificationRequests の予算 45 秒のあと、最後の 1 件の
 * INSERT と status 更新を待つ分を足す。超えたらルートは待たずに先へ進む（残りは pending のまま次の回）。
 */
export const L0_CRON_DRAIN_CAP_MS = 50_000;
/** 優先の候補 SELECT（頁読み・登録ドメインの頭打ち）に待つ上限。超えたら優先の段は飛ばす。 */
export const L0_PROBE_PRIORITY_SELECT_CAP_MS = 10_000;
/** 優先の段（最大 50 件・1 登録ドメイン 5 件）が返り切る上限。新しい開始はこの線から 1 件分の保持を引いた所で止める。 */
export const L0_PROBE_PRIORITY_STAGE_MS = 55_000;
/** 普通の列の候補 SELECT に待つ上限。頁の間でも見て、超えたらそこまでの候補で走る。 */
export const L0_PROBE_CANDIDATE_SELECT_CAP_MS = 15_000;
/** 普通の列のレーンが全部空いたあと、レーンの上限を越えた行の書き込みを待つ余白。 */
export const L0_PROBE_SETTLE_TAIL_MS = 10_000;

/** 1 件の要求の上限（本文まで・優先の段と同じ）。超えた要求は行を書かない（分子に入らない）。 */
export const L0_PROBE_REQUEST_LIMIT_MS = PRIORITY_REQUEST_TOTAL_MS;
/** 1 件の DB の予算: 出品のリース取得・直近 SELECT・INSERT・リース解放。 */
export const L0_PROBE_DB_BUDGET_MS = 1_500;
/** 1 件がレーンを占める上限（見込みの保持と同じ値をランナーが使う）。 */
export const L0_PROBE_LANE_HOLD_MS = L0_PROBE_REQUEST_LIMIT_MS + L0_PROBE_DB_BUDGET_MS;

/** 期限を渡さずに runL0ProbeBatch を呼んだときの全体の上限（手動・テスト）。 */
export const L0_PROBE_BATCH_BUDGET_MS = L0_CRON_MAX_DURATION_MS - L0_ROUTE_RETURN_SAFETY_MS;

/** pct1 で 22.4% を超えるのに要る分子（分母 131,995・2026-11-09）。 */
export const COVERAGE7D_MEASURED_PCT_TARGET = 22.4;
export const COVERAGE7D_MEASURED_COUNT_TARGET = 29_633;

/** 2026-11-09 公開値（オーナー報告）。 */
export const COVERAGE7D_BASELINE_2026_11_09 = {
  activeEndpoints: 131_995,
  measuredLast7d: 28_822,
  pct: 21.8,
} as const;

/**
 * 窓の外の出品の数の下限（2026-11-10 公開 state の publishedPassActiveProbeOlderThan7d）。
 * active で公開 pass、最新の L0 が 7 日より前 = テンプレートでなく、窓の外にある出品。
 * 未測定・fail・unverified の窓の外はここに入らないので、本当の母集団はこれより大きい。
 */
export const COVERAGE7D_OUT_OF_WINDOW_POOL_FLOOR_2026_11_10 = 56_197;

/** 直近 7 日に L0 行があるか（reader.ts の分子と同じ述語・endpoint エイリアスは既定 e）。 */
export function l0ProbedWithinCoverage7dSql(endpointAlias = "e"): SQL {
  return sql`EXISTS (
    SELECT 1 FROM x402_l0_probes p
    WHERE p.endpoint_id = ${sql.raw(endpointAlias)}.id
      AND p.probed_at > now() - interval '7 days'
  )`;
}

/**
 * 候補 SELECT の LATERAL（lp.last_probed_at = max(probed_at)）で見た「窓の内」。
 * max(probed_at) > now() - 7 days ⇔ 7 日以内の行が存在する（上の EXISTS と同じ集合）。未測定（NULL）は窓の外。
 */
export function l0InCoverage7dLpSql(): SQL {
  return sql`COALESCE(lp.last_probed_at > now() - interval '7 days', false)`;
}

/**
 * 列の先頭キー:
 *   0 = 窓の内の更新（旧規則の公開 fail → 1 回だけの fail → 古い順に、1 回 L0_COVERAGE7D_IN_WINDOW_PER_RUN 件まで）
 *   1 = 窓の外（分子を増やす）
 *   2 = 窓の内の残り（次の回へ）
 * 窓関数の中に窓関数は入れられないので、更新の順位は lp の列だけで並べる。
 */
export function l0Coverage7dQueueClassSql(): SQL {
  const inWindow = l0InCoverage7dLpSql();
  const refreshRank = sql`row_number() OVER (PARTITION BY ${inWindow} ORDER BY lp.rule_change_reprobe DESC NULLS LAST, (lp.probe_count = 1 AND lp.last_verdict = 'fail') DESC NULLS LAST, lp.last_probed_at ASC NULLS FIRST, e.id ASC)`;
  return sql`CASE WHEN ${inWindow} AND ${refreshRank} <= ${L0_COVERAGE7D_IN_WINDOW_PER_RUN} THEN 0 WHEN NOT ${inWindow} THEN 1 ELSE 2 END`;
}

export type L0RunMode = "full" | "coverage";

/** ルートの開始時刻から、ランナーが返り切る期限（ms epoch）。 */
export function l0RunDeadlineAt(routeStartedAt: number): number {
  return routeStartedAt + L0_CRON_MAX_DURATION_MS - L0_ROUTE_RETURN_SAFETY_MS;
}

/**
 * 普通の列のレーンが走れる最悪の窓（ms）。前の段が全部上限まで使った場合。
 *   full     = 300 − 返却 − 書き込みの余白 − 候補 SELECT − drain − 優先の選定 − 優先の段
 *   coverage = 300 − 返却 − 書き込みの余白 − 候補 SELECT（drain と優先の段は無い）
 */
export function l0NormalLaneWindowMs(mode: L0RunMode): number {
  const base = L0_CRON_MAX_DURATION_MS - L0_ROUTE_RETURN_SAFETY_MS - L0_PROBE_SETTLE_TAIL_MS - L0_PROBE_CANDIDATE_SELECT_CAP_MS;
  if (mode === "coverage") return base;
  return base - L0_CRON_DRAIN_CAP_MS - L0_PROBE_PRIORITY_SELECT_CAP_MS - L0_PROBE_PRIORITY_STAGE_MS;
}

/**
 * 1 レーンが窓の中で始めて返し切れる件数 = floor(窓 / max(保持, 間隔))。
 * 開始は 0, H, 2H, … で、最後の開始 + H ≤ 窓（ランナーは laneEnd − 保持 を過ぎたら始めない）。
 */
export function l0SlotsPerLane(
  windowMs: number,
  laneHoldMs: number = L0_PROBE_LANE_HOLD_MS,
  intervalMs: number = L0_NORMAL_DOMAIN_INTERVAL_MS,
): number {
  return Math.max(0, Math.floor(windowMs / Math.max(laneHoldMs, intervalMs, 1)));
}

/** 普通の列の 1 登録ドメインあたりの件数（ランナーの fillPriorityByDomain と同じ）。 */
export function l0PerDomainCap(restLimit: number, lanes: number): number {
  return Math.max(1, Math.ceil(restLimit / Math.max(1, lanes)));
}

/**
 * 全件が保持 H を占める最悪の場合の、1 回の開始数と、ドメインごとの消費。
 * 同じドメインは同時 1 件なので、slots 回の各回で、残りの多いドメインから lanes 個を 1 件ずつ取る
 * （runWithDomainInterval の preferLongestDomainQueue と同じ取り方）。
 * 結果は min(lanes × slots, Σ min(n_d, slots))。
 */
export function l0WorstCaseStartsPerRun(
  listDomainSizes: readonly number[],
  lanes: number,
  slots: number,
): { starts: number; consumed: number[] } {
  const rem = listDomainSizes.map((n) => Math.max(0, Math.trunc(n)));
  const consumed = rem.map(() => 0);
  let starts = 0;
  const laneCount = Math.max(1, Math.trunc(lanes));
  for (let round = 0; round < slots; round++) {
    const alive = rem.map((n, i) => [n, i] as const).filter(([n]) => n > 0);
    if (alive.length === 0) break;
    alive.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
    for (const [, i] of alive.slice(0, laneCount)) {
      rem[i]!--;
      consumed[i]!++;
      starts++;
    }
  }
  return { starts, consumed };
}

/**
 * 母集団（ドメインごとの件数）から、1 回の候補の並びが取る件数。SQL はホストごとの順位で交互に並べ
 * （hostSpread）、ランナーは 1 登録ドメイン perDomainCap 件で頭打ちにする。水位を揃えて limit 件まで取る形で近似する。
 */
export function l0CandidateListBySpread(poolDomainSizes: readonly number[], limit: number, perDomainCap: number): number[] {
  const cap = Math.max(0, Math.trunc(perDomainCap));
  const total = (level: number) => poolDomainSizes.reduce((a, n) => a + Math.min(n, level), 0);
  let lo = 0;
  let hi = cap;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (total(mid) <= limit) lo = mid;
    else hi = mid - 1;
  }
  const list = poolDomainSizes.map((n) => Math.min(n, lo));
  let left = limit - list.reduce((a, b) => a + b, 0);
  const order = poolDomainSizes.map((n, i) => [n, i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [n, i] of order) {
    if (left <= 0) break;
    if (list[i]! < Math.min(n, cap)) {
      list[i]!++;
      left--;
    }
  }
  return list;
}

/** 標本の [件数, ドメイン数] を、全体 targetTotal 件の母集団へ同じ形で引き伸ばす（切り捨て）。 */
export function poolFromDomainSample(sizeToDomains: readonly (readonly [number, number])[], targetTotal: number): number[] {
  const sampleTotal = sizeToDomains.reduce((a, [size, count]) => a + size * count, 0);
  if (sampleTotal <= 0) return [];
  const factor = targetTotal / sampleTotal;
  const out: number[] = [];
  for (const [size, count] of sizeToDomains) {
    const scaled = Math.floor(size * factor);
    for (let i = 0; i < count; i++) out.push(scaled);
  }
  return out;
}

export type Coverage7dProjectionInput = {
  /** 1 日の回（l0CronRunModesPerDay）。 */
  runModes: readonly L0RunMode[];
  /** full の回（c1）の窓の外も下限に数えるか。c1 の母集団の大きさを DB で確かめていないので既定は数えない。 */
  countFullRuns: boolean;
  lanes: number;
  laneHoldMs: number;
  intervalMs?: number;
  /** 1 回の候補の件数（窓の内の更新を含む）。 */
  listLimit: number;
  /** 1 回の窓の内の更新の上限。最悪はこの件数がレーンを先に使う。 */
  inWindowQuota: number;
  /** 窓の外の母集団の、登録ドメインごとの件数（前提）。 */
  poolDomainSizes: readonly number[];
  days: number;
  /** 要求が上限を超えて行を書かない割合（0〜1）。 */
  abandonRate?: number;
};

export type Coverage7dProjection = {
  measuredLowerBound: number;
  perRun: { mode: L0RunMode; windowMs: number; slotsPerLane: number; starts: number; outOfWindowStarts: number }[];
  perDay: number[];
  poolLeft: number;
};

/**
 * 7 日後の分子の下限。各回、最悪の保持で始められる数から窓の内の更新を引いた分を、窓の外の行として数える。
 * 窓の外の行は 7 日の間に同じ出品で 2 度は起きない（2 度目の時点では 1 度目が窓の内）。だから 7 日後の分子 ≥ その和。
 * 起点の 28,822 の残り・c2（launchd）・優先の段・drain の行は数えない（足されるだけ）。
 * 測った出品は 7 日の間は窓の内なので、母集団から引いたまま戻さない（窓から落ちて戻る分も数えない）。
 */
export function projectCoverage7dLowerBound(input: Coverage7dProjectionInput): Coverage7dProjection {
  const pool = input.poolDomainSizes.map((n) => Math.max(0, Math.trunc(n)));
  const abandon = Math.min(1, Math.max(0, input.abandonRate ?? 0));
  const perDomainCap = l0PerDomainCap(input.listLimit, input.lanes);
  const perRun: Coverage7dProjection["perRun"] = [];
  const perDay: number[] = [];
  let counted = 0;
  for (let day = 0; day < Math.max(0, input.days); day++) {
    let dayCount = 0;
    for (const mode of input.runModes) {
      const windowMs = l0NormalLaneWindowMs(mode);
      const slotsPerLane = l0SlotsPerLane(windowMs, input.laneHoldMs, input.intervalMs ?? L0_NORMAL_DOMAIN_INTERVAL_MS);
      if (mode === "full" && !input.countFullRuns) {
        if (day === 0) perRun.push({ mode, windowMs, slotsPerLane, starts: 0, outOfWindowStarts: 0 });
        continue;
      }
      const list = l0CandidateListBySpread(pool, Math.max(0, input.listLimit - input.inWindowQuota), perDomainCap);
      const { starts, consumed } = l0WorstCaseStartsPerRun(list, input.lanes, slotsPerLane);
      const outOfWindowStarts = Math.max(0, starts - input.inWindowQuota);
      for (let i = 0; i < pool.length; i++) pool[i]! -= consumed[i]!;
      const rows = Math.floor(outOfWindowStarts * (1 - abandon));
      dayCount += rows;
      if (day === 0) perRun.push({ mode, windowMs, slotsPerLane, starts, outOfWindowStarts });
    }
    perDay.push(dayCount);
    counted += dayCount;
  }
  return { measuredLowerBound: counted, perRun, perDay, poolLeft: pool.reduce((a, b) => a + b, 0) };
}

/** 公開の pct1 が 22.4 を超えるか（分母は渡した値）。 */
export function coverage7dMeetsTarget(measured: number, activeEndpoints: number): boolean {
  const pct = pct1(measured, activeEndpoints);
  return pct !== null && pct > COVERAGE7D_MEASURED_PCT_TARGET;
}
