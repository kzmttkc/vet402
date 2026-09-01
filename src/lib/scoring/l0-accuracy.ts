// ============================================================
// §12 品質 SLO — 測定機関の品質は、対象店の品質ではない。自社の測定がどれだけ
// 正しいかである。ここでは L0 の誤 pass / 誤 fail と鮮度・逆引き遅延・証拠完備率を出す。
//
//   L0 誤 fail 率 = 公開 fail のうち、7 日以内の再測定（再プローブ・異議）で pass に覆った割合   目標 < 3%
//   L0 誤 pass 率 = 公開 pass のうち、次回プローブが no_402（200 で本編を返した等）だった割合    目標 < 2%
//
// 標本が min_sample 未満なら率は null（ノイズから率を出さない——/accuracy と同じ規律）。
// 出せない週はリリース凍結（§12）。数字が無いことも数字として出す。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { rowsOf } from "@/lib/settlements/upsert";

export const L0_FALSE_FAIL_TARGET_PCT = 3;
export const L0_FALSE_PASS_TARGET_PCT = 2;
export const L0_MIN_SAMPLE = 10;

export type L0AccuracyInput = {
  publishedFail: number;
  failFlippedToPassWithin7d: number;
  publishedPass: number;
  passFollowedByNo402: number;
  minSample?: number;
};

export type L0Accuracy = {
  window_days: 7;
  published_fail: number;
  false_fail: number;
  false_fail_rate: number | null;
  published_pass: number;
  false_pass: number;
  false_pass_rate: number | null;
  min_sample: number;
  slo: {
    false_fail_target_pct: number;
    false_pass_target_pct: number;
    false_fail_ok: boolean | null;
    false_pass_ok: boolean | null;
  };
};

const pct = (num: number, den: number, min: number): number | null =>
  den < min ? null : Math.round((num / den) * 1000) / 10;

export function computeL0Accuracy(input: L0AccuracyInput): L0Accuracy {
  const min = input.minSample ?? L0_MIN_SAMPLE;
  const ff = pct(input.failFlippedToPassWithin7d, input.publishedFail, min);
  const fp = pct(input.passFollowedByNo402, input.publishedPass, min);
  return {
    window_days: 7,
    published_fail: input.publishedFail,
    false_fail: input.failFlippedToPassWithin7d,
    false_fail_rate: ff,
    published_pass: input.publishedPass,
    false_pass: input.passFollowedByNo402,
    false_pass_rate: fp,
    min_sample: min,
    slo: {
      false_fail_target_pct: L0_FALSE_FAIL_TARGET_PCT,
      false_pass_target_pct: L0_FALSE_PASS_TARGET_PCT,
      false_fail_ok: ff === null ? null : ff < L0_FALSE_FAIL_TARGET_PCT,
      false_pass_ok: fp === null ? null : fp < L0_FALSE_PASS_TARGET_PCT,
    },
  };
}

/**
 * 直近 7 日のプローブ列から誤 pass / 誤 fail の材料を数える。
 *   公開 fail  = ある時点で 2 連続 fail になった endpoint（その 2 件目の probe）
 *   誤 fail    = その後 7 日以内に pass が来た
 *   公開 pass  = pass の probe
 *   誤 pass    = 直後の probe が fail:no_402（200 で本編を返した・401/403）
 */
export async function fetchL0AccuracyInput(): Promise<L0AccuracyInput> {
  const db = getDb();
  if (!db) return { publishedFail: 0, failFlippedToPassWithin7d: 0, publishedPass: 0, passFollowedByNo402: 0 };
  const rows = rowsOf<{ published_fail: number; false_fail: number; published_pass: number; false_pass: number }>(
    await db.execute(sql`
      WITH seq AS (
        SELECT endpoint_id, probed_at, verdict, fail_reason,
               lag(verdict) OVER (PARTITION BY endpoint_id ORDER BY probed_at) AS prev_verdict,
               lead(verdict) OVER (PARTITION BY endpoint_id ORDER BY probed_at) AS next_verdict,
               lead(fail_reason) OVER (PARTITION BY endpoint_id ORDER BY probed_at) AS next_reason,
               lead(probed_at) OVER (PARTITION BY endpoint_id ORDER BY probed_at) AS next_at
        FROM x402_l0_probes
        WHERE probed_at > now() - interval '14 days'
      ),
      pf AS (
        SELECT endpoint_id, probed_at FROM seq
        WHERE verdict = 'fail' AND prev_verdict = 'fail' AND probed_at > now() - interval '7 days'
      ),
      ff AS (
        SELECT count(*)::int AS n FROM pf
        WHERE EXISTS (
          SELECT 1 FROM x402_l0_probes p WHERE p.endpoint_id = pf.endpoint_id
            AND p.probed_at > pf.probed_at AND p.probed_at <= pf.probed_at + interval '7 days' AND p.verdict = 'pass')
      ),
      pp AS (
        SELECT count(*)::int AS published_pass,
               count(*) FILTER (WHERE next_verdict = 'fail' AND next_reason = 'no_402')::int AS false_pass
        FROM seq WHERE verdict = 'pass' AND probed_at > now() - interval '7 days' AND next_at IS NOT NULL
      )
      SELECT (SELECT count(*)::int FROM pf) AS published_fail, (SELECT n FROM ff) AS false_fail,
             pp.published_pass, pp.false_pass
      FROM pp
    `),
  );
  const r = rows[0];
  return {
    publishedFail: Number(r?.published_fail ?? 0),
    failFlippedToPassWithin7d: Number(r?.false_fail ?? 0),
    publishedPass: Number(r?.published_pass ?? 0),
    passFollowedByNo402: Number(r?.false_pass ?? 0),
  };
}

