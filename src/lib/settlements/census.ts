// ============================================================
// §7.2 / §9.1 センサス要約。生値（raw）と実需（real = wash_flag 'none'）を
// 同じ問い合わせから両方返す。混ぜて一つの数字にしない。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { RAW_RETENTION_DAYS, SETTLEMENT_DAY, UTC_TODAY } from "./rollup";
import { rowsOf } from "./upsert";

export type CensusWindow = "7d" | "30d";

export type CensusSummary = {
  chain: string;
  window: CensusWindow;
  settlements_raw: number;
  settlements_real: number;
  wash: { self_deal: number; circular: number; test: number };
  attribution: { confirmed: number; probable: number; unmatched: number };
  unique_payers_raw: number;
  unique_payers_real: number;
  unique_payees_real: number;
  endpoints_with_real_settlement: number;
  by_source: { l1_purchase: number; payments_api: number; chain_index: number };
  definition: string;
  disclaimer: string;
  retrievedAt: string;
};

export const CENSUS_DEFINITION =
  "settlements_raw counts every indexed x402-related settlement in the window (chain index of USDC transfers to catalog-declared payTo addresses, verified POST /payments/x402 rows, and vet402's own L1 purchases). settlements_real excludes wash_flag self_deal (same EOA or same funder), circular (reverse transfer within 24h), and test (known measurement wallets, including every wallet vet402 pays from). Both numbers are published; they are never merged. attribution: confirmed = payTo, amount and time all match a catalog envelope; probable = payTo matches, amount or time is loose; unmatched = a receipt with no resource. ERC-8004 owner identity is not yet used for self_deal clustering (disclosed limitation). The window is counted in whole UTC days. Raw rows are kept " +
  RAW_RETENTION_DAYS +
  " days; older days are held as daily (payee, payer) aggregates; counts are exact, per-transaction receipts older than " +
  RAW_RETENTION_DAYS +
  " days are not served.";

export const CENSUS_DISCLAIMER =
  "Scores are opinions; L0–L2 are measurement records. This is not credit assessment, KYC, sanctions screening, or certification.";

