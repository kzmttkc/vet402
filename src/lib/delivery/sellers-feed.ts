// ============================================================
// GET /api/v1/delivery/sellers.json の読み手（2026-10-28・点検 H1–H4）。
// 全量スナップショットを 1 本で読み、絞り込みとページは JS。キャッシュは sellers-feed-cache.ts。
// ============================================================
import { sql } from "drizzle-orm";
import type { getDb } from "@/lib/db/client";
import { L1_WINDOW_DAYS } from "@/lib/decision/rules";
import { l1CountsOf, SIGNED_STATUSES, type PurchaseInput } from "@/lib/decision/seller-facts";
import {
  L1_WINDOW_PURCHASE_LIMIT,
  l1WindowPurchasesFeedJoinSql,
  purchaseInputFromL1WindowRow,
} from "@/lib/decision/l1-window-purchases";
import { toCaip2, networkFilterIds } from "@/lib/observatory/chains";
import { buildRecordSides } from "@/lib/sellers/board";
import { listingDeclaredSchemaMinSql, readSellerFailureDays, toRowFacts } from "@/lib/sellers/reader";
import { feedListedIn, type FeedListedIn } from "./listed-in";
import { feedPriceUsd } from "./feed-price";
import type { DeliverySellersQuery } from "./sellers-feed-query";
import { compareFeedRows, decodeFeedCursor, encodeFeedCursor } from "./sellers-feed-query";

export type Db = NonNullable<ReturnType<typeof getDb>>;

export const DELIVERY_FEED_RATE_PER_MIN = 30;
export const DELIVERY_FEED_PAGE_SIZE = 2000;
export const DELIVERY_FEED_WINDOW_DAYS = L1_WINDOW_DAYS;
export const DELIVERY_FEED_METHOD_URL = "https://vet402.com/observatory/methodology";
export const DELIVERY_FEED_LICENSE = "CC-BY-4.0";
export const DELIVERY_FEED_LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";

export const DELIVERY_FEED_PUBLIC_ROW_KEYS = [
  "url",
  "method",
  "network",
  "price_usd",
  "listed_in",
  "bazaar_payers_30d",
  "paid_attempts_30d",
  "delivered_30d",
  "settled_not_delivered_30d",
  "last_attempt_at_30d",
  "last_delivered_at_30d",
  "record_url",
] as const;

export type DeliveryFeedRow = {
  endpoint_id: string;
  url: string;
  method: string;
  network: string | null;
  price_usd: number | null;
  listed_in: FeedListedIn | null;
  bazaar_payers_30d: number | null;
  paid_attempts_30d: number;
  delivered_30d: number;
  settled_not_delivered_30d: number;
  last_attempt_at_30d: string | null;
  last_delivered_at_30d: string | null;
  record_url: string;
};

export type DeliveryFeedPublicRow = Omit<DeliveryFeedRow, "endpoint_id">;

export type DeliveryFeedPayload = {
  as_of: string;
  window_days: number;
  method_url: string;
  license: string;
  license_url: string;
  row_count: number;
  total_rows: number;
  next_cursor: string | null;
  rows: DeliveryFeedPublicRow[];
};

export type DeliveryFeedSnapshot = {
  as_of: string;
  rows: DeliveryFeedRow[];
};

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}

const SIGNED_LIST = sql.join(
  [...SIGNED_STATUSES].map((s) => sql`${s}`),
  sql`, `,
);
const WINDOW_INTERVAL = sql`(${L1_WINDOW_DAYS} * interval '1 day')`;

