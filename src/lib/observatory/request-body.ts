// ============================================================
// 有料の要求の本文（2026-09-20）— 何を送ったかを、公開できる最小限で言う。
//
// なぜ在るか。2026-09-17（Issue #29）から L1 は売り手の 402 が宣言した POST 本文で買う。
// 「導入の前後で同じ endpoint の有料 2xx 率がどう変わったか」を第三者が数え直すには、
// その行が宣言本文で買われたのかを公開 export が言えなければならない。
//
// 公開 export の列:
//   request_body         declared / empty / none。方法論 §2 が既に公開している語
//                        （"the row records requestBody: declared … requestBody: empty"）をそのまま使う。
//                        列名を request_shape にしなかったのは、その語が L0 の unverified の理由として
//                        既に公開語彙にあるため（vocabulary.ts・別の意味）。
//   request_body_sha256  declared の行の、**送ったバイト列**の SHA-256（小文字 hex 64 桁）。
//
// 何を出し、何を出さないか:
//   - 出す: 分類と hash。分類は数え直しに要る。hash は「売り手のいまの宣言と同じ本文か」「行の間で宣言が
//     変わったか」を、本文を受け取らずに確かめるためのもの（売り手の 402 の
//     `extensions.bazaar.info.input.body` を JSON.stringify して SHA-256 を取れば照合できる）。
//     切り詰めない: 先頭だけにしても隠せるものは無く（本文は売り手が無払いの 402 で公開している）、
//     照合の手順が 1 つ増えるだけ。
//   - 出さない: 本文そのもの。売り手が書いた文字列で、16KB まであり、vet402 が再配布するものではない。
//     読みたい人は売り手の 402 という一次情報を読める。
//
// 記録が無い行は null（CSV では空）。`empty` や `none` に倒さない:
//   - 2026-09-17 より前の行には記録が無い（方法論 §2 のとおり当時の有料 POST は全件 `{}` だが、
//     **行はメソッドを持っていない**ので、どの行が POST だったかを後から言えない。x402_endpoints.method は
//     いまの掲載の値で、購入時の値ではない——2026-09-20 の本番に「掲載は GET・行は declared」が 1 行ある）。
//   - POST 以外の行に "none" を書き始めたのは 2026-09-20。それより前の POST 以外の行も記録なし。
//   - 署名前に終わった行（no_402・no_eligible_accept・over_cap …）は有料の要求を出していない。
//   - hash を書き始めたのも 2026-09-20。それより前の declared の行は hash なし。
// 過去の行は遡って埋めない。
// ============================================================
import { createHash } from "node:crypto";
import type { DeclaredRequestBody } from "./declared-input";
import { declaredInputBodySql, declaredInputSendsBody } from "./declared-input-summary";

/** raw_response_meta.requestBody の語彙＝公開 export の request_body の値。 */
export const REQUEST_BODY_KINDS = ["declared", "empty", "none"] as const;
export type RequestBodyKind = (typeof REQUEST_BODY_KINDS)[number];

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export type RequestBodyRecord =
  | { requestBody: "declared"; requestBodySha256: string }
  | { requestBody: "empty" }
  | { requestBody: "none" };

/**
 * ランナーが行の raw_response_meta に残す形。`paid` は有料の POST に載せた本文
 * （declared-input.ts）、POST 以外は null。hash は**実際に送った文字列**から取る。
 */
export function requestBodyRecord(paid: DeclaredRequestBody | null): RequestBodyRecord {
  if (!paid) return { requestBody: "none" };
  if (paid.source === "declared") {
    return { requestBody: "declared", requestBodySha256: createHash("sha256").update(paid.body, "utf8").digest("hex") };
  }
  return { requestBody: "empty" };
}

function asMeta(meta: unknown): Record<string, unknown> | null {
  return typeof meta === "object" && meta !== null && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null;
}

/** 1 行の分類。記録が無い・知らない値なら null。 */
export function requestBodyKindOf(meta: unknown): RequestBodyKind | null {
  const v = asMeta(meta)?.requestBody;
  return typeof v === "string" && (REQUEST_BODY_KINDS as readonly string[]).includes(v) ? (v as RequestBodyKind) : null;
}

/** declared の行の SHA-256（小文字 hex 64 桁）。それ以外・記録なし・形が違えば null。 */
export function requestBodySha256Of(meta: unknown): string | null {
  const m = asMeta(meta);
  if (m?.requestBody !== "declared") return null;
  const h = m.requestBodySha256;
  return typeof h === "string" && SHA256_HEX_RE.test(h) ? h : null;
}

function assertAlias(fn: string, alias: string): string {
  if (alias !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`${fn}: alias must be a plain identifier, got ${JSON.stringify(alias)}`);
  }
  return alias === "" ? "" : `${alias}.`;
}

