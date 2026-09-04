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
// 除外: budget_denied / halted / request_error / in_flight（我々側の都合・進行中は
// 判定ではない——facts with denominators の分母から正直に外し、その旨を
// definition で明示する）。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";

export const DECISION_DEFINITION =
  "Each row is a decision the daily L1 runner actually made with real funds at stake, mapped 1:1 from the public ledger: refused_price_mismatch / refused_over_cap (wall demanded more than declared or over the hard cap — nothing signed), refused_payto_mismatch (wall named a payee other than the one the catalog declared — nothing signed), refused_payto_operator_self (wall named vet402's own receiving address — nothing signed), refused_wall_unpayable (no valid 402 / no machine-payable accept), paid_settled, paid_delivered_no_receipt, paid_settlement_claim_unverifiable (the wall claimed a successful settlement but the transaction identifier it returned is not even well-formed for that chain), paid_settlement_claim_unverified (claimed with a well-formed id, not yet re-read on-chain by us), paid_settlement_claim_refuted (we re-read it on-chain and the expected USDC transfer to the declared payee is not there — a finding about the seller, not about us), paid_no_settlement. As of 2026-08-23, paid_settled means vet402 confirmed the transfer on-chain (recipient, amount, token, chain, confirmations), not that the seller asserted it. Excluded as non-decisions: budget_denied, halted (the operator's runtime spending halt stopped the batch before signing), request_error, in_flight (vet402-side states).";

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

/** 判定として公開する status の閉集合（行の抽出と合計の両方がここを見る）。 */
export const DECISION_STATUSES = Object.keys(STATUS_TO_DECISION);

export type DecisionTotals = {
  refused: number;
  paidSettled: number;
  paidNoSettlement: number;
  paidNoReceipt: number;
};

/**
 * status ごとの件数から見出しの合計を組む（2026-09-04 外部監査 E・P0-4）。
 *
 * 事故: /decisions の見出しは "last 30 days" と書きながら、合計は LIMIT 200 で
 * 切ったあとの行を数えていた。30 日に 200 件を超える判定があれば、見出しの数は
 * 窓の集計ではなく「直近 200 件の内訳」になる。/impact §3 も同じ feed を読む。
 * 表示件数と合計を切り離すために、合計は行から作らず件数から作る。
 */
export function decisionTotalsFromStatusCounts(
  counts: readonly { status: string; n: number }[],
): DecisionTotals {
  const totals: DecisionTotals = { refused: 0, paidSettled: 0, paidNoSettlement: 0, paidNoReceipt: 0 };
  for (const { status, n } of counts) {
    const decision = STATUS_TO_DECISION[status];
    if (!decision) continue; // 写像に無いものは我々側の状態。分母にも分子にも入れない
    const add = Number(n) || 0;
    if (decision.startsWith("refused_")) totals.refused += add;
    else if (decision === "paid_settled") totals.paidSettled += add;
    else if (decision === "paid_no_settlement") totals.paidNoSettlement += add;
    else if (decision === "paid_delivered_no_receipt") totals.paidNoReceipt += add;
  }
  return totals;
}

export type DecisionRow = {
  at: string;
  /** x402_endpoints.id — the record page is /observatory/e/{endpointId}. */
  endpointId: string;
  resourceKey: string;
  network: string | null;
  decision: string;
  amountUnits: string | null;
  spentUnits: string;
  txHash: string | null;
};

export type DecisionFeed = {
  /** 新しい順の表示行。`limit` で切られる（合計はこの切り取りに依存しない）。 */
  rows: DecisionRow[];
  /** 窓（days）全体の合計。行の表示上限とは無関係に SQL で数える。 */
  totals: DecisionTotals;
  /** 窓全体の判定件数。rows.length より大きければ表示が切られている。 */
  totalDecisions: number;
  definition: string;
};

