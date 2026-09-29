// ============================================================
// /sellers の読み取り（読むだけ。支払い・プローブ・書き込みをしない）。
//
// 1 回の頁の描画で走る問い合わせは軽いものに限る（鍵なしの公開面・Vercel に支出上限を置いていない）:
//   readSellerBoard   2 本。本番 READ ONLY の EXPLAIN ANALYZE（2026-09-28）で 37 ms と 88 ms。
//   readSellerDetail  2 本。1 ホストの出品と、その購入行（出品ごとに新しい 5 行まで）。
//   readPurchasedHosts      1 本。購入行のある host の集合（Base の出品が無い host を 404 にしないための関門）。
//   readSellerOtherChains   1 本。1 ホストの出品ごとの最新の購入行（チェーンを問わない）。
//   readSellerFailureDays   1 本（2026-09-29 第4巡）。seller の側の候補が最新・表示中にある出品だけ、その出品の
//                           署名済みの行を全部読み、候補の失敗の UTC の日付を返す（2 回確定の材料）。
//   readRecordSides         1 本（同）。記録頁とバッジ用。1 出品の購入行を全部読んで同じ語で分類する。
//   readSellerExport        3 本（2026-09-29 監査 5 周目）。/api/v1/sellers/export.csv 用。board と同じ形の問い合わせ。
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
  buildRecordSides,
  type RecordSides,
} from "./board";
import { EXAMPLE_DOMAIN_PATTERN, SIGNED_ROW_STATUSES, sellerCandidateDay, type ChallengeAcceptSummary, type SellerRowFacts } from "./fix-modes";
import { PATH_TEMPLATE_PG_REGEX } from "@/lib/observatory/path-template";
import { COOLDOWN_STATUSES, NON_SETTLING_COOLDOWN_STREAK, type NextBuyFacts } from "./next-buy";
import { buildSellerExportRows, type SellerExportRow, type SellerListingRef } from "./export";
import { BASE_NETWORKS, sellerHostSql } from "./host";
import { DELIVERED_HTTP_MAX, DELIVERED_HTTP_MIN } from "@/lib/observatory/delivery";

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

/**
 * 2026-09-29 監査 6 周目（中）: 出品の宣言の入力に、値の全体が例示用のドメインの文字列があるか（fix-modes.ts の
 * EXAMPLE_DOMAIN_PATTERN・JS と同じ文字列を Postgres の ~* に渡す）。見るのはカタログのスキーマの input の下
 * （見本値・既定値）と、raw_accepts の input の下（v1 の outputSchema.input の見本値）と、出品の URL。値そのものは返さない。
 */
const EXAMPLE_INPUT = sql`(
    EXISTS (SELECT 1 FROM jsonb_path_query(coalesce(e.declared_schema #> '{properties,input}', 'null'::jsonb), 'strict $.**') v
            WHERE jsonb_typeof(v) = 'string' AND length(v #>> '{}') <= 2048 AND (v #>> '{}') ~* ${EXAMPLE_DOMAIN_PATTERN})
    OR EXISTS (SELECT 1 FROM jsonb_path_query(CASE WHEN jsonb_typeof(e.raw_accepts) = 'array' THEN e.raw_accepts ELSE 'null'::jsonb END, 'strict $.**.input.**') v
            WHERE jsonb_typeof(v) = 'string' AND length(v #>> '{}') <= 2048 AND (v #>> '{}') ~* ${EXAMPLE_DOMAIN_PATTERN})
    OR EXISTS (SELECT 1 FROM regexp_split_to_table(coalesce(substring(e.resource_url from '[?]([^#]*)'), ''), '&') q
            WHERE (split_part(q, '=', 2)) ~* ${EXAMPLE_DOMAIN_PATTERN}))`;

