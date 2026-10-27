// ============================================================
// MCP の入口が DB から読むもの（2026-10-28・読むだけ。支払い・プローブ・外への通信をしない）。
//
//   readL1Purchases        1 出品の最新 5 件。列は attempted_at・network・status・tx_hash の 4 つだけを名指しで読む
//                          （auth_nonce・payer・raw_*・購入の証拠の 2 列は SELECT に無い）
//   readHostExtras         1 ホストの出品（id・URL・network・status・source・last_seen）と、全出品から最新 5 件の購入
//   readFindSellers        ② の検索。resource_key と description に同じ LIKE の型を当て、直近 30 日の配達で並べる
// route は cached.ts の unstable_cache 越しに読み、pg テストはここの関数を直接呼ぶ。
// ============================================================
import { sql } from "drizzle-orm";
import type { getDb } from "@/lib/db/client";
import { explorerTxUrl } from "@/lib/observatory/chains";
import { PAID_ATTEMPT_STATUSES } from "@/lib/observatory/reader";
import { ACCEPTED_NOT_DONE_HTTP, DELIVERED_HTTP_MAX, DELIVERED_HTTP_MIN } from "@/lib/observatory/delivery";
import { sellerHostSql } from "@/lib/sellers/host";
import type { L1PurchaseOut } from "./schemas";

export type Db = NonNullable<ReturnType<typeof getDb>>;

export const L1_PURCHASES_SHOWN = 5;
/** 1 ホストで読む出品の上限（応答の大きさと問い合わせを抑える）。 */
export const HOST_LISTINGS_MAX = 500;

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

const ISO = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS"Z"'`);
const PAID_LIST = sql.join(
  PAID_ATTEMPT_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);
/** 届いた（delivery.ts の isDelivered と同じ述語: settled・2xx・202 でない・本文が空でない）。 */
const DELIVERED = sql`(pu.status = 'settled' AND coalesce(pu.http_status_paid BETWEEN ${DELIVERED_HTTP_MIN} AND ${DELIVERED_HTTP_MAX}
  AND pu.http_status_paid <> ${ACCEPTED_NOT_DONE_HTTP} AND pu.payload_non_empty IS NOT FALSE, false))`;

function toPurchase(r: Record<string, unknown>): L1PurchaseOut {
  const network = str(r.network);
  const tx = str(r.tx_hash);
  return {
    attempted_at: String(r.attempted_at),
    network,
    status: String(r.status),
    tx_hash: tx,
    explorer_url: explorerTxUrl(network, tx),
  };
}

/** 1 出品の最新 5 件（x402_l1_purchases の endpoint_idx を使う）。 */
export async function readL1Purchases(db: Db, endpointId: string): Promise<L1PurchaseOut[]> {
  const raw = await db.execute(sql`
    SELECT to_char(pu.attempted_at AT TIME ZONE 'utc', ${ISO}) AS attempted_at, pu.network, pu.status, pu.tx_hash
    FROM x402_l1_purchases pu
    WHERE pu.endpoint_id = ${endpointId}::uuid
    ORDER BY pu.attempted_at DESC, pu.id DESC
    LIMIT ${L1_PURCHASES_SHOWN}`);
  return rowsOf(raw).map(toPurchase);
}

export type HostListing = {
  endpointId: string;
  resourceUrl: string;
  method: string;
  network: string | null;
  status: string;
  source: string;
  lastSeenAt: string | null;
};

export type HostExtras = { fetchedAt: string; listings: HostListing[]; purchases: L1PurchaseOut[] };

/** host は parseSellerHostParam を通した値。売り手の単位は /sellers と同じ規則（sellerHostSql）。 */
export async function readHostExtras(db: Db, host: string): Promise<HostExtras> {
  const fetchedAt = new Date().toISOString();
  const HOST = sellerHostSql(sql`e.resource_key`);
  const listingsRaw = await db.execute(sql`
    SELECT e.id::text AS endpoint_id, e.resource_url, coalesce(e.method, 'GET') AS method, e.network, e.status, e.source,
           to_char(e.last_seen_at AT TIME ZONE 'utc', ${ISO}) AS last_seen_at
    FROM x402_endpoints e
    WHERE ${HOST} = ${host}
    ORDER BY e.status = 'active' DESC, e.last_seen_at DESC NULLS LAST, e.id
    LIMIT ${HOST_LISTINGS_MAX}`);
  const purchasesRaw = await db.execute(sql`
    SELECT to_char(pu.attempted_at AT TIME ZONE 'utc', ${ISO}) AS attempted_at, pu.network, pu.status, pu.tx_hash
    FROM x402_l1_purchases pu
    WHERE pu.endpoint_id IN (SELECT e.id FROM x402_endpoints e WHERE ${HOST} = ${host})
    ORDER BY pu.attempted_at DESC, pu.id DESC
    LIMIT ${L1_PURCHASES_SHOWN}`);
  return {
    fetchedAt,
    listings: rowsOf(listingsRaw).map((r) => ({
      endpointId: String(r.endpoint_id),
      resourceUrl: String(r.resource_url),
      method: String(r.method),
      network: str(r.network),
      status: String(r.status),
      source: String(r.source),
      lastSeenAt: str(r.last_seen_at),
    })),
    purchases: rowsOf(purchasesRaw).map(toPurchase),
  };
}

