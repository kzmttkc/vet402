// ============================================================
// GET /api/v1/delivery/sellers.json の読み手（2026-10-28・読むだけ）。
// pg テストはここを直接呼ぶ。route は cached.ts の unstable_cache 越し。
// ============================================================
import { sql } from "drizzle-orm";
import type { getDb } from "@/lib/db/client";
import { networkFilterIds } from "@/lib/observatory/chains";
import { PAID_ATTEMPT_STATUSES } from "@/lib/observatory/reader";
import { priceUsdOf } from "@/lib/mcp/tools";
import { DELIVERED } from "@/lib/mcp/reads";
import { feedListedIn, LISTED_IN_CASE_SQL, type FeedListedIn } from "./listed-in";
import type { DeliverySellersQuery } from "./sellers-feed-query";

export type Db = NonNullable<ReturnType<typeof getDb>>;

export const DELIVERY_FEED_RATE_PER_MIN = 30;
export const DELIVERY_FEED_WINDOW_DAYS = 30;
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
const PAID_LIST = sql.join(
  PAID_ATTEMPT_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

export async function readDeliverySellersFeed(db: Db, query: DeliverySellersQuery): Promise<DeliveryFeedPayload> {
  const asOf = new Date().toISOString();
  const networkIds = query.network ? networkFilterIds(query.network) : null;
  const networkClause =
    networkIds && networkIds.length > 0
      ? sql`AND e.network IN (${sql.join(networkIds.map((id) => sql`${id}`), sql`, `)})`
      : sql``;
  const minDeliveredClause =
    query.minDelivered !== null ? sql`AND l1.delivered_30d >= ${query.minDelivered}` : sql``;
  const listedInClause =
    query.listedIn !== null ? sql`AND (${sql.raw(LISTED_IN_CASE_SQL)}) = ${query.listedIn}` : sql``;

  const raw = await db.execute(sql`
    WITH l1 AS (
      SELECT pu.endpoint_id,
             count(*)::int AS paid_attempts_30d,
             count(*) FILTER (WHERE ${DELIVERED})::int AS delivered_30d,
             count(*) FILTER (WHERE pu.status = 'settled' AND NOT (${DELIVERED}))::int AS settled_not_delivered_30d,
             max(pu.attempted_at) AS last_attempt_at,
             max(pu.attempted_at) FILTER (WHERE ${DELIVERED}) AS last_delivered_at
      FROM x402_l1_purchases pu
      WHERE pu.attempted_at > now() - interval '30 days'
        AND pu.status IN (${PAID_LIST})
      GROUP BY pu.endpoint_id
    )
    SELECT e.resource_url, coalesce(e.method, 'GET') AS method, e.network, e.price_amount, e.source,
           e.quality_payers_30d,
           l1.paid_attempts_30d, l1.delivered_30d, l1.settled_not_delivered_30d,
           to_char(l1.last_attempt_at AT TIME ZONE 'utc', ${ISO}) AS last_attempt_at,
           to_char(l1.last_delivered_at AT TIME ZONE 'utc', ${ISO}) AS last_delivered_at,
           e.id::text AS endpoint_id
    FROM x402_endpoints e
    JOIN l1 ON l1.endpoint_id = e.id
    WHERE e.status = 'active'
      AND l1.paid_attempts_30d >= 1
      ${networkClause}
      ${minDeliveredClause}
      ${listedInClause}
    ORDER BY e.resource_url`);

  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const rows: DeliveryFeedRow[] = rowsOf(raw).map((r) => {
    const source = String(r.source);
    const listed = feedListedIn(source);
    const quality = r.quality_payers_30d;
    const bazaarPayers =
      listed === "bazaar" ? (quality == null || quality === "" ? null : Number(quality)) : null;
    return {
      url: String(r.resource_url),
      method: String(r.method),
      network: str(r.network),
      price_usd: priceUsdOf(str(r.price_amount)),
      listed_in: listed,
      bazaar_payers_30d: bazaarPayers,
      paid_attempts_30d: Number(r.paid_attempts_30d),
      delivered_30d: Number(r.delivered_30d),
      settled_not_delivered_30d: Number(r.settled_not_delivered_30d),
      last_attempt_at: str(r.last_attempt_at),
      last_delivered_at: str(r.last_delivered_at),
      record_url: `https://vet402.com/observatory/e/${String(r.endpoint_id)}`,
    };
  });

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