export async function getDecisionFeed(days: number, limit = 200): Promise<DecisionFeed> {
  const span = Math.min(Math.max(Math.trunc(days) || 0, 1), 366);
  const cap = Math.min(Math.max(limit, 1), 500);
  const db = getDb();
  const empty: DecisionFeed = {
    rows: [],
    totals: { refused: 0, paidSettled: 0, paidNoSettlement: 0, paidNoReceipt: 0 },
    totalDecisions: 0,
    definition: DECISION_DEFINITION,
  };
  if (!db) return empty;

  const raw = await db.execute(sql`
    SELECT to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
           e.id AS endpoint_id, e.resource_key, e.network, pu.status, pu.amount_units,
           coalesce(pu.spent_units, '0') AS spent_units, pu.tx_hash
    FROM x402_l1_purchases pu
    JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE pu.attempted_at >= now() - make_interval(days => ${span}::int)
      AND pu.status IN (${sql.join(DECISION_STATUSES.map((st) => sql`${st}`), sql`, `)})
    ORDER BY pu.attempted_at DESC
    LIMIT ${cap}
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
    string,
    unknown
  >[];
  const feed = rows.map((r) => ({
    at: String(r.at),
    endpointId: String(r.endpoint_id),
    resourceKey: String(r.resource_key),
    network: r.network === null ? null : String(r.network),
    decision: STATUS_TO_DECISION[String(r.status)] ?? "unknown",
    amountUnits: r.amount_units === null ? null : String(r.amount_units),
    spentUnits: String(r.spent_units),
    txHash: r.tx_hash === null ? null : String(r.tx_hash),
  }));
  // 合計は窓全体を数える。上の SELECT は表示のための LIMIT 付きなので、
  // その結果を数えると見出しが「直近 N 件の内訳」になってしまう（監査 E・P0-4）。
  const countRaw = await db.execute(sql`
    SELECT pu.status, count(*)::int AS n
    FROM x402_l1_purchases pu
    WHERE pu.attempted_at >= now() - make_interval(days => ${span}::int)
      AND pu.status IN (${sql.join(DECISION_STATUSES.map((st) => sql`${st}`), sql`, `)})
    GROUP BY pu.status
  `);
  const countRows = (Array.isArray(countRaw) ? countRaw : (countRaw as { rows?: unknown[] }).rows ?? []) as Record<
    string,
    unknown
  >[];
  const counts = countRows.map((r) => ({ status: String(r.status), n: Number(r.n ?? 0) }));
  const totals = decisionTotalsFromStatusCounts(counts);
  const totalDecisions = counts.reduce((sum, c) => sum + c.n, 0);
  return { rows: feed, totals, totalDecisions, definition: DECISION_DEFINITION };
}

export type SettledReceipt = {
  at: string;
  endpointId: string;
  resourceKey: string;
  network: string | null;
  amountUnits: string | null;
  txHash: string;
};

/**
 * 直近の決済済み受領証（2026-09-02 監査 F4: /impact に tx ハッシュが 0 本だった）。
 * `settled` = 我々がオンチェーンで確認したもの（2026-08-23 定義）。tx_hash の無い行は
 * 受領証ではないので除く。
 */
export async function getLatestSettledReceipts(limit = 5): Promise<SettledReceipt[]> {
  const cap = Math.min(Math.max(Math.trunc(limit) || 0, 1), 50);
  const db = getDb();
  if (!db) return [];
  const raw = await db.execute(sql`
    SELECT to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at,
           e.id AS endpoint_id, e.resource_key, coalesce(pu.network, e.network) AS network,
           pu.amount_units, pu.tx_hash
    FROM x402_l1_purchases pu
    JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE pu.status = 'settled' AND pu.tx_hash IS NOT NULL
    ORDER BY pu.attempted_at DESC
    LIMIT ${cap}
  `);
  const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
    string,
    unknown
  >[];
  return rows.map((r) => ({
    at: String(r.at),
    endpointId: String(r.endpoint_id),
    resourceKey: String(r.resource_key),
    network: r.network === null ? null : String(r.network),
    amountUnits: r.amount_units === null ? null : String(r.amount_units),
    txHash: String(r.tx_hash),
  }));
}
