// ============================================================
// GET /api/v1/delivery/sellers.json の読み手（2026-10-28・読むだけ）。
// pg テストはここを直接呼ぶ。route は cached.ts の unstable_cache 越し。
// L1 件数は check_x402_seller の delivery と同じ（seller-facts.ts l1McpDeliveryCounts）。
// ============================================================
import { sql } from "drizzle-orm";
import type { getDb } from "@/lib/db/client";
import { networkFilterIds } from "@/lib/observatory/chains";
import { priceUsdOf } from "@/lib/mcp/tools";
import { L1_WINDOW_DAYS } from "@/lib/decision/rules";
import { l1McpDeliveryCounts, SIGNED_STATUSES, type PurchaseInput } from "@/lib/decision/seller-facts";
import { feedListedIn, LISTED_IN_CASE_SQL, type FeedListedIn } from "./listed-in";
import type { DeliverySellersQuery } from "./sellers-feed-query";

export type Db = NonNullable<ReturnType<typeof getDb>>;

export const DELIVERY_FEED_RATE_PER_MIN = 30;
export const DELIVERY_FEED_WINDOW_DAYS = L1_WINDOW_DAYS;
export const DELIVERY_FEED_METHOD_URL = "https://vet402.com/observatory/methodology";
export const DELIVERY_FEED_LICENSE = "CC-BY-4.0";
export const DELIVERY_FEED_LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";

export type DeliveryFeedRow = {
  url: string;
  method: string;
  network: string | null;
  price_usd: number | null;
  listed_in: FeedListedIn | null;
  bazaar_payers_30d: number | null;
  paid_attempts_30d: number;
  delivered_30d: number;
  settled_not_delivered_30d: number;
  last_attempt_at: string | null;
  last_delivered_at: string | null;
  record_url: string;
};

export type DeliveryFeedPayload = {
  as_of: string;
  window_days: number;
  method_url: string;
  license: string;
  license_url: string;
  row_count: number;
  rows: DeliveryFeedRow[];
};

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}

const ISO = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS"Z"'`);
const SIGNED_LIST = sql.join(
  [...SIGNED_STATUSES].map((s) => sql`${s}`),
  sql`, `,
);
const WINDOW_INTERVAL = sql`(${L1_WINDOW_DAYS} * interval '1 day')`;

function purchaseInputFromRow(r: Record<string, unknown>): PurchaseInput {
  return {
    attemptedAt: String(r.attempted_at),
    status: String(r.status),
    latencyMs: r.latency_ms === null || r.latency_ms === undefined ? null : Number(r.latency_ms),
    httpStatusPaid: r.http_status_paid === null || r.http_status_paid === undefined ? null : Number(r.http_status_paid),
    payloadNonEmpty: r.payload_non_empty === null || r.payload_non_empty === undefined ? null : Boolean(r.payload_non_empty),
    l2Schema: r.l2_schema === null || r.l2_schema === undefined ? null : String(r.l2_schema),
    txHash: r.tx_hash === null || r.tx_hash === undefined ? null : String(r.tx_hash),
    network: r.network === null || r.network === undefined ? null : String(r.network),
    amountUnits: r.amount_units === null || r.amount_units === undefined ? null : String(r.amount_units),
    payer: r.payer === null || r.payer === undefined ? null : String(r.payer),
    settlementConfirmed:
      r.settlement_confirmed === null || r.settlement_confirmed === undefined ? null : Boolean(r.settlement_confirmed),
    authNonce: typeof r.auth_nonce === "string" && r.auth_nonce !== "" ? r.auth_nonce : null,
  };
}

