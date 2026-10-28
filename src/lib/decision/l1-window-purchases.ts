// ============================================================
// loadSellerFacts と配達フィードが共有する L1 窓の購入行（2026-10-28 点検 H1）。
// 30 日・attempted_at DESC・200 行（署名前の行も 200 に数える）。列と PurchaseInput の組み立ては 1 本。
// ============================================================
import { sql, type SQL } from "drizzle-orm";
import type { getDb } from "@/lib/db/client";
import { recordRowKey } from "@/lib/sellers/board";
import type { RecordSides } from "@/lib/sellers/board";
import { L1_WINDOW_DAYS } from "./rules";
import type { PurchaseInput, SellerRowView } from "./seller-facts";

type Db = NonNullable<ReturnType<typeof getDb>>;

export const L1_WINDOW_PURCHASE_LIMIT = 200;

const WINDOW_INTERVAL = sql`(${L1_WINDOW_DAYS} * interval '1 day')`;

function parseL2Detail(v: unknown): PurchaseInput["l2Detail"] {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const missing = Array.isArray(o.missing) ? o.missing.filter((x): x is string => typeof x === "string") : [];
  return {
    missing,
    declarationHash: typeof o.declarationHash === "string" ? o.declarationHash : null,
    responseHash: typeof o.responseHash === "string" ? o.responseHash : "",
    reason: typeof o.reason === "string" ? o.reason : null,
  };
}

function sellerViewOfRow(r: Record<string, unknown>, sides: RecordSides | null | undefined): SellerRowView | null {
  if (!sides || typeof r.attempted_at_utc !== "string") return null;
  const shown = sides.rows.get(
    recordRowKey(r.attempted_at_utc, String(r.status), r.tx_hash === null || r.tx_hash === undefined ? null : String(r.tx_hash)),
  );
  return shown
    ? { bucket: shown.bucket, modeKey: shown.mode?.key ?? null, held: shown.held, money: shown.money, delivered: shown.bucket === "delivered" }
    : null;
}

/** DB 行 → PurchaseInput（loadSellerFacts と同じ。sellerView は readRecordSides から）。 */
export function purchaseInputFromL1WindowRow(r: Record<string, unknown>, sides: RecordSides | null | undefined): PurchaseInput {
  let authNonce: string | null = null;
  if (typeof r.auth_nonce === "string" && r.auth_nonce !== "") authNonce = r.auth_nonce;
  else if (r.has_nonce === true || r.has_nonce === "t") authNonce = "1";
  return {
    attemptedAt: String(r.attempted_at),
    status: String(r.status),
    latencyMs: r.latency_ms === null || r.latency_ms === undefined ? null : Number(r.latency_ms),
    httpStatusPaid: r.http_status_paid === null || r.http_status_paid === undefined ? null : Number(r.http_status_paid),
    payloadNonEmpty: r.payload_non_empty === null || r.payload_non_empty === undefined ? null : Boolean(r.payload_non_empty),
    l2Schema: r.l2_schema === null || r.l2_schema === undefined ? null : String(r.l2_schema),
    txHash: r.tx_hash === null || r.tx_hash === undefined ? null : String(r.tx_hash),
    network: r.network === null || r.network === undefined ? null : String(r.network),
    l2Detail: parseL2Detail(r.l2_detail),
    bodyHead: typeof r.body_head === "string" ? r.body_head : null,
    requestMeta:
      typeof r.request_meta === "object" && r.request_meta !== null && !Array.isArray(r.request_meta)
        ? (r.request_meta as Record<string, unknown>)
        : null,
    amountUnits: r.amount_units === null || r.amount_units === undefined ? null : String(r.amount_units),
    payer: r.payer === null || r.payer === undefined ? null : String(r.payer),
    settlementConfirmed: r.settlement_confirmed === null || r.settlement_confirmed === undefined ? null : Boolean(r.settlement_confirmed),
    sellerView: sellerViewOfRow(r, sides),
    authNonce,
    contentType: typeof r.content_type === "string" && r.content_type !== "" ? r.content_type : null,
  };
}