/** 列の共通部分: 分類に要る事実だけ（本文・応答の中身は読まない）。example_input を除く（下の ROW_COLUMNS が足す）。 */
const ROW_COLUMNS_BASE = sql`
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
  to_char(pu.settlement_verified_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS settlement_verified_at,
  pu.amount_units, pu.pay_to, pu.asset, pu.payer,
  ${LISTING_MAX_TIMEOUT} AS listing_max_timeout,
  ${DECLARES_HEADERS} AS declares_headers,
  ${PATH_TEMPLATE} AS path_template,
  ${CHALLENGE_MIN} AS challenge_min,
  CASE WHEN jsonb_typeof(pu.raw_response_meta) = 'object' THEN left(pu.raw_response_meta->>'declaredAmount', 30) END AS declared_amount,
  CASE WHEN jsonb_typeof(pu.raw_response_meta) = 'object' THEN left(pu.raw_response_meta->>'declaredPayTo', 100) END AS declared_pay_to,
  left(pu.auth_nonce, 80) AS auth_nonce,
  CASE WHEN jsonb_typeof(pu.raw_response_meta) = 'object' AND pu.raw_response_meta->>'phase' = 'paid'
       THEN left(pu.raw_response_meta->>'contentType', 60) END AS paid_content_type,
  coalesce(jsonb_typeof(pu.raw_settlement) = 'object', false) AS receipt_present,
  CASE WHEN jsonb_typeof(pu.raw_settlement->'success') = 'boolean' THEN (pu.raw_settlement->>'success')::boolean END AS receipt_success,
  CASE WHEN jsonb_typeof(pu.raw_settlement) = 'object' THEN left(pu.raw_settlement->>'errorReason', 60) END AS receipt_error_reason`;

/** 行の列（ROW_COLUMNS_BASE と example_input）。行の少ない問い合わせ用。 */
const ROW_COLUMNS = sql`${ROW_COLUMNS_BASE},
  ${EXAMPLE_INPUT} AS example_input`;

/**
 * 出品ごとに 1 行を選ぶ問い合わせ（DISTINCT ON）の外側で example_input を足す。DISTINCT ON の中で当てると全部の行に
 * jsonpath が走る（本番 2026-09-29 の EXPLAIN ANALYZE: 38 ms → 745 ms）。外側なら選んだ行（出品の数）だけ。
 */
function withExampleInput(inner: ReturnType<typeof sql>) {
  return sql`SELECT x.*, (SELECT ${EXAMPLE_INPUT} FROM x402_endpoints e WHERE e.id = x.endpoint_id::uuid) AS example_input FROM (${inner}) x`;
}

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
    verifiedAt: str(r.settlement_verified_at),
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
    authNonce: str(r.auth_nonce),
    paidContentType: str(r.paid_content_type),
    receiptPresent: typeof r.receipt_present === "boolean" ? r.receipt_present : null,
    receiptSuccess: typeof r.receipt_success === "boolean" ? r.receipt_success : null,
    receiptErrorReason: str(r.receipt_error_reason),
    exampleInput: typeof r.example_input === "boolean" ? r.example_input : null,
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
  const latestRaw = await db.execute(
    withExampleInput(sql`
    SELECT DISTINCT ON (pu.endpoint_id) ${HOST_SQL} AS host, ${ROW_COLUMNS_BASE}
    FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE ${BASE_LISTING} AND ${BASE_ROW}
    ORDER BY pu.endpoint_id, pu.attempted_at DESC, pu.id DESC`),
  );
  const hosts = rowsOf(hostsRaw).map((r) => ({ host: String(r.host), listings: Number(r.listings) }));
  const latest: LatestRow[] = rowsOf(latestRaw).map((r) => ({ ...toRowFacts(r), host: String(r.host) }));
  const days = await readSellerFailureDays(db, latest.filter((r) => sellerCandidateDay(r) !== null).map((r) => r.endpointId));
  return buildSellerBoard(hosts, latest, fetchedAt, await readRetestQueue(db, retestEnabled), days);
}

/**
 * /api/v1/sellers/export.csv（2026-09-29 監査 5 周目）: Base の掲載中の出品すべてと、その最新の購入行（row id 付き）と、
 * readSellerBoard と同じ「候補の失敗の日付」。分類は export.ts（board と同じ関数）が行う。問い合わせは board と同じ形の 3 本。
 */