export async function readDeliverySellersFeed(db: Db, query: DeliverySellersQuery): Promise<DeliveryFeedPayload> {
  const asOf = new Date().toISOString();
  const networkIds = query.network ? networkFilterIds(query.network) : null;
  const networkClause =
    networkIds && networkIds.length > 0
      ? sql`AND e.network IN (${sql.join(networkIds.map((id) => sql`${id}`), sql`, `)})`
      : sql``;
  const listedInClause =
    query.listedIn !== null ? sql`AND (${sql.raw(LISTED_IN_CASE_SQL)}) = ${query.listedIn}` : sql``;

  const epRaw = await db.execute(sql`
    SELECT e.resource_url, coalesce(e.method, 'GET') AS method, e.network, e.price_amount, e.source,
           e.quality_payers_30d, e.declared_schema, e.declared_input, e.method AS raw_method,
           e.id::text AS endpoint_id
    FROM x402_endpoints e
    WHERE e.status = 'active'
      AND EXISTS (
        SELECT 1 FROM x402_l1_purchases pu
        WHERE pu.endpoint_id = e.id
          AND pu.attempted_at > now() - ${WINDOW_INTERVAL}
          AND pu.status IN (${SIGNED_LIST})
      )
      ${networkClause}
      ${listedInClause}
    ORDER BY e.resource_url`);

  const epRows = rowsOf(epRaw);
  if (epRows.length === 0) {
    return {
      as_of: asOf,
      window_days: DELIVERY_FEED_WINDOW_DAYS,
      method_url: DELIVERY_FEED_METHOD_URL,
      license: DELIVERY_FEED_LICENSE,
      license_url: DELIVERY_FEED_LICENSE_URL,
      row_count: 0,
      rows: [],
    };
  }

  const epIds = epRows.map((r) => String(r.endpoint_id));
  const purchasesRaw = await db.execute(sql`
    SELECT pu.endpoint_id::text AS endpoint_id,
           pu.attempted_at::text AS attempted_at, pu.status, pu.latency_ms, pu.http_status_paid, pu.payload_non_empty,
           pu.l2_schema, pu.tx_hash, pu.network, pu.amount_units, pu.payer, left(pu.auth_nonce, 80) AS auth_nonce,
           CASE WHEN pu.status = 'settle_failed' AND pu.tx_hash IS NOT NULL THEN
             (pu.settlement_verified IS TRUE OR EXISTS (
               SELECT 1 FROM settlements s WHERE s.tx_hash IN (pu.tx_hash, lower(pu.tx_hash))
             ))
           END AS settlement_confirmed
    FROM x402_l1_purchases pu
    WHERE pu.endpoint_id = ANY(ARRAY[${sql.join(
      epIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::uuid[])
      AND pu.attempted_at > now() - ${WINDOW_INTERVAL}
      AND pu.status IN (${SIGNED_LIST})
    ORDER BY pu.endpoint_id, pu.attempted_at DESC`);

  const purchasesByEp = new Map<string, PurchaseInput[]>();
  for (const r of rowsOf(purchasesRaw)) {
    const id = String(r.endpoint_id);
    const list = purchasesByEp.get(id) ?? [];
    list.push(purchaseInputFromRow(r));
    purchasesByEp.set(id, list);
  }

  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const rows: DeliveryFeedRow[] = [];
  for (const r of epRows) {
    const endpointId = String(r.endpoint_id);
    const purchases = purchasesByEp.get(endpointId) ?? [];
    const counts = l1McpDeliveryCounts({
      purchases,
      declaredSchema: r.declared_schema ?? null,
      method: str(r.raw_method) ?? String(r.method),
      declaredInput: r.declared_input ?? null,
    });
    if (query.minDelivered !== null && counts.delivered < query.minDelivered) continue;

    const source = String(r.source);
    const listed = feedListedIn(source);
    const quality = r.quality_payers_30d;
    const bazaarPayers =
      listed === "bazaar" ? (quality == null || quality === "" ? null : Number(quality)) : null;
    rows.push({
      url: String(r.resource_url),
      method: String(r.method),
      network: str(r.network),
      price_usd: priceUsdOf(str(r.price_amount)),
      listed_in: listed,
      bazaar_payers_30d: bazaarPayers,
      paid_attempts_30d: counts.paid_attempts,
      delivered_30d: counts.delivered,
      settled_not_delivered_30d: counts.settled_not_delivered,
      last_attempt_at: counts.last_attempt_at_in_window,
      last_delivered_at: counts.last_delivered_at,
      record_url: `https://vet402.com/observatory/e/${endpointId}`,
    });
  }

  return {
    as_of: asOf,
    window_days: DELIVERY_FEED_WINDOW_DAYS,
    method_url: DELIVERY_FEED_METHOD_URL,
    license: DELIVERY_FEED_LICENSE,
    license_url: DELIVERY_FEED_LICENSE_URL,
    row_count: rows.length,
    rows,
  };
}
