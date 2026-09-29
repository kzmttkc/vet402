// ============================================================
// SpendGuard バックテスト（#9）——「シグナルに従っていたら」を自社845件の
// 実購入履歴に対して機械計算する。
//
// 主張の機械定義（この文がAPIにも同梱される・変えたら別指標）:
//   事前シグナル = 試行時点で (a) 直前2連続の L0 fail（公開failと同じ
//   閾値）または (b) 同一エンドポイントへの先行 settle_failed が存在。
//   avoided = シグナル有り × 非settle（従えば署名しなかった試行。額は署名した額＝賭けた額で、
//             チェーン上の送金は確認されていないので「失った額」ではない・2026-09-29 再監査）
//   forgone = シグナル有り × settled（従えば見送っていた成功）
//
// forgone を必ず併記する。「回避できた額」だけ出せば宣伝であり、
// 両面出せば測定になる——このプロダクトの語法は後者しかない。
// 対象は結果の確定した署名済み試行（BACKTEST_STATUSES）。
// 2026-09-29 敵対的監査 4 周目: 定義文は 4 つの status を挙げながら、SQL は settle_claimed と
// settle_claim_refuted も数えていた（9,067 に settle_claimed 37 件）。settle_claimed は売り手が名指した tx の
// 照合待ちで、結果がまだ無い——avoided（決済しなかった）に数えると照合前の行を「避けられた支出」にしてしまう。
// 計算から外し、settle_claim_refuted（照合で否定された＝決済しなかった）は定義文に書き足す。定義文と SQL は
// 同じ配列から作る。
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

/** バックテストが数える status（結果の確定した署名済み試行）。定義文と SQL の両方がここから作られる。 */
export const BACKTEST_STATUSES = [
  "settled",
  "settle_failed",
  "delivered_no_receipt",
  "settle_claimed_unverifiable",
  "settle_claim_refuted",
] as const;

export const BACKTEST_DEFINITION =
  "prior signal = at attempt time, (a) the two most recent L0 probes of the endpoint were both fail (two consecutive fails — the same threshold the public register uses), or (b) an earlier settle_failed purchase existed on the same endpoint. avoided = signalled attempts that did not settle; forgone = signalled attempts that settled anyway. Denominator: signed attempts whose outcome is settled in the ledger (" +
  BACKTEST_STATUSES.join(" / ") +
  "). settle_claimed rows (the seller named a transaction that vet402 has not yet re-read on-chain) are left out until the re-read turns them into settled or settle_claim_refuted, so a pending row is never counted as avoided. payer_unfunded rows (a settle_failed answered 402 or 5xx on Base between 2026-09-13T00:00Z and 2026-09-15T23:49Z, while vet402's own payer wallet was out of USDC) are neither attempts nor prior signals, since 2026-09-17. spentUnits is the USDC amount vet402 signed on those attempts (what it put at stake), not money shown to have moved: an avoided attempt has no confirmed on-chain transfer, so its spentUnits is exposure that honoring the signal would not have taken, not a loss.";

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
      WHERE pu.status IN (${sql.raw(BACKTEST_STATUSES.map((st) => `'${st}'`).join(", "))})
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
