// ============================================================
// /sellers の読み取り（読むだけ。支払い・プローブ・書き込みをしない）。
//
// 1 回の頁の描画で走る問い合わせは軽いものに限る（鍵なしの公開面・Vercel に支出上限を置いていない）:
//   readSellerBoard   2 本。本番 READ ONLY の EXPLAIN ANALYZE（2026-09-28）で 37 ms と 88 ms。
//   readSellerDetail  2 本。1 ホストの出品と、その購入行（出品ごとに新しい 5 行まで）。
//   readPurchasedHosts      1 本。購入行のある host の集合（Base の出品が無い host を 404 にしないための関門）。
//   readSellerOtherChains   1 本。1 ホストの出品ごとの最新の購入行（チェーンを問わない）。
// 頁はさらに cached.ts（Data Cache・PUBLIC_READ_REVALIDATE 秒）を通して読む。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isCensusEnabled } from "@/lib/observatory/budget";
import { RETEST_SELLERS_SQL } from "@/lib/observatory/retest-sellers-sql";
import {
  buildSellerBoard,
  buildSellerDetail,
  buildSellerOtherChains,
  EARLIER_ROWS_SHOWN,
  type LatestRow,
  type RetestQueue,
  type SellerBoard,
  type SellerDetail,
  type SellerEndpointFacts,
  type SellerOtherChains,
} from "./board";
import type { ChallengeAcceptSummary, SellerRowFacts } from "./fix-modes";
import { PATH_TEMPLATE_PG_REGEX } from "@/lib/observatory/path-template";
import { BASE_NETWORKS, sellerHostSql } from "./host";

type Db = NonNullable<ReturnType<typeof getDb>>;

function rowsOf(raw: unknown): Record<string, unknown>[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
}

const HOST_SQL = sellerHostSql(sql`e.resource_key`);
const [BASE_A, BASE_B] = BASE_NETWORKS;

/**
 * 共有の判定（request-body.ts の bodyNotSentOnOurSide・request-query.ts の queryNotSentOnOurSide）が読む
 * 部分だけを DB で間引いて返す。スキーマは body がオブジェクトか（中身は捨てる）と queryParams.required、
 * メタは requestBody の有無と requestQuery の値。売り手の書いたスキーマ全体をキャッシュに載せない。
 * 宣言の要約（declared_input・2026-09-29）は `{query, body}` の 2 語だけなのでそのまま読む。
 */
const SCHEMA_MIN = sql.raw(`CASE WHEN jsonb_typeof(e.declared_schema) = 'object' THEN jsonb_build_object('properties', jsonb_build_object('input', jsonb_build_object('properties', jsonb_strip_nulls(jsonb_build_object(
    'body', CASE WHEN jsonb_typeof(e.declared_schema #> '{properties,input,properties,body}') = 'object' THEN '{}'::jsonb END,
    'queryParams', CASE WHEN jsonb_typeof(e.declared_schema #> '{properties,input,properties,queryParams}') = 'object'
                        THEN jsonb_strip_nulls(jsonb_build_object('required', e.declared_schema #> '{properties,input,properties,queryParams,required}')) END))))) END`);
// 2026-09-29 第2巡: requestBody は有無だけでなく値（declared / empty / none）も読む（(d) の根拠）。値は runner が書く短い語。
const META_MIN = sql.raw(`CASE WHEN jsonb_typeof(pu.raw_response_meta) = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
    'requestBody', CASE WHEN pu.raw_response_meta ? 'requestBody' THEN
      CASE WHEN jsonb_typeof(pu.raw_response_meta->'requestBody') = 'string' THEN to_jsonb(left(pu.raw_response_meta->>'requestBody', 16)) ELSE 'true'::jsonb END END,
    'requestQuery', CASE WHEN jsonb_typeof(pu.raw_response_meta->'requestQuery') = 'string' THEN to_jsonb(left(pu.raw_response_meta->>'requestQuery', 16)) END)) END`);

/**
 * 2026-09-29 第2巡: 出品の宣言のうち (d)(e) の根拠に要るものだけを DB で間引く。
 *   listing_max_timeout  raw_accepts のうち行の pay_to と同じ accept の maxTimeoutSeconds の最大値（無ければ null）
 *   declares_headers     スキーマが要求ヘッダを名前で宣言している（properties か required が空でない）
 *   path_template        URL に未置換のパスパラメータがある（path-template.ts の PATH_TEMPLATE_PG_REGEX）
 * 署名前に止まった行（phase select）の 402 の accept は要点だけ（先頭 4 件・文字列は短く切る）。
 */
