// ============================================================
// 公開判定フィード（次波①）——「拒否デモ」の資金不要・演出ゼロ版。
//
// SPEC20 A4 は常時稼働の拒否エージェントを求めるが、日次 L1 ランナーは
// 既に毎日「支払うか・拒否するか」を実資金で判定している。このモジュールは
// その台帳の判定部分を公開フィードの語彙に写像するだけで、新しい判定は
// 一切作らない。
//
// 写像（固定・変えるなら名前も変える）:
//   price_mismatch → refused_price_mismatch（壁が申告より高く要求 → 署名せず）
//   payto_mismatch → refused_payto_mismatch（壁がカタログ申告と違う受取先を
//                    要求 → 署名せず。2026-08-22 監査で EVM 経路に追加）
//   payto_operator_self → refused_payto_operator_self（壁が vet402 自身の
//                    受取先を要求 → 自己取引になるので署名せず）
//   over_cap       → refused_over_cap（上限超の価格 → 署名せず）
//   no_402 / no_eligible_accept → refused_wall_unpayable（機械的に支払えない壁）
//   settled        → paid_settled（支払い、決済レシートあり）
//   delivered_no_receipt → paid_delivered_no_receipt（品は来たがレシート無し）
//   settle_failed  → paid_no_settlement（署名したが決済されず——公開すべき損失）
// 除外: budget_denied / request_error / in_flight（我々側の都合・進行中は
// 判定ではない——facts with denominators の分母から正直に外し、その旨を
// definition で明示する）。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

export const DECISION_DEFINITION =
  "Each row is a decision the daily L1 runner actually made with real funds at stake, mapped 1:1 from the public ledger: refused_price_mismatch / refused_over_cap (wall demanded more than declared or over the hard cap — nothing signed), refused_payto_mismatch (wall named a payee other than the one the catalog declared — nothing signed), refused_payto_operator_self (wall named vet402's own receiving address — nothing signed), refused_wall_unpayable (no valid 402 / no machine-payable accept), paid_settled, paid_delivered_no_receipt, paid_settlement_claim_unverifiable (the wall claimed a successful settlement but the transaction identifier it returned is not even well-formed for that chain), paid_settlement_claim_unverified (claimed with a well-formed id, not yet re-read on-chain by us), paid_settlement_claim_refuted (we re-read it on-chain and the expected USDC transfer to the declared payee is not there — a finding about the seller, not about us), paid_no_settlement. As of 2026-08-23, paid_settled means vet402 confirmed the transfer on-chain (recipient, amount, token, chain, confirmations), not that the seller asserted it. Excluded as non-decisions: budget_denied, request_error, in_flight (vet402-side states).";

const STATUS_TO_DECISION: Record<string, string> = {
  price_mismatch: "refused_price_mismatch",
  payto_mismatch: "refused_payto_mismatch",
  payto_operator_self: "refused_payto_operator_self",
  over_cap: "refused_over_cap",
  no_402: "refused_wall_unpayable",
  no_eligible_accept: "refused_wall_unpayable",
  settled: "paid_settled",
  delivered_no_receipt: "paid_delivered_no_receipt",
  settle_claimed_unverifiable: "paid_settlement_claim_unverifiable",
  settle_claimed: "paid_settlement_claim_unverified",
  settle_claim_refuted: "paid_settlement_claim_refuted",
  settle_failed: "paid_no_settlement",
};

export type DecisionRow = {
  at: string;
  resourceKey: string;
  network: string | null;
  decision: string;
  amountUnits: string | null;
  spentUnits: string;
  txHash: string | null;
};

export type DecisionFeed = {
  rows: DecisionRow[];
  totals: { refused: number; paidSettled: number; paidNoSettlement: number; paidNoReceipt: number };
  definition: string;
};

export async function getDecisionFeed(days: number, limit = 200): Promise<DecisionFeed> {
  const span = Math.min(Math.max(Math.trunc(days) || 0, 1), 366);
  const cap = Math.min(Math.max(limit, 1), 500);
  const db = getDb();
  const empty: DecisionFeed = {
    rows: [],
    totals: { refused: 0, paidSettled: 0, paidNoSettlement: 0, paidNoReceipt: 0 },
    definition: DECISION_DEFINITION,
  };
  if (!db) return empty;

  const raw = await db.execute(sql`
    SELECT to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
           e.resource_key, e.network, pu.status, pu.amount_units,
           coalesce(pu.spent_units, '0') AS spent_units, pu.tx_hash
    FROM x402_l1_purchases pu
    JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE pu.attempted_at >= now() - make_interval(days => ${span}::int)
      AND pu.status IN ('price_mismatch','payto_mismatch','payto_operator_self','over_cap','no_402','no_eligible_accept','settled','delivered_no_receipt','settle_claimed_unverifiable','settle_claimed','settle_claim_refuted','settle_failed')
    ORDER BY pu.attempted_at DESC
    LIMIT ${cap}
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
    string,
    unknown
  >[];
  const feed = rows.map((r) => ({
    at: String(r.at),
    resourceKey: String(r.resource_key),
    network: r.network === null ? null : String(r.network),
    decision: STATUS_TO_DECISION[String(r.status)] ?? "unknown",
    amountUnits: r.amount_units === null ? null : String(r.amount_units),
    spentUnits: String(r.spent_units),
    txHash: r.tx_hash === null ? null : String(r.tx_hash),
  }));
  const totals = {
    refused: feed.filter((r) => r.decision.startsWith("refused_")).length,
    paidSettled: feed.filter((r) => r.decision === "paid_settled").length,
    paidNoSettlement: feed.filter((r) => r.decision === "paid_no_settlement").length,
    paidNoReceipt: feed.filter((r) => r.decision === "paid_delivered_no_receipt").length,
  };
  return { rows: feed, totals, definition: DECISION_DEFINITION };
}