export type SloSnapshot = {
  l1_probe_error_rate_pct: number | null;
  c1_l0_within_36h_pct: number | null;
  c2_l1_within_48h_pct: number | null;
  reverse_lookup_confirmed_within_60s_pct: number | null;
  published_failure_evidence_complete_pct: number | null;
  unmeasured: string[];
  targets: {
    l1_probe_error_rate_pct: number;
    c1_l0_within_36h_pct: number;
    c2_l1_within_48h_pct: number;
    reverse_lookup_confirmed_within_60s_pct: number;
    published_failure_evidence_complete_pct: number;
    decision_p95_ms_cache_hit: number;
    decision_availability_monthly_pct: number;
  };
};

export async function fetchSloSnapshot(): Promise<SloSnapshot> {
  const targets = {
    l1_probe_error_rate_pct: 5,
    c1_l0_within_36h_pct: 100,
    c2_l1_within_48h_pct: 100,
    reverse_lookup_confirmed_within_60s_pct: 100,
    published_failure_evidence_complete_pct: 100,
    decision_p95_ms_cache_hit: 200,
    decision_availability_monthly_pct: 99.9,
  };
  const db = getDb();
  const unmeasured: string[] = [];
  if (!db) {
    return {
      l1_probe_error_rate_pct: null,
      c1_l0_within_36h_pct: null,
      c2_l1_within_48h_pct: null,
      reverse_lookup_confirmed_within_60s_pct: null,
      published_failure_evidence_complete_pct: null,
      unmeasured: ["db"],
      targets,
    };
  }
  const r = rowsOf<Record<string, number | null>>(
    await db.execute(sql`
      SELECT
        -- L1 の社側失敗率: request_error / budget_denied / in_flight 残骸を試行数で割る（7 日）
        (SELECT CASE WHEN count(*) < 10 THEN NULL ELSE
           round(100.0 * count(*) FILTER (WHERE status IN ('request_error', 'in_flight')) / count(*), 1) END
         FROM x402_l1_purchases WHERE attempted_at > now() - interval '7 days') AS l1_err,
        -- C1 の L0 鮮度: 30 日以内に listed/決済のある active のうち 36h 以内に測った割合
        (SELECT CASE WHEN count(*) = 0 THEN NULL ELSE
           round(100.0 * count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM x402_l0_probes p WHERE p.endpoint_id = e.id AND p.probed_at > now() - interval '36 hours')) / count(*), 1) END
         FROM x402_endpoints e WHERE e.status = 'active' AND e.last_seen_at > now() - interval '30 days') AS c1_fresh,
        -- C2 の L1 鮮度: 決済帰属のある endpoint のうち 48h 以内に L1 を試みた割合
        (SELECT CASE WHEN count(*) = 0 THEN NULL ELSE
           round(100.0 * count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM x402_l1_purchases pu WHERE pu.endpoint_id = c.endpoint_id AND pu.attempted_at > now() - interval '48 hours')) / count(*), 1) END
         FROM (SELECT DISTINCT endpoint_id FROM settlements WHERE endpoint_id IS NOT NULL
               AND attribution IN ('confirmed','probable') AND coalesce(block_time, observed_at) > now() - interval '30 days') c) AS c2_fresh,
        -- 逆引き遅延: L1 由来の confirmed が照合確定から 60 秒以内に索引へ載った割合
        (SELECT CASE WHEN count(*) < 10 THEN NULL ELSE
           round(100.0 * count(*) FILTER (WHERE s.observed_at <= pu.settlement_verified_at + interval '60 seconds') / count(*), 1) END
         FROM settlements s JOIN x402_l1_purchases pu ON pu.tx_hash = s.tx_hash
         WHERE s.source = 'l1_purchase' AND pu.settlement_verified_at IS NOT NULL AND pu.settlement_verified_at > now() - interval '7 days') AS rl_fast,
        -- 公開失敗の証拠完備率: 公開 fail（2 連続）のうち resource_id・canonical_url・client が揃う割合
        (SELECT CASE WHEN count(*) = 0 THEN NULL ELSE
           round(100.0 * count(*) FILTER (WHERE e.resource_id IS NOT NULL AND e.canonical_url IS NOT NULL AND p.raw_response_meta ? 'client') / count(*), 1) END
         FROM x402_l0_probes p JOIN x402_endpoints e ON e.id = p.endpoint_id
         WHERE p.verdict = 'fail' AND p.probed_at > now() - interval '7 days') AS evid
    `),
  )[0] ?? {};
  const num = (k: string) => (r[k] === null || r[k] === undefined ? null : Number(r[k]));
  const out: SloSnapshot = {
    l1_probe_error_rate_pct: num("l1_err"),
    c1_l0_within_36h_pct: num("c1_fresh"),
    c2_l1_within_48h_pct: num("c2_fresh"),
    reverse_lookup_confirmed_within_60s_pct: num("rl_fast"),
    published_failure_evidence_complete_pct: num("evid"),
    unmeasured,
    targets,
  };
  for (const k of ["l1_probe_error_rate_pct", "c1_l0_within_36h_pct", "c2_l1_within_48h_pct", "reverse_lookup_confirmed_within_60s_pct", "published_failure_evidence_complete_pct"] as const) {
    if (out[k] === null) unmeasured.push(k);
  }
  // 判定 API の p95 / 可用性は外部監視（uptime cron・/health）の領分。ここでは目標だけを示す。
  unmeasured.push("decision_p95_ms_cache_hit", "decision_availability_monthly_pct");
  return out;
}