const LISTING_MAX_TIMEOUT = sql.raw(`(SELECT max((a->>'maxTimeoutSeconds')::int)
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.raw_accepts) = 'array' THEN e.raw_accepts ELSE '[]'::jsonb END) a
      WHERE jsonb_typeof(a) = 'object' AND (a->>'maxTimeoutSeconds') ~ '^[0-9]{1,7}$'
        AND lower(coalesce(a->>'payTo', '')) = lower(coalesce(pu.pay_to, '')))`);
const DECLARES_HEADERS = sql.raw(`(coalesce(jsonb_typeof(e.declared_schema #> '{properties,input,properties,headers,properties}') = 'object'
        AND e.declared_schema #> '{properties,input,properties,headers,properties}' <> '{}'::jsonb, false)
      OR coalesce(jsonb_typeof(e.declared_schema #> '{properties,input,properties,headers,required}') = 'array'
        AND jsonb_array_length(e.declared_schema #> '{properties,input,properties,headers,required}') > 0, false))`);
const PATH_TEMPLATE = sql.raw(`(split_part(e.resource_url, '?', 1) ~* '${PATH_TEMPLATE_PG_REGEX.replace(/'/g, "''")}')`);
const CHALLENGE_MIN = sql.raw(`CASE WHEN jsonb_typeof(pu.raw_response_meta->'challengeAccepts') = 'array' THEN (
      SELECT jsonb_agg(jsonb_build_object(
        'scheme', left(a->>'scheme', 24), 'network', left(a->>'network', 40),
        'amount', left(coalesce(a->>'amount', a->>'maxAmountRequired'), 30), 'asset', left(a->>'asset', 100),
        'payTo', left(a->>'payTo', 100),
        'maxTimeoutSeconds', CASE WHEN (a->>'maxTimeoutSeconds') ~ '^[0-9]{1,7}$' THEN (a->>'maxTimeoutSeconds')::int END))
      FROM (SELECT a FROM jsonb_array_elements(pu.raw_response_meta->'challengeAccepts') a WHERE jsonb_typeof(a) = 'object' LIMIT 4) x) END`);

/** 列の共通部分: 分類に要る事実だけ（本文・応答の中身は読まない）。 */
const ROW_COLUMNS = sql`
  pu.endpoint_id::text AS endpoint_id,
  pu.status,
  pu.http_status_paid,
  pu.tx_hash,
  to_char(pu.attempted_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS attempted_at,
  pu.network,
  e.method,
  ${SCHEMA_MIN} AS schema_min,
  e.declared_input AS declared_input,
  ${META_MIN} AS meta_min,
  CASE WHEN jsonb_typeof(pu.raw_response_meta) = 'object' AND (pu.raw_response_meta->>'status') ~ '^[0-9]{3}$'
       THEN (pu.raw_response_meta->>'status')::int END AS unpaid_status,
  CASE WHEN jsonb_typeof(pu.raw_response_meta) = 'object' THEN pu.raw_response_meta->>'selection' END AS selection,
  pu.settlement_verify_reason,
  pu.amount_units, pu.pay_to, pu.asset, pu.payer,
  ${LISTING_MAX_TIMEOUT} AS listing_max_timeout,
  ${DECLARES_HEADERS} AS declares_headers,
  ${PATH_TEMPLATE} AS path_template,
  ${CHALLENGE_MIN} AS challenge_min,
  CASE WHEN jsonb_typeof(pu.raw_response_meta) = 'object' THEN left(pu.raw_response_meta->>'declaredAmount', 30) END AS declared_amount,
  CASE WHEN jsonb_typeof(pu.raw_response_meta) = 'object' THEN left(pu.raw_response_meta->>'declaredPayTo', 100) END AS declared_pay_to`;

/** Base の出品（active・代表 network が Base）。 */
const BASE_LISTING = sql`e.status = 'active' AND e.network IN (${BASE_A}, ${BASE_B})`;
/** その出品の Base の行と、network の無い行（支払い前に止まった行）。他のチェーンで買った行は入れない。 */
const BASE_ROW = sql`coalesce(pu.network, '') IN (${BASE_A}, ${BASE_B}, '')`;