export async function readSellerExport(db: Db): Promise<{ fetchedAt: string; rows: SellerExportRow[] }> {
  const fetchedAt = new Date().toISOString();
  const listingsRaw = await db.execute(sql`
    SELECT e.id::text AS endpoint_id, e.resource_key, ${HOST_SQL} AS host
    FROM x402_endpoints e
    WHERE ${BASE_LISTING}`);
  const latestRaw = await db.execute(
    withExampleInput(sql`
    SELECT DISTINCT ON (pu.endpoint_id) ${HOST_SQL} AS host, ${ROW_COLUMNS_BASE}, pu.id::text AS row_id
    FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE ${BASE_LISTING} AND ${BASE_ROW}
    ORDER BY pu.endpoint_id, pu.attempted_at DESC, pu.id DESC`),
  );
  const listings: SellerListingRef[] = rowsOf(listingsRaw).map((r) => ({
    endpointId: String(r.endpoint_id),
    resourceKey: String(r.resource_key),
    host: String(r.host),
  }));
  const latest = rowsOf(latestRaw).map((r) => ({ ...toRowFacts(r), host: String(r.host), rowId: String(r.row_id) }));
  const days = await readSellerFailureDays(db, latest.filter((r) => sellerCandidateDay(r) !== null).map((r) => r.endpointId));
  return { fetchedAt, rows: buildSellerExportRows(listings, latest, days) };
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

/**
 * 次に買う目安の材料（next-buy.ts・2026-09-29 第6巡）。l1-runner の候補 SQL と同じ読み方: 窓は status・チェーンを問わない
 * 最新の購入行、成熟は settled の数、冷却は署名後の status（COOLDOWN_STATUSES）の新しい 3 件、L0 は最新のプローブ。
 */
const COOLDOWN_LIST = sql.join(COOLDOWN_STATUSES.map((st) => sql`${st}`), sql`, `);
const NEXT_BUY_COLUMNS = sql`
           (SELECT to_char(max(np.attempted_at) AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
              FROM x402_l1_purchases np WHERE np.endpoint_id = e.id) AS nb_last_attempt,
           (SELECT count(*)::int FROM x402_l1_purchases ns WHERE ns.endpoint_id = e.id AND ns.status = 'settled') AS nb_settled,
           (SELECT count(*) = ${NON_SETTLING_COOLDOWN_STREAK} AND count(*) FILTER (WHERE rc.status IN ('settled', 'settle_claimed')) = 0
              FROM (SELECT nc.status FROM x402_l1_purchases nc
                    WHERE nc.endpoint_id = e.id AND nc.status IN (${COOLDOWN_LIST})
                    ORDER BY nc.attempted_at DESC LIMIT ${NON_SETTLING_COOLDOWN_STREAK}) rc) AS nb_cooldown,
           (SELECT lp.verdict FROM x402_l0_probes lp WHERE lp.endpoint_id = e.id ORDER BY lp.probed_at DESC LIMIT 1) AS nb_l0`;

function nextBuyFactsOf(r: Record<string, unknown>): NextBuyFacts | null {
  if (typeof r.nb_cooldown !== "boolean") return null;
  return {
    lastAttemptAnyAt: str(r.nb_last_attempt),
    settledCount: toInt(r.nb_settled) ?? 0,
    cooldown: r.nb_cooldown,
    latestL0Verdict: str(r.nb_l0),
  };
}

/** その売り手の Base の出品が無ければ null。host は parseSellerHostParam を通した値。 */
export async function readSellerDetail(db: Db, host: string): Promise<SellerDetail | null> {
  const fetchedAt = new Date().toISOString();
  const epRaw = await db.execute(sql`
    SELECT e.id::text AS endpoint_id, e.resource_key, e.resource_url, e.method, e.price_amount,
           CASE WHEN e.resource_id ~ '^[0-9a-f]{64}$' THEN e.resource_id END AS resource_id,
           ${NEXT_BUY_COLUMNS}
    FROM x402_endpoints e
    WHERE ${BASE_LISTING} AND ${HOST_SQL} = ${host}`);
  const endpoints: SellerEndpointFacts[] = rowsOf(epRaw).map((r) => ({
    endpointId: String(r.endpoint_id),
    resourceKey: String(r.resource_key),
    resourceUrl: String(r.resource_url),
    method: str(r.method),
    priceAmount: str(r.price_amount),
    resourceId: str(r.resource_id),
    nextBuyFacts: nextBuyFactsOf(r),
  }));
  if (endpoints.length === 0) return null;
  const ids = JSON.stringify(endpoints.map((e) => e.endpointId));
  const rowsRaw = await db.execute(
    withExampleInput(sql`
    SELECT * FROM (
      SELECT ${ROW_COLUMNS_BASE},
             row_number() OVER (PARTITION BY pu.endpoint_id ORDER BY pu.attempted_at DESC, pu.id DESC) AS rn
      FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
      WHERE pu.endpoint_id IN (SELECT (jsonb_array_elements_text(${ids}::jsonb))::uuid) AND ${BASE_ROW}
    ) t
    WHERE t.rn <= ${1 + EARLIER_ROWS_SHOWN}`),
  );
  const rows = rowsOf(rowsRaw).map(toRowFacts);
  const days = await readSellerFailureDays(db, rows.filter((r) => sellerCandidateDay(r) !== null).map((r) => r.endpointId));
  return buildSellerDetail(host, endpoints, rows, fetchedAt, days);
}

const SIGNED_LIST = [...SIGNED_ROW_STATUSES];

/**
 * 出品ごとの、seller の側の候補になった失敗の UTC の日付（2026-09-29 第4巡・2 回確定の材料）。
 * 候補が 1 つも無い出品は問い合わせない（呼び手が候補のある出品だけを渡す）。Base の出品の Base の行だけを見る
 * （頁の数え方と同じ）。署名していない行は候補にならないので読まない。
 */
export async function readSellerFailureDays(db: Db, endpointIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const unique = [...new Set(endpointIds)];
  if (unique.length === 0) return out;
  const ids = JSON.stringify(unique);
  const raw = await db.execute(sql`
    SELECT ${ROW_COLUMNS}
    FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE pu.endpoint_id IN (SELECT (jsonb_array_elements_text(${ids}::jsonb))::uuid) AND ${BASE_ROW}
      AND pu.status IN (${sql.join(SIGNED_LIST.map((st) => sql`${st}`), sql`, `)})`);
  for (const r of rowsOf(raw).map(toRowFacts)) {
    const day = sellerCandidateDay(r);
    if (day === null) continue;
    const set = out.get(r.endpointId) ?? new Set<string>();
    set.add(day);
    out.set(r.endpointId, set);
  }
  return out;
}

/**
 * 記録頁（/observatory/e/[id]）とそのバッジ用: 1 出品の購入行を全部（チェーンを問わない）読み、売り手頁と同じ語で
 * 分類する（board.ts の buildRecordSides）。行が無ければ空。
 */
export async function readRecordSides(db: Db, endpointId: string): Promise<RecordSides> {
  const raw = await db.execute(sql`
    SELECT ${ROW_COLUMNS}, pu.id::text AS row_id
    FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE pu.endpoint_id = ${endpointId}::uuid
    ORDER BY pu.attempted_at DESC, pu.id DESC`);
  return buildRecordSides(rowsOf(raw).map(toRowFacts));
}

/**
 * 届かなかった購入行（delivered 以外）を 1 つでも持つ出品の id（2026-09-29 第5巡）。sitemap-observatory.xml は
 * これを外す（記録頁の noindex と同じ条件・board.ts の RecordSides.undelivered）。delivered は delivery.ts の isDelivered
 * （settled かつ HTTP が 2xx）と同じ述語で、HTTP が NULL の行は届かなかった側に入る。本番 2026-09-29: 約 4,100 件・7 ms。
 */
export async function readEndpointsWithUndeliveredL1(db: Db): Promise<Set<string>> {
  const raw = await db.execute(sql`
    SELECT DISTINCT pu.endpoint_id::text AS endpoint_id
    FROM x402_l1_purchases pu
    WHERE NOT (pu.status = 'settled'
               AND coalesce(pu.http_status_paid BETWEEN ${DELIVERED_HTTP_MIN} AND ${DELIVERED_HTTP_MAX}, false))`);
  return new Set(rowsOf(raw).map((r) => String(r.endpoint_id)));
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
  const raw = await db.execute(
    withExampleInput(sql`
    SELECT DISTINCT ON (pu.endpoint_id) ${ROW_COLUMNS_BASE}, e.resource_key, e.network AS catalog_network
    FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
    WHERE ${HOST_SQL} = ${host}
    ORDER BY pu.endpoint_id, pu.attempted_at DESC, pu.id DESC`),
  );
  const rows = rowsOf(raw).map((r) => ({
    resourceKey: String(r.resource_key),
    catalogNetwork: str(r.catalog_network),
    facts: toRowFacts(r),
  }));
  return buildSellerOtherChains(host, rows, fetchedAt);
}
