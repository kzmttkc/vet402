// ============================================================
// 決済主張の照合ジョブ（2026-08-23 監査 C-4 の本丸）。
//
// **`settled` を名乗らせる唯一の場所。** 購入時のランナーは `settle_claimed`
// までしか書かない。ここがチェーンを読み、確認できたものだけを `settled` に
// 昇格させ、確認できなかったものは `settle_claim_refuted` にする。
//
// なぜランナーと分けるか: 確定数を待つ必要がある。購入直後に読むと未確定の
// tx を「確認済み」と刻む事故になり、待てばバッチのデッドラインを食い潰す。
// 照合を日次 cron に置けば、実際の確定数は数千〜数万になり、確定数の要求は
// タダで買える（本番実測 2026-08-23: 約87,000）。
//
// スコア証拠（observed_purchases）を書くのもここだけ。以前はランナーが
// 購入直後に書いていたが、その時点の `settled` は売り手の自己申告だった。
// 「実購入がスコアに効く」という主張は、この照合が通って初めて成立する。
// ============================================================
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { x402L1Purchases } from "@/lib/db/schema";
import { recordObservedPurchase } from "@/lib/db/observed-purchases";
import { logAndSwallow, logServerError } from "@/lib/util/log";
import { invalidateDecisionCache } from "@/lib/decision/cache";
import { createDeadline } from "@/lib/util/deadline";
import { verifyL1Settlement } from "./settlement-verify";
import { isDeliveryVerified } from "./l1-runner";
import { ingestL1 } from "@/lib/settlements/ingest-l1";
import { recordCorrection } from "./corrections";

/**
 * 一時的な失敗（RPCが答えない・確定数が足りない・まだ見つからない）は
 * 「否定」ではない。次回の cron で見直せるよう status を倒さず、理由だけ残す。
 * 恒久的な否定（レシートが revert・期待した Transfer が無い・別チェーン）は
 * 売り手についての所見なので settle_claim_refuted へ確定させる。
 */
const TRANSIENT_REASONS = new Set([
  "rpc_unavailable",
  "tx_not_found",
  "insufficient_confirmations",
  "chain_not_yet_verifiable",
]);

export type VerifySettlementsSummary = {
  scanned: number;
  verified: number;
  refuted: number;
  deferred: number;
  evidenceWritten: number;
  deadlineHit: boolean;
};

