// ============================================================
// SpendGuard バックテスト（#9）——「シグナルに従っていたら」を自社845件の
// 実購入履歴に対して機械計算する。
//
// 主張の機械定義（この文がAPIにも同梱される・変えたら別指標）:
//   事前シグナル = 試行時点で (a) 直前2連続の L0 fail（公開failと同じ
//   閾値）または (b) 同一エンドポイントへの先行 settle_failed が存在。
//   avoided = シグナル有り × 非settle（従えば失わなかった支出）
//   forgone = シグナル有り × settled（従えば見送っていた成功）
//
// forgone を必ず併記する。「回避できた額」だけ出せば宣伝であり、
// 両面出せば測定になる——このプロダクトの語法は後者しかない。
// 対象は署名済み試行（settled / settle_failed / delivered_no_receipt /
// settle_claimed_unverifiable）。
// budget_denied / halted / request_error / in_flight は我々側の都合なので母数外。
// 2026-09-17（Issue #29 独立検証）: payer_unfunded（delivery.ts）も母数外で、事前シグナル
// （先行 settle_failed）にも数えない。我々の購入元の USDC が尽きていた期間の行は売り手に
// ついて何も予告せず、その期間の試行はシグナルに関係なく決済し得なかった（avoided の水増し）。
// unsettled_4xx はシグナルに残す: この指標は「従っていたら避けられた支出」の予測で、同じ
// 形の要求が同じ相手にまた決済されないことは予告になる（売り手の帰責を述べる面ではない）。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { notPayerUnfundedPredicate } from "@/lib/observatory/delivery";

export const BACKTEST_DEFINITION =
  "prior signal = at attempt time, (a) the two most recent L0 probes of the endpoint were both fail (two consecutive fails — the same threshold the public register uses), or (b) an earlier settle_failed purchase existed on the same endpoint. avoided = signalled attempts that did not settle; forgone = signalled attempts that settled anyway. Denominator: signed attempts only (settled / settle_failed / delivered_no_receipt / settle_claimed_unverifiable). payer_unfunded rows (a settle_failed answered 402 or 5xx on Base between 2026-09-13T00:00Z and 2026-09-15T23:49Z, while vet402's own payer wallet was out of USDC) are neither attempts nor prior signals, since 2026-09-17.";

export type BacktestResult = {
  attemptsTotal: number;
  avoided: { count: number; spentUnits: string };
  forgone: { count: number; spentUnits: string };
  definition: string;
};

export async function computeSpendGuardBacktest(): Promise<BacktestResult> {
  const db = getDb();
  if (!db) throw new Error("backtest: DATABASE_URL is not configured");
  const raw = await db.execute(sql`
    WITH attempts AS (
      SELECT pu.id, pu.endpoint_id, pu.attempted_at, pu.status,
             coalesce(pu.spent_units, '0')::numeric AS spent,
             (pu.status = 'settled') AS settled,
             EXISTS (
               SELECT 1 FROM x402_l1_purchases prior
               WHERE prior.endpoint_id = pu.endpoint_id
                 AND prior.attempted_at < pu.attempted_at
                 AND prior.status = 'settle_failed'
                 AND ${sql.raw(notPayerUnfundedPredicate("prior"))}
             ) AS prior_fail_purchase,
             (
               SELECT count(*) FILTER (WHERE t.verdict = 'fail') = 2
               FROM (
                 SELECT p.verdict FROM x402_l0_probes p
                 WHERE p.endpoint_id = pu.endpoint_id AND p.probed_at < pu.attempted_at
                 ORDER BY p.probed_at DESC LIMIT 2
               ) t
             ) AS two_consecutive_l0_fails
      FROM x402_l1_purchases pu
      WHERE pu.status IN ('settled', 'settle_failed', 'delivered_no_receipt', 'settle_claimed_unverifiable', 'settle_claimed', 'settle_claim_refuted')
        AND ${sql.raw(notPayerUnfundedPredicate("pu"))}
    )
    SELECT
      count(*)::int AS attempts_total,
      count(*) FILTER (WHERE (prior_fail_purchase OR two_consecutive_l0_fails) AND NOT settled)::int AS avoided_count,
      coalesce(sum(spent) FILTER (WHERE (prior_fail_purchase OR two_consecutive_l0_fails) AND NOT settled), 0)::text AS avoided_units,
      count(*) FILTER (WHERE (prior_fail_purchase OR two_consecutive_l0_fails) AND settled)::int AS forgone_count,
      coalesce(sum(spent) FILTER (WHERE (prior_fail_purchase OR two_consecutive_l0_fails) AND settled), 0)::text AS forgone_units
    FROM attempts
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
    string,
    unknown
  >[];
  const r = rows[0] ?? {};
  const units = (v: unknown) => String(v ?? "0").split(".")[0];
  return {
    attemptsTotal: Number(r.attempts_total ?? 0),
    avoided: { count: Number(r.avoided_count ?? 0), spentUnits: units(r.avoided_units) },
    forgone: { count: Number(r.forgone_count ?? 0), spentUnits: units(r.forgone_units) },
    definition: BACKTEST_DEFINITION,
  };
}
