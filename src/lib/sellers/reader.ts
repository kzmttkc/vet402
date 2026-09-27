// ============================================================
// /sellers の読み取り（読むだけ。支払い・プローブ・書き込みをしない）。
//
// 1 回の頁の描画で走る問い合わせは軽いものに限る（鍵なしの公開面・Vercel に支出上限を置いていない）:
//   readSellerBoard   2 本。本番 READ ONLY の EXPLAIN ANALYZE（2026-09-28）で 37 ms と 88 ms。
//   readSellerDetail  2 本。1 ホストの出品と、その購入行（出品ごとに新しい 5 行まで）。
// 頁はさらに cached.ts（Data Cache・PUBLIC_READ_REVALIDATE 秒）を通して読む。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { buildSellerBoard, buildSellerDetail, EARLIER_ROWS_SHOWN, type LatestRow, type SellerBoard, type SellerDetail, type SellerEndpointFacts } from "./board";
import type { SellerRowFacts } from "./fix-modes";
import { BASE_NETWORKS, sellerHostSql } from "./host";

type Db = NonNullable<ReturnType<typeof getDb>>;

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}

const HOST_SQL = sellerHostSql(sql`e.resource_key`);
const [BASE_A, BASE_B] = BASE_NETWORKS;

/** 列の共通部分: 分類に要る事実だけ（本文・応答の中身は読まない）。 */
const ROW_COLUMNS = sql`
  pu.endpoint_id::text AS endpoint_id,
  pu.status,
  pu.http_status_paid,
  pu.tx_hash,
  to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS attempted_at,
  pu.network,
  e.method,
  (jsonb_typeof(e.declared_schema #> '{properties,input,properties,body}') = 'object') AS declares_body,
  coalesce(jsonb_typeof(pu.raw_response_meta) = 'object' AND pu.raw_response_meta ? 'requestBody', false) AS body_recorded,
  CASE WHEN jsonb_typeof(pu.raw_response_meta) = 'object' AND (pu.raw_response_meta->>'status') ~ '^[0-9]{3}$'
       THEN (pu.raw_response_meta->>'status')::int END AS unpaid_status,
  CASE WHEN jsonb_typeof(pu.raw_response_meta) = 'object' THEN pu.raw_response_meta->>'selection' END AS selection`;

/** Base の出品（active・代表 network が Base）。 */
const BASE_LISTING = sql`e.status = 'active' AND e.network IN (${BASE_A}, ${BASE_B})`;
/** その出品の Base の行と、network の無い行（支払い前に止まった行）。他のチェーンで買った行は入れない。 */
const BASE_ROW = sql`coalesce(pu.network, '') IN (${BASE_A}, ${BASE_B}, '')`;

function toInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

export function toRowFacts(r: Record<string, unknown>): SellerRowFacts {
  return {
    endpointId: String(r.endpoint_id),
    status: String(r.status),
    httpStatusPaid: toInt(r.http_status_paid),
    txHash: str(r.tx_hash),
    attemptedAt: String(r.attempted_at),
    network: str(r.network),
    method: str(r.method),
    declaresBody: r.declares_body === true || r.declares_body === "t",
    bodyRecorded: r.body_recorded === true || r.body_recorded === "t",
    unpaidStatus: toInt(r.unpaid_status),
    selection: str(r.selection),
  };
}

export async function readSellerBoard(db: Db): Promise<SellerBoard> {
  const fetchedAt = new Date().toISOString();
  const hostsRaw = await db.execute(sql`
    SELECT ${HOST_SQL} AS host, count(*)::int AS listings
    FROM x402_endpoints e
    WHERE ${BASE_LISTING}
    GROUP BY 1`);
  const latestRaw = await db.execute(sql`
    SELECT DISTINCT ON (pu.endpoint_id) ${HOST_SQL} AS host, ${ROW_COLUMNS}
    FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE ${BASE_LISTING} AND ${BASE_ROW}
    ORDER BY pu.endpoint_id, pu.attempted_at DESC, pu.id DESC`);
  const hosts = rowsOf(hostsRaw).map((r) => ({ host: String(r.host), listings: Number(r.listings) }));
  const latest: LatestRow[] = rowsOf(latestRaw).map((r) => ({ ...toRowFacts(r), host: String(r.host) }));
  return buildSellerBoard(hosts, latest, fetchedAt);
}

/** その売り手の Base の出品が無ければ null。host は parseSellerHostParam を通した値。 */
export async function readSellerDetail(db: Db, host: string): Promise<SellerDetail | null> {
  const fetchedAt = new Date().toISOString();
  const epRaw = await db.execute(sql`
    SELECT e.id::text AS endpoint_id, e.resource_key, e.resource_url, e.method, e.price_amount
    FROM x402_endpoints e
    WHERE ${BASE_LISTING} AND ${HOST_SQL} = ${host}`);
  const endpoints: SellerEndpointFacts[] = rowsOf(epRaw).map((r) => ({
    endpointId: String(r.endpoint_id),
    resourceKey: String(r.resource_key),
    resourceUrl: String(r.resource_url),
    method: str(r.method),
    priceAmount: str(r.price_amount),
  }));
  if (endpoints.length === 0) return null;
  const ids = JSON.stringify(endpoints.map((e) => e.endpointId));
  const rowsRaw = await db.execute(sql`
    SELECT * FROM (
      SELECT ${ROW_COLUMNS},
             row_number() OVER (PARTITION BY pu.endpoint_id ORDER BY pu.attempted_at DESC, pu.id DESC) AS rn
      FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
      WHERE pu.endpoint_id IN (SELECT (jsonb_array_elements_text(${ids}::jsonb))::uuid) AND ${BASE_ROW}
    ) t
    WHERE t.rn <= ${1 + EARLIER_ROWS_SHOWN}`);
  return buildSellerDetail(host, endpoints, rowsOf(rowsRaw).map(toRowFacts), fetchedAt);
}