export async function getCensusSummary(chain: string | null, window: CensusWindow): Promise<CensusSummary> {
  const db = getDb();
  const empty: CensusSummary = {
    chain: chain ?? "all",
    window,
    settlements_raw: 0,
    settlements_real: 0,
    wash: { self_deal: 0, circular: 0, test: 0 },
    attribution: { confirmed: 0, probable: 0, unmatched: 0 },
    unique_payers_raw: 0,
    unique_payers_real: 0,
    unique_payees_real: 0,
    endpoints_with_real_settlement: 0,
    by_source: { l1_purchase: 0, payments_api: 0, chain_index: 0 },
    definition: CENSUS_DEFINITION,
    disclaimer: CENSUS_DISCLAIMER,
    retrievedAt: new Date().toISOString(),
  };
  if (!db) return empty;
  const days = window === "7d" ? 7 : 30;
  const chainRaw = chain ? sql`AND chain = ${chain}` : sql``;
  // 生行 ∪ 日次集約。1 件の決済がこの 2 つに同時に載ることはない
  // （rollup.ts が「消して畳む」を単一文でやる）ので、足すだけで正確。
  // 集約がまだ 1 行も無ければ、これは生行だけの計算とまったく同じ式になる。
  const rows = rowsOf<Record<string, number | string | null>>(
    await db.execute(sql`
      WITH u AS (
        SELECT payer_id, payee_id, endpoint_id, wash_flag, source, attribution, 1::bigint AS n
        FROM settlements
        WHERE ${SETTLEMENT_DAY} > ${UTC_TODAY} - ${days}::int ${chainRaw}
        UNION ALL
        SELECT payer_id, payee_id, endpoint_id, wash_flag, source, attribution, n::bigint
        FROM settlement_daily
        WHERE day > ${UTC_TODAY} - ${days}::int ${chainRaw}
      )
      SELECT
        coalesce(sum(n), 0)::int AS raw,
        coalesce(sum(n) FILTER (WHERE wash_flag = 'none'), 0)::int AS real,
        coalesce(sum(n) FILTER (WHERE wash_flag = 'self_deal'), 0)::int AS self_deal,
        coalesce(sum(n) FILTER (WHERE wash_flag = 'circular'), 0)::int AS circular,
        coalesce(sum(n) FILTER (WHERE wash_flag = 'test'), 0)::int AS test,
        coalesce(sum(n) FILTER (WHERE attribution = 'confirmed'), 0)::int AS confirmed,
        coalesce(sum(n) FILTER (WHERE attribution = 'probable'), 0)::int AS probable,
        coalesce(sum(n) FILTER (WHERE attribution = 'unmatched'), 0)::int AS unmatched,
        count(DISTINCT payer_id)::int AS payers_raw,
        count(DISTINCT payer_id) FILTER (WHERE wash_flag = 'none')::int AS payers_real,
        count(DISTINCT payee_id) FILTER (WHERE wash_flag = 'none')::int AS payees_real,
        count(DISTINCT endpoint_id) FILTER (WHERE wash_flag = 'none' AND endpoint_id IS NOT NULL)::int AS endpoints_real,
        coalesce(sum(n) FILTER (WHERE source = 'l1_purchase'), 0)::int AS src_l1,
        coalesce(sum(n) FILTER (WHERE source = 'payments_api'), 0)::int AS src_api,
        coalesce(sum(n) FILTER (WHERE source = 'chain_index'), 0)::int AS src_chain
      FROM u
    `),
  );
  const r = rows[0] ?? {};
  const n = (k: string) => Number(r[k] ?? 0);
  return {
    ...empty,
    settlements_raw: n("raw"),
    settlements_real: n("real"),
    wash: { self_deal: n("self_deal"), circular: n("circular"), test: n("test") },
    attribution: { confirmed: n("confirmed"), probable: n("probable"), unmatched: n("unmatched") },
    unique_payers_raw: n("payers_raw"),
    unique_payers_real: n("payers_real"),
    unique_payees_real: n("payees_real"),
    endpoints_with_real_settlement: n("endpoints_real"),
    by_source: { l1_purchase: n("src_l1"), payments_api: n("src_api"), chain_index: n("src_chain") },
  };
}

/** 1 つの endpoint/payee の 30 日実需（seller_facts 用）。 */
export async function getSettlementCounts(
  where: { endpointId?: string; payeeId?: string },
  days = 30,
): Promise<{ raw: number; real: number; test: number; uniquePayersReal: number }> {
  const db = getDb();
  if (!db) return { raw: 0, real: 0, test: 0, uniquePayersReal: 0 };
  // 生行と集約で列名が同じなので、同じ条件式をそのまま両方に当てられる。
  const cond = where.endpointId
    ? sql`endpoint_id = ${where.endpointId}::uuid`
    : where.payeeId
      ? sql`payee_id = ${where.payeeId}`
      : sql`false`;
  const rows = rowsOf<{ raw: number; real: number; test: number; payers: number }>(
    await db.execute(sql`
      WITH u AS (
        SELECT payer_id, wash_flag, 1::bigint AS n FROM settlements
        WHERE ${cond} AND ${SETTLEMENT_DAY} > ${UTC_TODAY} - ${days}::int
        UNION ALL
        SELECT payer_id, wash_flag, n::bigint FROM settlement_daily
        WHERE ${cond} AND day > ${UTC_TODAY} - ${days}::int
      )
      SELECT coalesce(sum(n), 0)::int AS raw,
             coalesce(sum(n) FILTER (WHERE wash_flag = 'none'), 0)::int AS real,
             coalesce(sum(n) FILTER (WHERE wash_flag = 'test'), 0)::int AS test,
             count(DISTINCT payer_id) FILTER (WHERE wash_flag = 'none')::int AS payers
      FROM u
    `),
  );
  const r = rows[0];
  return { raw: Number(r?.raw ?? 0), real: Number(r?.real ?? 0), test: Number(r?.test ?? 0), uniquePayersReal: Number(r?.payers ?? 0) };
}