export type FoundListing = {
  observatoryId: string;
  url: string;
  description: string | null;
  priceAmount: string | null;
  network: string | null;
  delivered30d: number;
  paidAttempts30d: number;
  lastAttemptAt: string | null;
};

export const FIND_UNTESTED_MAX = 3;

/**
 * ② の検索。like は reader.ts の searchLikePattern（escapeLike 済み・`%…%`）。掲載中の出品だけ。
 * sellers: 直近 30 日に vet402 が払って届いた行が 1 件以上。並びは届いた件数 → 最後に届いた時刻 → id。
 * untested: vet402 が払った行（PAID_ATTEMPT_STATUSES）が 1 件も無い出品。順位は付けない（id 順で最大 3 件）。
 */
export async function readFindSellers(
  db: Db,
  like: string,
  limit: number,
): Promise<{ fetchedAt: string; sellers: FoundListing[]; untested: FoundListing[] }> {
  const fetchedAt = new Date().toISOString();
  const hits = sql`
    SELECT e.id, e.resource_url, e.description, e.price_amount, e.network
    FROM x402_endpoints e
    WHERE e.status = 'active' AND (e.resource_key ILIKE ${like} OR e.description ILIKE ${like})`;
  const [soldRaw, untestedRaw] = await Promise.all([
    db.execute(sql`
      WITH hits AS (${hits}),
      l1 AS (
        SELECT pu.endpoint_id,
               count(*)::int AS paid_attempts_30d,
               count(*) FILTER (WHERE ${DELIVERED})::int AS delivered_30d,
               max(pu.attempted_at) AS last_attempt_at,
               max(pu.attempted_at) FILTER (WHERE ${DELIVERED}) AS last_delivered_at
        FROM x402_l1_purchases pu
        WHERE pu.endpoint_id IN (SELECT id FROM hits)
          AND pu.attempted_at > now() - interval '30 days'
          AND pu.status IN (${PAID_LIST})
        GROUP BY pu.endpoint_id
      )
      SELECT h.id::text AS id, h.resource_url, left(h.description, 2000) AS description, h.price_amount, h.network,
             l1.delivered_30d, l1.paid_attempts_30d,
             to_char(l1.last_attempt_at AT TIME ZONE 'utc', ${ISO}) AS last_attempt_at
      FROM hits h JOIN l1 ON l1.endpoint_id = h.id
      WHERE l1.delivered_30d >= 1
      ORDER BY l1.delivered_30d DESC, l1.last_delivered_at DESC, h.id
      LIMIT ${limit}`),
    db.execute(sql`
      WITH hits AS (${hits})
      SELECT h.id::text AS id, h.resource_url, left(h.description, 2000) AS description, h.price_amount, h.network
      FROM hits h
      WHERE NOT EXISTS (SELECT 1 FROM x402_l1_purchases pu WHERE pu.endpoint_id = h.id AND pu.status IN (${PAID_LIST}))
      ORDER BY h.id
      LIMIT ${FIND_UNTESTED_MAX}`),
  ]);
  const toFound = (r: Record<string, unknown>): FoundListing => ({
    observatoryId: String(r.id),
    url: String(r.resource_url),
    description: str(r.description),
    priceAmount: str(r.price_amount),
    network: str(r.network),
    delivered30d: Number(r.delivered_30d ?? 0),
    paidAttempts30d: Number(r.paid_attempts_30d ?? 0),
    lastAttemptAt: str(r.last_attempt_at),
  });
  return { fetchedAt, sellers: rowsOf(soldRaw).map(toFound), untested: rowsOf(untestedRaw).map(toFound) };
}