export async function fetchL1WindowPurchaseRows(db: Db, endpointId: string): Promise<Record<string, unknown>[]> {
  const raw = await db.execute(sql`
    SELECT attempted_at::text AS attempted_at, status, latency_ms, http_status_paid, payload_non_empty, l2_schema, tx_hash, network,
           to_char(attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS attempted_at_utc,
           CASE WHEN jsonb_typeof(raw_response_meta) = 'object' THEN left(raw_response_meta->>'contentType', 60) END AS content_type,
           raw_response_meta->'l2' AS l2_detail,
           CASE WHEN l2_schema = 'mismatch' AND jsonb_typeof(raw_response_meta) = 'object' THEN left(raw_response_meta->>'bodyHead', 500) END AS body_head,
           CASE WHEN jsonb_typeof(raw_response_meta) = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
             'requestBody', CASE WHEN raw_response_meta ? 'requestBody' THEN
               CASE WHEN jsonb_typeof(raw_response_meta->'requestBody') = 'string' THEN to_jsonb(left(raw_response_meta->>'requestBody', 16)) ELSE 'true'::jsonb END END,
             'requestQuery', raw_response_meta->'requestQuery')) END AS request_meta,
           amount_units, payer, left(auth_nonce, 80) AS auth_nonce,
           CASE WHEN status = 'settle_failed' AND tx_hash IS NOT NULL THEN
             (settlement_verified IS TRUE OR EXISTS (SELECT 1 FROM settlements s WHERE s.tx_hash IN (p.tx_hash, lower(p.tx_hash))))
           END AS settlement_confirmed
    FROM x402_l1_purchases p WHERE endpoint_id = ${endpointId}::uuid AND attempted_at > now() - ${WINDOW_INTERVAL}
    ORDER BY attempted_at DESC LIMIT ${L1_WINDOW_PURCHASE_LIMIT}
  `);
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}

/** フィード用: 複数出品の窓内 200 行（endpoint_id 付き・1 本の JOIN）。 */
export function l1WindowPurchasesFeedJoinSql(activeEpSubquery: SQL): SQL {
  return sql`
    SELECT pu.endpoint_id::text AS endpoint_id,
           pu.attempted_at::text AS attempted_at, pu.status, pu.latency_ms, pu.http_status_paid, pu.payload_non_empty,
           pu.l2_schema, pu.tx_hash, pu.network,
           to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS attempted_at_utc,
           CASE WHEN jsonb_typeof(pu.raw_response_meta) = 'object' THEN left(pu.raw_response_meta->>'contentType', 60) END AS content_type,
           pu.raw_response_meta->'l2' AS l2_detail,
           CASE WHEN pu.l2_schema = 'mismatch' AND jsonb_typeof(pu.raw_response_meta) = 'object' THEN left(pu.raw_response_meta->>'bodyHead', 500) END AS body_head,
           CASE WHEN jsonb_typeof(pu.raw_response_meta) = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
             'requestBody', CASE WHEN pu.raw_response_meta ? 'requestBody' THEN
               CASE WHEN jsonb_typeof(pu.raw_response_meta->'requestBody') = 'string' THEN to_jsonb(left(pu.raw_response_meta->>'requestBody', 16)) ELSE 'true'::jsonb END END,
             'requestQuery', pu.raw_response_meta->'requestQuery')) END AS request_meta,
           pu.amount_units, pu.payer,
           (pu.auth_nonce IS NOT NULL AND pu.auth_nonce <> '') AS has_nonce,
           CASE WHEN pu.status = 'settle_failed' AND pu.tx_hash IS NOT NULL THEN
             (pu.settlement_verified IS TRUE OR EXISTS (SELECT 1 FROM settlements s WHERE s.tx_hash IN (pu.tx_hash, lower(pu.tx_hash))))
           END AS settlement_confirmed
    FROM (
      SELECT pu.endpoint_id, pu.attempted_at, pu.status, pu.latency_ms, pu.http_status_paid, pu.payload_non_empty,
             pu.l2_schema, pu.tx_hash, pu.network, pu.amount_units, pu.payer, pu.auth_nonce,
             pu.settlement_verified, pu.raw_response_meta,
             row_number() OVER (PARTITION BY pu.endpoint_id ORDER BY pu.attempted_at DESC) AS rn
      FROM x402_l1_purchases pu
      INNER JOIN (${activeEpSubquery}) ep ON ep.id = pu.endpoint_id
      WHERE pu.attempted_at > now() - ${WINDOW_INTERVAL}
    ) pu
    WHERE pu.rn <= ${L1_WINDOW_PURCHASE_LIMIT}
  `;
}