/** `requestBodyKindOf` と同じ規則の SQL 式（同じ配列から作る）。 */
export function requestBodyKindSql(alias = ""): string {
  const p = assertAlias("requestBodyKindSql", alias);
  const known = REQUEST_BODY_KINDS.map((k) => `'${k}'`).join(", ");
  // jsonb_typeof で string に限る: `->>` は true や 1 も文字列にして返すので、JS 側（typeof === "string"）と揃える。
  return (
    `CASE WHEN jsonb_typeof(${p}raw_response_meta->'requestBody') = 'string'` +
    ` AND ${p}raw_response_meta->>'requestBody' IN (${known})` +
    ` THEN ${p}raw_response_meta->>'requestBody' END`
  );
}

/** `requestBodySha256Of` と同じ規則の SQL 式。 */
export function requestBodySha256Sql(alias = ""): string {
  const p = assertAlias("requestBodySha256Sql", alias);
  return (
    `CASE WHEN jsonb_typeof(${p}raw_response_meta->'requestBody') = 'string'` +
    ` AND ${p}raw_response_meta->>'requestBody' = 'declared'` +
    ` AND jsonb_typeof(${p}raw_response_meta->'requestBodySha256') = 'string'` +
    ` AND ${p}raw_response_meta->>'requestBodySha256' ~ '^[0-9a-f]{64}$'` +
    ` THEN ${p}raw_response_meta->>'requestBodySha256' END`
  );
}

// ============================================================
// 「こちらが本文を送っていなかった」失敗の判定（2026-09-28・retest の (b) と /sellers の body_not_sent が共有）。
//
// 判定はここ 1 か所に置く。JS の述語と SQL の断片は組で、tests/request-not-sent.pg.test.ts が同じ行の集合に
// 両方を当てて一致を固定する。SQL の断片は delivery.ts と同じく文字列で返す（drizzle でも生 SQL でも使える）。
// 別名・式は呼び手のコードが決める識別子だけを受け付ける（利用者入力は通らない）。
// ============================================================

/**
 * 宣言された本文を送る実装（02fc857「POST the input body the seller's 402 declares」）が本番に出た時刻。
 *
 * 実測（2026-09-28）: GitHub の deployments で、02fc857 を含む最初の Production は 2b4a4ee0
 * （created_at / success 2026-09-16T23:25:55Z）。その直前の Production 09cd25de（23:05:58Z）は 02fc857 を
 * 含まない。台帳でも、POST の支払い付き行で raw_response_meta.requestBody を持たない最後の行は
 * 2026-09-16T18:02:09Z、持つ最初の行は 2026-09-17T00:01:01Z で、その間に POST の支払い付き行は 0。
 * この時刻より前の POST は、売り手が本文を宣言していても `{}` を送っていた。
 */
export const DECLARED_BODY_SENT_SINCE = "2026-09-16T23:25:55Z";

/**
 * 「送るべきものを送らなかった」失敗として数える、支払い付き要求への応答の HTTP ステータス。400 と 422
 * （`{}` を検証で 422 にする実装が多い・2026-09-28 レビュー）。401・403 は認可の話なので入れない。
 * クエリ（request-query.ts）はこの 2 つ。
 */
export const NOT_SENT_REFUSAL_HTTP = [400, 422] as const;

/**
 * 本文を送らなかった失敗として数える HTTP（2026-09-29）。上の 2 つに 415 Unsupported Media Type を足す:
 * form-data の本文を宣言する売り手は、こちらの `{}`（application/json）を型で断る
 * （2026-09-29 監査: api.neurodynamic.tech/v1/audio/transcriptions が file を宣言し、09-10 に 415）。
 */
export const BODY_NOT_SENT_REFUSAL_HTTP = [400, 415, 422] as const;

/** 判定に使う 1 行（x402_l1_purchases の行と、その出品の今のカタログの宣言）。 */
export type NotSentRowInput = {
  status: string | null;
  txHash: string | null;
  httpStatusPaid: number | null;
  /** Date、ISO8601、または Postgres の timestamptz::text。読めなければ判定しない（false）。 */
  attemptedAt: string | Date | null;
  rawResponseMeta: unknown;
  /** 行の network（CAIP-2 か v1 の slug）。 */
  network: string | null;
  /** 出品の宣言メソッド（x402_endpoints.method）。 */
  method: string | null;
  /** 出品の今のカタログのスキーマ（x402_endpoints.declared_schema）。 */
  declaredSchema: unknown;
  /**
   * 出品の今の宣言の要約（x402_endpoints.declared_input・送る規則を掲載に当てた結果・2026-09-29）。
   * 無い（NULL・未指定）ならスキーマだけで判定する。
   */
  declaredInput?: unknown;
};

