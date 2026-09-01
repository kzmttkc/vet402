// ============================================================
// §7.2 / §9.1 センサス要約。生値（raw）と実需（real = wash_flag 'none'）を
// 同じ問い合わせから両方返す。混ぜて一つの数字にしない。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
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
  "settlements_raw counts every indexed x402-related settlement in the window (chain index of USDC transfers to catalog-declared payTo addresses, verified POST /payments/x402 rows, and vet402's own L1 purchases). settlements_real excludes wash_flag self_deal (same EOA or same funder), circular (reverse transfer within 24h), and test (known measurement wallets, including every wallet vet402 pays from). Both numbers are published; they are never merged. attribution: confirmed = payTo, amount and time all match a catalog envelope; probable = payTo matches, amount or time is loose; unmatched = a receipt with no resource. ERC-8004 owner identity is not yet used for self_deal clustering (disclosed limitation).";

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
  const rows = rowsOf<Record<string, number | string | null>>(
    await db.execute(sql`
      SELECT
        count(*)::int AS raw,
        count(*) FILTER (WHERE wash_flag = 'none')::int AS real,
        count(*) FILTER (WHERE wash_flag = 'self_deal')::int AS self_deal,
        count(*) FILTER (WHERE wash_flag = 'circular')::int AS circular,
        count(*) FILTER (WHERE wash_flag = 'test')::int AS test,
        count(*) FILTER (WHERE attribution = 'confirmed')::int AS confirmed,
        count(*) FILTER (WHERE attribution = 'probable')::int AS probable,
        count(*) FILTER (WHERE attribution = 'unmatched')::int AS unmatched,
        count(DISTINCT payer_id)::int AS payers_raw,
        count(DISTINCT payer_id) FILTER (WHERE wash_flag = 'none')::int AS payers_real,
        count(DISTINCT payee_id) FILTER (WHERE wash_flag = 'none')::int AS payees_real,
        count(DISTINCT endpoint_id) FILTER (WHERE wash_flag = 'none' AND endpoint_id IS NOT NULL)::int AS endpoints_real,
        count(*) FILTER (WHERE source = 'l1_purchase')::int AS src_l1,
        count(*) FILTER (WHERE source = 'payments_api')::int AS src_api,
        count(*) FILTER (WHERE source = 'chain_index')::int AS src_chain
      FROM settlements
      WHERE coalesce(block_time, observed_at) > now() - make_interval(days => ${days})
        ${chain ? sql`AND chain = ${chain}` : sql``}
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
  const cond = where.endpointId
    ? sql`endpoint_id = ${where.endpointId}::uuid`
    : where.payeeId
      ? sql`payee_id = ${where.payeeId}`
      : sql`false`;
  const rows = rowsOf<{ raw: number; real: number; test: number; payers: number }>(
    await db.execute(sql`
      SELECT count(*)::int AS raw,
             count(*) FILTER (WHERE wash_flag = 'none')::int AS real,
             count(*) FILTER (WHERE wash_flag = 'test')::int AS test,
             count(DISTINCT payer_id) FILTER (WHERE wash_flag = 'none')::int AS payers
      FROM settlements
      WHERE ${cond} AND coalesce(block_time, observed_at) > now() - make_interval(days => ${days})
    `),
  );
  const r = rows[0];
  return { raw: Number(r?.raw ?? 0), real: Number(r?.real ?? 0), test: Number(r?.test ?? 0), uniquePayersReal: Number(r?.payers ?? 0) };
}