function asRecord(v: unknown): Record<string, unknown> | null {
  if (typeof v === "string") {
    try {
      const p = JSON.parse(v) as unknown;
      return typeof p === "object" && p !== null && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** 絞り込みなしの全量（DB 1 本 + readRecordSidesBatch）。 */
export async function readDeliverySellersFeedSnapshot(db: Db): Promise<DeliveryFeedSnapshot> {
  const asOf = new Date().toISOString();
  const activeEp = sql`
    SELECT e.id, e.resource_url, coalesce(e.method, 'GET') AS method, e.network, e.price_amount, e.price_asset, e.source,
           e.quality_payers_30d, ${listingDeclaredSchemaMinSql} AS declared_schema_min, e.declared_input, e.id::text AS endpoint_id
    FROM x402_endpoints e
    WHERE e.status = 'active'
      AND EXISTS (
        SELECT 1 FROM x402_l1_purchases pu
        WHERE pu.endpoint_id = e.id
          AND pu.attempted_at > now() - ${WINDOW_INTERVAL}
          AND pu.status IN (${SIGNED_LIST})
      )
  `;
  const raw = await db.execute(sql`
    WITH active AS (${activeEp}),
    purchases AS (${l1WindowPurchasesFeedJoinSql(sql`SELECT id FROM active`)})
    SELECT a.resource_url, a.method, a.network, a.price_amount, a.price_asset, a.source, a.quality_payers_30d,
           a.declared_schema_min, a.declared_input, a.endpoint_id,
           p.attempted_at, p.status, p.latency_ms, p.http_status_paid, p.payload_non_empty, p.l2_schema, p.tx_hash,
           p.network AS purchase_network, p.attempted_at_utc, p.content_type, p.l2_detail, p.body_head, p.request_meta,
           p.amount_units, p.payer, p.has_nonce, p.settlement_confirmed
    FROM active a
    LEFT JOIN purchases p ON p.endpoint_id = a.endpoint_id
    ORDER BY a.resource_url, a.method, a.network NULLS FIRST, p.attempted_at DESC NULLS LAST
  `);

  const flat = rowsOf(raw);
  const epIds = [...new Set(flat.map((r) => String(r.endpoint_id)))];
  const failureDays = await readSellerFailureDays(db, epIds);

  const byEp = new Map<string, { meta: Record<string, unknown>; purchases: Record<string, unknown>[]; facts: ReturnType<typeof toRowFacts>[] }>();
  for (const r of flat) {
    const id = String(r.endpoint_id);
    if (!byEp.has(id)) {
      byEp.set(id, {
        meta: r,
        purchases: [],
        facts: [],
      });
    }
    if (r.attempted_at != null && r.attempted_at !== "") {
      byEp.get(id)!.purchases.push(r);
      byEp.get(id)!.facts.push(toRowFacts(r));
    }
  }

  const sidesMap = new Map<string, ReturnType<typeof buildRecordSides>>();
  for (const [id, { facts }] of byEp) {
    sidesMap.set(id, buildRecordSides(facts, Date.now(), failureDays));
  }

  const rows: DeliveryFeedRow[] = [];
  const entries = [...byEp.values()];
  entries.sort((a, b) =>
    compareFeedRows(
      {
        url: String(a.meta.resource_url),
        method: String(a.meta.method),
        network: str(a.meta.network),
        endpoint_id: String(a.meta.endpoint_id),
      },
      {
        url: String(b.meta.resource_url),
        method: String(b.meta.method),
        network: str(b.meta.network),
        endpoint_id: String(b.meta.endpoint_id),
      },
    ),
  );
  for (const { meta, purchases: pRows } of entries) {
    const endpointId = String(meta.endpoint_id);
    const sides = sidesMap.get(endpointId);
    const purchases: PurchaseInput[] = pRows.map((r) => purchaseInputFromL1WindowRow(r, sides));
    const counts = l1CountsOf(purchases, {
      declaredSchema: asRecord(meta.declared_schema_min),
      method: str(meta.method),
      declaredInput: asRecord(meta.declared_input),
    });
    if (counts.paid_attempts === 0) continue;
    const source = String(meta.source);
    const listed = feedListedIn(source);
    const quality = meta.quality_payers_30d;
    const bazaarPayers =
      listed === "bazaar" ? (quality == null || quality === "" ? null : Number(quality)) : null;
    const netRaw = str(meta.network);
    rows.push({
      endpoint_id: endpointId,
      url: String(meta.resource_url),
      method: String(meta.method),
      network: netRaw === null ? null : (toCaip2(netRaw) ?? netRaw),
      price_usd: feedPriceUsd(str(meta.price_amount), str(meta.price_asset), str(meta.network)),
      listed_in: listed,
      bazaar_payers_30d: bazaarPayers,
      paid_attempts_30d: counts.paid_attempts,
      delivered_30d: counts.delivered,
      settled_not_delivered_30d: counts.settled_not_delivered,
      last_attempt_at_30d: counts.last_attempt_at_in_window,
      last_delivered_at_30d: counts.last_delivered_at,
      record_url: `https://vet402.com/observatory/e/${endpointId}`,
    });
  }

  rows.sort((a, b) => compareFeedRows(a, b));
  return { as_of: asOf, rows };
}

function rowMatchesNetwork(row: DeliveryFeedRow, network: string): boolean {
  const ids = networkFilterIds(network);
  if (ids.length === 0) return false;
  const n = (row.network ?? "").toLowerCase();
  return ids.some((id) => id.toLowerCase() === n);
}

function filterRows(all: DeliveryFeedRow[], query: DeliverySellersQuery): DeliveryFeedRow[] {
  let out = all;
  if (query.network) out = out.filter((r) => rowMatchesNetwork(r, query.network!));
  if (query.minDelivered !== null) out = out.filter((r) => r.delivered_30d >= query.minDelivered!);
  if (query.listedIn !== null) out = out.filter((r) => r.listed_in === query.listedIn);
  return out;
}

export function paginateDeliveryFeedRows(
  filtered: DeliveryFeedRow[],
  cursor: { url: string; method: string; network: string | null; endpoint_id: string } | null,
  pageSize: number = DELIVERY_FEED_PAGE_SIZE,
): { page: DeliveryFeedRow[]; next_cursor: string | null } {
  let start = 0;
  if (cursor) {
    start = filtered.findIndex((r) => feedRowAfterCursor(r, cursor));
    if (start < 0) start = filtered.length;
  }
  const page = filtered.slice(start, start + pageSize);
  const last = page[page.length - 1];
  const next =
    start + pageSize < filtered.length && last
      ? encodeFeedCursor({ url: last.url, method: last.method, network: last.network, endpoint_id: last.endpoint_id })
      : null;
  return { page, next_cursor: next };
}

function feedRowAfterCursor(r: DeliveryFeedRow, cursor: { url: string; method: string; network: string | null; endpoint_id: string }): boolean {
  const cmp = compareFeedRows(r, cursor);
  if (cmp !== 0) return cmp > 0;
  return r.endpoint_id > cursor.endpoint_id;
}

export function deliveryFeedPublicRow(row: DeliveryFeedRow): DeliveryFeedPublicRow {
  const { endpoint_id: _id, ...rest } = row;
  return rest;
}

export function buildDeliveryFeedPayload(snapshot: DeliveryFeedSnapshot, query: DeliverySellersQuery): DeliveryFeedPayload {
  const filtered = filterRows(snapshot.rows, query);
  const cursor = query.cursor ? decodeFeedCursor(query.cursor) : null;
  const { page, next_cursor } = paginateDeliveryFeedRows(filtered, cursor === "invalid" ? null : cursor);
  return {
    as_of: snapshot.as_of,
    window_days: DELIVERY_FEED_WINDOW_DAYS,
    method_url: DELIVERY_FEED_METHOD_URL,
    license: DELIVERY_FEED_LICENSE,
    license_url: DELIVERY_FEED_LICENSE_URL,
    row_count: page.length,
    total_rows: filtered.length,
    next_cursor,
    rows: page.map(deliveryFeedPublicRow),
  };
}

/** pg テスト用: キャッシュを使わずスナップショットから応答を組む。 */
export async function readDeliverySellersFeed(db: Db, query: DeliverySellersQuery): Promise<DeliveryFeedPayload> {
  const snapshot = await readDeliverySellersFeedSnapshot(db);
  return buildDeliveryFeedPayload(snapshot, query);
}

export { L1_WINDOW_PURCHASE_LIMIT };