const EXPR_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
/** SQL 断片に埋める列の式（`alias.column` か `column`）。それ以外は投げる。 */
export function assertSqlExpr(fn: string, expr: string): string {
  if (!EXPR_RE.test(expr)) throw new Error(`${fn}: expected a column reference like alias.column, got ${JSON.stringify(expr)}`);
  return expr;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** スキーマの properties.input.properties の下の 1 つ（無ければ undefined）。 */
export function declaredInputProperty(declaredSchema: unknown, name: string): unknown {
  return rec(rec(rec(rec(declaredSchema)?.properties)?.input)?.properties)?.[name];
}

function epochMs(v: string | Date | null): number | null {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/** 支払い付き要求が HTTP 400 / 422（codes）で断られ、決済されなかった（settle_failed・tx なし）。 */
export function refusedUnsettled(
  row: Pick<NotSentRowInput, "status" | "txHash" | "httpStatusPaid">,
  codes: readonly number[] = NOT_SENT_REFUSAL_HTTP,
): boolean {
  return (
    row.status === "settle_failed" &&
    (row.txHash === null || row.txHash === undefined) &&
    typeof row.httpStatusPaid === "number" &&
    codes.includes(row.httpStatusPaid)
  );
}

/** refusedUnsettled と同じ規則の SQL（別名は行の表）。 */
export function refusedUnsettledSql(rowAlias: string, codes: readonly number[] = NOT_SENT_REFUSAL_HTTP): string {
  const a = assertSqlExpr("refusedUnsettledSql", rowAlias);
  for (const c of codes) if (!Number.isInteger(c)) throw new Error("refusedUnsettledSql: codes must be integers");
  return `(${a}.status = 'settle_failed' AND ${a}.tx_hash IS NULL AND ${a}.http_status_paid IN (${codes.join(", ")}))`;
}

/** 今のカタログの出品が本文を宣言している（スキーマの properties.input.properties.body がオブジェクト）。 */
export function declaresRequestBody(declaredSchema: unknown): boolean {
  return rec(declaredInputProperty(declaredSchema, "body")) !== null;
}

/** declaresRequestBody と同じ規則の SQL（引数はスキーマの列の式・例 `e.declared_schema`）。 */
export function declaresRequestBodySql(schemaExpr: string): string {
  const x = assertSqlExpr("declaresRequestBodySql", schemaExpr);
  return `(jsonb_typeof(${x} #> '{properties,input,properties,body}') = 'object')`;
}

/**
 * 今の出品が本文を宣言している: スキーマが input.properties.body を持つ（従来）か、送る規則なら宣言の本文を送る
 * （declared_input.body = declared・2026-09-29。送る規則と同じ情報源）。
 */
export function declaresBodyForSending(row: Pick<NotSentRowInput, "declaredSchema" | "declaredInput">): boolean {
  return declaresRequestBody(row.declaredSchema) || declaredInputSendsBody(row.declaredInput);
}

/**
 * こちらが本文を送っていなかったための失敗（retest の (b)・/sellers の body_not_sent）:
 * POST・400/415/422 で未決済・DECLARED_BODY_SENT_SINCE より前・行に requestBody の記録が無い（`{}` を送った）・
 * 今の出品が本文を宣言している（declaresBodyForSending）。
 */
export function bodyNotSentOnOurSide(row: NotSentRowInput): boolean {
  if (!refusedUnsettled(row, BODY_NOT_SENT_REFUSAL_HTTP)) return false;
  const at = epochMs(row.attemptedAt);
  if (at === null || at >= Date.parse(DECLARED_BODY_SENT_SINCE)) return false;
  if ((row.method ?? "").toUpperCase() !== "POST") return false;
  const meta = rec(row.rawResponseMeta);
  if (meta !== null && "requestBody" in meta) return false;
  return declaresBodyForSending(row);
}

/**
 * bodyNotSentOnOurSide と同じ規則の SQL。`row` は購入行の別名、`method`・`schema`・`input` は出品の列の式
 * （`input` は declared_input。省略すればスキーマだけで判定する＝列の無い古い呼び手）。
 */
export function bodyNotSentOnOurSideSql(cols: { row: string; method: string; schema: string; input?: string }): string {
  const a = assertSqlExpr("bodyNotSentOnOurSideSql", cols.row);
  const m = assertSqlExpr("bodyNotSentOnOurSideSql", cols.method);
  const declares = cols.input
    ? `(${declaresRequestBodySql(cols.schema)} OR coalesce(${declaredInputBodySql(cols.input)}, false))`
    : declaresRequestBodySql(cols.schema);
  return (
    `(${refusedUnsettledSql(a, BODY_NOT_SENT_REFUSAL_HTTP)}` +
    ` AND ${a}.attempted_at < '${DECLARED_BODY_SENT_SINCE}'::timestamptz` +
    ` AND upper(coalesce(${m}, '')) = 'POST'` +
    ` AND NOT coalesce(${a}.raw_response_meta ? 'requestBody', false)` +
    ` AND ${declares})`
  );
}