function toInt(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) ? n : null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  const x = typeof v === "string" ? safeJson(v) : v;
  return typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function safeJson(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
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
    meta: asRecord(r.meta_min),
    schema: asRecord(r.schema_min),
    declaredInput: asRecord(r.declared_input),
    unpaidStatus: toInt(r.unpaid_status),
    selection: str(r.selection),
    verifyReason: str(r.settlement_verify_reason),
    amountUnits: str(r.amount_units),
    payTo: str(r.pay_to),
    asset: str(r.asset),
    payer: str(r.payer),
    listingMaxTimeoutSeconds: toInt(r.listing_max_timeout),
    declaresHeaders: typeof r.declares_headers === "boolean" ? r.declares_headers : null,
    pathTemplate: typeof r.path_template === "boolean" ? r.path_template : null,
    challenge: challengeOf(r.challenge_min),
    declaredAmount: str(r.declared_amount),
    declaredPayTo: str(r.declared_pay_to),
  };
}

function challengeOf(v: unknown): ChallengeAcceptSummary[] | null {
  const x = typeof v === "string" ? safeJson(v) : v;
  if (!Array.isArray(x)) return null;
  return x
    .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null && !Array.isArray(a))
    .slice(0, 4)
    .map((a) => ({
      scheme: str(a.scheme),
      network: str(a.network),
      amount: str(a.amount),
      asset: str(a.asset),
      payTo: str(a.payTo),
      maxTimeoutSeconds: toInt(a.maxTimeoutSeconds),
    }));
}

/**
 * retest が次に買い直す売り手（l1-runner の RETEST_SELLERS_SQL をそのまま流す・ホスト → その最新の行の
 * endpoint_id）。旗 OBSERVATORY_L1_CENSUS が on でなければ問い合わせもせず null（＝頁は「eligible for a re-buy」と書かない）。
 * 読めなければ null（書かない側に倒す）。
 */
export async function readRetestQueue(db: Db, enabled: boolean = isCensusEnabled()): Promise<RetestQueue | null> {
  if (!enabled) return null;
  try {
    const rows = rowsOf(await db.execute(RETEST_SELLERS_SQL));
    return new Map(rows.map((r) => [String(r.host), { endpointId: String(r.endpoint_id), reason: String(r.reason) }]));
  } catch {
    return null;
  }
}

export async function readSellerBoard(db: Db, retestEnabled: boolean = isCensusEnabled()): Promise<SellerBoard> {
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
  return buildSellerBoard(hosts, latest, fetchedAt, await readRetestQueue(db, retestEnabled));
}

/**
 * Base の出品の購入行を全部（読み取りだけ・件数の見積もりと監査の道具用。公開頁からは呼ばない）。
 * 列は頁と同じ ROW_COLUMNS なので、分類は頁と同じになる。
 */
export async function readAllBaseRows(db: Db): Promise<LatestRow[]> {
  const raw = await db.execute(sql`
    SELECT ${HOST_SQL} AS host, ${ROW_COLUMNS}, pu.id::text AS row_id
    FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE ${BASE_LISTING} AND ${BASE_ROW}
    ORDER BY pu.endpoint_id, pu.attempted_at DESC, pu.id DESC`);
  return rowsOf(raw).map((r) => ({ ...toRowFacts(r), host: String(r.host), rowId: String(r.row_id) }) as LatestRow);
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

/**
 * 購入行が 1 つでもある host の集合（チェーン・出品の状態を問わない）。頁はこれをキャッシュして持ち、
 * ここに無い host は host ごとの問い合わせを走らせずに 404 にする（でたらめな host に DB を読ませない）。
 */
export async function readPurchasedHosts(db: Db): Promise<string[]> {
  const raw = await db.execute(sql`
    SELECT DISTINCT ${HOST_SQL} AS host
    FROM x402_endpoints e
    WHERE EXISTS (SELECT 1 FROM x402_l1_purchases pu WHERE pu.endpoint_id = e.id)`);
  return rowsOf(raw)
    .map((r) => String(r.host))
    .sort();
}

/**
 * Base の出品が無い売り手の簡易頁（2026-09-29）。その host の出品ごとに最新の購入行を 1 行（チェーンを問わない）。
 * 購入行が無ければ null。host は parseSellerHostParam を通した値。
 */
export async function readSellerOtherChains(db: Db, host: string): Promise<SellerOtherChains | null> {
  const fetchedAt = new Date().toISOString();
  const raw = await db.execute(sql`
    SELECT DISTINCT ON (pu.endpoint_id) ${ROW_COLUMNS}, e.resource_key, e.network AS catalog_network
    FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE ${HOST_SQL} = ${host}
    ORDER BY pu.endpoint_id, pu.attempted_at DESC, pu.id DESC`);
  const rows = rowsOf(raw).map((r) => ({
    resourceKey: String(r.resource_key),
    catalogNetwork: str(r.catalog_network),
    facts: toRowFacts(r),
  }));
  return buildSellerOtherChains(host, rows, fetchedAt);
}