export async function runSettlementVerification(options?: {
  limit?: number;
  budgetMs?: number;
}): Promise<VerifySettlementsSummary> {
  const limit = options?.limit ?? 200;
  const deadline = createDeadline(options?.budgetMs ?? 240_000);
  const summary: VerifySettlementsSummary = {
    scanned: 0,
    verified: 0,
    refuted: 0,
    deferred: 0,
    evidenceWritten: 0,
    deadlineHit: false,
  };
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");

  // 対象: 決済を主張していて、まだ照合が確定していない行。
  // 既存の 'settled'（2026-08-23 より前に、照合前の意味で書かれたもの）も
  // settlement_verified IS NULL なので同じ経路で見に行く。
  const raw = await db.execute(sql`
    SELECT pu.id::text AS id, pu.tx_hash, pu.network, pu.pay_to, pu.payer,
           pu.amount_units, pu.http_status_paid, pu.payload_non_empty, pu.l2_schema,
           pu.status, pu.endpoint_id::text AS endpoint_id, e.resource_url
    FROM x402_l1_purchases pu
    LEFT JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE pu.settlement_verified IS NULL
      AND pu.tx_hash IS NOT NULL
      AND pu.status IN ('settle_claimed', 'settled')
    ORDER BY pu.attempted_at ASC
    LIMIT ${limit}
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as {
    id: string;
    tx_hash: string;
    network: string;
    pay_to: string | null;
    payer: string | null;
    amount_units: string | null;
    http_status_paid: number | null;
    payload_non_empty: boolean | null;
    l2_schema: string | null;
    status: string;
    endpoint_id: string;
    resource_url: string | null;
  }[];

  for (const row of rows) {
    // 1件あたり最大 ~6s（RPC 3往復 + 予備）。残りが足りなければ次回へ回す。
    if (deadline.remaining() < 8_000) {
      summary.deadlineHit = true;
      break;
    }
    summary.scanned++;

    if (!row.pay_to || !row.payer || !row.amount_units) {
      // 期待値が台帳に無い＝我々が何を期待したか言えない。照合できないので
      // 触らず、理由だけ残す（推測で期待値を作らない）。
      await db
        .update(x402L1Purchases)
        .set({ settlementVerifyReason: "expected_values_missing" })
        .where(eq(x402L1Purchases.id, row.id));
      summary.deferred++;
      continue;
    }

    const result = await verifyL1Settlement({
      txHash: row.tx_hash,
      network: row.network,
      expectedPayTo: row.pay_to,
      expectedPayer: row.payer,
      expectedAmountUnits: row.amount_units,
    });

    if (result.ok) {
      await db
        .update(x402L1Purchases)
        .set({
          status: "settled",
          settlementVerified: true,
          settlementVerifiedAt: new Date(),
          settlementVerifyReason: null,
          settlementBlockNumber: result.blockNumber,
        })
        .where(eq(x402L1Purchases.id, row.id));
      summary.verified++;
      invalidateDecisionCache(row.endpoint_id); // settled は判定材料（このインスタンスのみ・cache.ts 参照）
      // §10 / §6.2: バックフィルで確定した状態変化は訂正ログに残す。
      await recordCorrection({
        subjectType: "purchase",
        subjectId: row.id,
        level: "l1",
        before: { status: row.status },
        after: { status: "settled", blockNumber: String(result.blockNumber) },
        reason: "settlement_backfill",
      }).catch(logAndSwallow("settlement-verifier.record_correction.settled"));

      // §7.3（2026-09-02）: 確定した購入は決済索引へ即時に載せ、受取先→Endpoint の
      // 逆引きが cron を待たずに更新される（実装完了の定義「1 分以内」）。
      // 索引の失敗は照合の成否を変えない——次回の日次 ingestL1 が拾う。
      try {
        await ingestL1({ onlyPurchaseRowId: row.id });
      } catch (error) {
        logServerError("settlement-verifier.ingest-l1", error);
      }

      // スコア証拠はここでだけ書く。delivery_verified の規則はランナーと共有。
      try {
        const created = await recordObservedPurchase({
          wallet: row.payer,
          counterparty: row.pay_to,
          amount: row.amount_units,
          txHash: row.tx_hash,
          resource: row.resource_url,
          blockTimestamp: result.blockTimestamp,
          deliveryVerified: isDeliveryVerified({
            httpStatusPaid: row.http_status_paid,
            payloadNonEmpty: row.payload_non_empty === true,
            l2Schema: row.l2_schema ?? "no_declaration",
          }),
          observedBy: `observatory-l1-verified:${row.id}`,
        });
        if (created.created) summary.evidenceWritten++;
      } catch (error) {
        // 証拠が書けなくても照合の結果は正典（x402_l1_purchases）に残る。
        // 黙って消さない。
        logServerError("observatory.settlement_verify.evidence", error);
      }
      continue;
    }

    if (TRANSIENT_REASONS.has(result.reason)) {
      // 見えなかっただけ。否定ではないので status は倒さない。
      await db
        .update(x402L1Purchases)
        .set({ settlementVerifyReason: result.reason })
        .where(eq(x402L1Purchases.id, row.id));
      summary.deferred++;
      continue;
    }

    // 見に行って一致しなかった。売り手についての所見として確定させる。
    await db
      .update(x402L1Purchases)
      .set({
        status: "settle_claim_refuted",
        settlementVerified: false,
        settlementVerifiedAt: new Date(),
        settlementVerifyReason: `${result.reason}${result.detail ? `: ${result.detail}` : ""}`.slice(0, 500),
      })
      .where(eq(x402L1Purchases.id, row.id));
    summary.refuted++;
    invalidateDecisionCache(row.endpoint_id);
    await recordCorrection({
      subjectType: "purchase",
      subjectId: row.id,
      level: "l1",
      before: { status: row.status },
      after: { status: "settle_claim_refuted", reason: result.reason },
      reason: "settlement_backfill",
    }).catch(logAndSwallow("settlement-verifier.record_correction.refuted"));
  }

  return summary;
}

/** 未照合として残っている件数（公開面が「まだ見ていない」を言えるように）。 */
export async function countUnverifiedSettlementClaims(): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(x402L1Purchases)
    .where(
      and(
        isNull(x402L1Purchases.settlementVerified),
        or(
          eq(x402L1Purchases.status, "settle_claimed"),
          eq(x402L1Purchases.status, "settled"),
        ),
      ),
    );
  return Number(rows[0]?.n ?? 0);
}
