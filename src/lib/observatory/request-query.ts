// ============================================================
// 有料の要求のクエリ（2026-09-21）— どの URL で払ったかを、公開できる最小限で言う。
//
// 形は request-body.ts（2026-09-20 の request_body / request_body_sha256）を**そのまま踏襲**する。
// 違いは語彙が 3 つ（declared / empty / refused）であることだけ。
//
// なぜ在るか。2026-09-20 に L1 は売り手の 402 が宣言したクエリ（`extensions.bazaar.info.input.queryParams`）
// を支払い付き要求の URL に足せるようになった（declared-input.ts の declaredRequestUrl・既定 OFF・
// CAIP-2 の許可リスト `OBSERVATORY_L1_DECLARED_QUERY_NETWORKS`）。ところがラベルは行の
// raw_response_meta にしか無く、**公開面のどこにも出ていなかった**ので、
//   - 方法論に「どのチェーンで効いているかは台帳を見れば分かる」と書けず、
//   - 第三者は「宣言クエリで買った行」を数え直せなかった。
// 列を足してから ON にする（2026-09-21 依頼元の方針変更）。
//
// 公開 export の列:
//   request_query         declared / empty / refused。方法論 §2 が公開している語をそのまま使う。
//                         declared = 宣言の対を足した URL で払った
//                         empty    = 売り手が宣言していない（文書なし・queryParams なし・null・`{}`）
//                         refused  = 宣言は在ったが**我々の規則で使わなかった**（スカラーでない値・空の名前・
//                                    上限超・宣言名どうしの衝突・掲載名との衝突で足すものが残らなかった・URL を読めない）
//   request_query_sha256  declared の行の、**足した対だけの form-urlencoded 文字列**の SHA-256（小文字 hex 64 桁）。
//                         元の取り決め 5 条は declared-input.ts の DeclaredRequestUrl に逐語で置いてある。
//
// 何を出し、何を出さないか（本文側と同じ判断）:
//   - 出す: 分類と hash。分類は数え直しに要る。hash は「いま 402 を取り直して同じ文字列になるか」
//     「2 つの行が同じ要求だったか」を、文字列を受け取らずに確かめるためのもの。切り詰めない。
//   - 出さない: クエリ文字列そのもの。売り手が公開の 402 で宣言している一次情報で、vet402 が再配布しない。
//     **だからこの hash で出来るのは照合まで**で、行だけ持つ読者は何を送ったかを復元できない。
//
// 記録が無い行は null（CSV では空）。`empty` にも `refused` にも倒さない。空になるのは:
//   - 許可リストに載っていない network の行（既定はこれ。要求も行も 1 バイトも変わらない）
//   - Tempo（MPP）の行。x402 の文書を読まないので、許可リストに載せても対象外
//   - 署名前に終わった行（no_402・no_eligible_accept・budget_denied …）。有料の要求を出していない
//   - ラベルを書き始めた 2026-09-20 より前の行
//   この 4 つは**列だけでは区別できない**（openapi にそう書いてある。区別できるかのように読ませない）。
// 過去の行は遡って埋めない。
//
// 書く側はこの file に無い: ランナーが raw_response_meta に直接 `requestQuery` と
// `requestQuerySha256` を置いている（l1-runner.ts・2026-09-20 に main へ入った形）。
// 名前が動いたら export が黙って空になるので、tests/export-request-query.test.ts が
// 「ランナーがこの 2 つのキー名で書いている」を固定する。
// ============================================================
import type { RequestQuerySource } from "./declared-input";
import { assertSqlExpr, declaredInputProperty, refusedUnsettled, refusedUnsettledSql, type NotSentRowInput } from "./request-body";

/**
 * Base で、売り手が 402 で宣言したクエリ（input.queryParams）を支払い付き要求に足し始めた時刻（2026-09-28 実測）。
 *
 * 本番の env `OBSERVATORY_L1_DECLARED_QUERY_NETWORKS` に `eip155:8453,base` を足した（Vercel の env の createdAt
 * 2026-09-27T23:25:27Z）後、それを読む Production の再デプロイ（source cli・commit 4d210b1c・created 23:25:49Z）が
 * **ready になった時刻**。この時刻より前の Base の行は、売り手が queryParams を宣言していてもクエリを送っていない
 * （XRPL の xrpl:0 は 2026-09-21 から送っている——Base だけの境目）。台帳でも、Base の支払い付き行で
 * raw_response_meta.requestQuery を持つ行は 2026-09-28 時点でまだ 0 件（最後の Base の支払い付き行は
 * 2026-09-27T18:02:35Z で、キーを持たない）。
 *
 * 使う側（l1-runner の retest (c)・/sellers）はこの定数を import する。場所と名前を変えない。
 */
export const BASE_DECLARED_QUERY_SINCE = "2026-09-27T23:27:16Z";

/**
 * Base の有料の要求に、売り手の 402 が宣言したクエリ（queryParams）を足し始めた時刻（本番・オーナー承認済み）。
 * それまで Base は許可リスト（OBSERVATORY_L1_DECLARED_QUERY_NETWORKS）に入っておらず、本番の台帳で Base の
 * 行に requestQuery の記録は 0 件（2026-09-28 実測）。この時刻より前の Base の要求は、宣言クエリを載せていない。
 *
 * 仮置き（2026-09-28・/sellers）: retest の (c)（ブランチ census-query-0928）が同じ名前・同じ場所で定義する。
 * そちらが main に入ったら rebase で一本化する。/sellers（src/lib/sellers/fix-modes.ts の query_not_sent）は
 * ここから import する。
 */
export const BASE_DECLARED_QUERY_SINCE = "2026-09-27T23:27:16Z";

/** raw_response_meta.requestQuery の語彙＝公開 export の request_query の値。 */
export const REQUEST_QUERY_KINDS = ["declared", "empty", "refused"] as const;
export type RequestQueryKind = (typeof REQUEST_QUERY_KINDS)[number];

// 組み立て側（declared-input.ts の RequestQuerySource）と 1 文字でもずれたら、export が黙って
// 空を出す。型で縛る: どちらかに語が増えた・消えた・綴りが変わった時点で typecheck が落ちる。
type _KindsMatchSource = RequestQuerySource extends RequestQueryKind
  ? RequestQueryKind extends RequestQuerySource
    ? true
    : never
  : never;
const _kindsMatchSource: _KindsMatchSource = true;
void _kindsMatchSource;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

function asMeta(meta: unknown): Record<string, unknown> | null {
  return typeof meta === "object" && meta !== null && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null;
}

/** 1 行の分類。記録が無い・知らない値なら null。 */
export function requestQueryKindOf(meta: unknown): RequestQueryKind | null {
  const v = asMeta(meta)?.requestQuery;
  return typeof v === "string" && (REQUEST_QUERY_KINDS as readonly string[]).includes(v)
    ? (v as RequestQueryKind)
    : null;
}

/** declared の行の SHA-256（小文字 hex 64 桁）。それ以外・記録なし・形が違えば null。 */
export function requestQuerySha256Of(meta: unknown): string | null {
  const m = asMeta(meta);
  if (m?.requestQuery !== "declared") return null;
  const h = m.requestQuerySha256;
  return typeof h === "string" && SHA256_HEX_RE.test(h) ? h : null;
}

function assertAlias(fn: string, alias: string): string {
  if (alias !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`${fn}: alias must be a plain identifier, got ${JSON.stringify(alias)}`);
  }
  return alias === "" ? "" : `${alias}.`;
}

/** `requestQueryKindOf` と同じ規則の SQL 式（同じ配列から作る）。 */
export function requestQueryKindSql(alias = ""): string {
  const p = assertAlias("requestQueryKindSql", alias);
  const known = REQUEST_QUERY_KINDS.map((k) => `'${k}'`).join(", ");
  // jsonb_typeof で string に限る: `->>` は true や 1 も文字列にして返すので、JS 側（typeof === "string"）と揃える。
  return (
    `CASE WHEN jsonb_typeof(${p}raw_response_meta->'requestQuery') = 'string'` +
    ` AND ${p}raw_response_meta->>'requestQuery' IN (${known})` +
    ` THEN ${p}raw_response_meta->>'requestQuery' END`
  );
}

/** `requestQuerySha256Of` と同じ規則の SQL 式。 */
export function requestQuerySha256Sql(alias = ""): string {
  const p = assertAlias("requestQuerySha256Sql", alias);
  return (
    `CASE WHEN jsonb_typeof(${p}raw_response_meta->'requestQuery') = 'string'` +
    ` AND ${p}raw_response_meta->>'requestQuery' = 'declared'` +
    ` AND jsonb_typeof(${p}raw_response_meta->'requestQuerySha256') = 'string'` +
    ` AND ${p}raw_response_meta->>'requestQuerySha256' ~ '^[0-9a-f]{64}$'` +
    ` THEN ${p}raw_response_meta->>'requestQuerySha256' END`
  );
}

// ============================================================
// 「こちらがクエリを送っていなかった」失敗の判定（2026-09-28・retest の (c) と /sellers の query_not_sent が共有）。
// JS の述語と SQL の断片は組（tests/request-not-sent.pg.test.ts が一致を固定する）。
// ============================================================

/** Base の network の表記（CAIP-2 と v1 の slug）。 */
export const BASE_NETWORKS = ["eip155:8453", "base"] as const;

/**
 * 今のカタログの出品が**必須の**クエリを宣言している: スキーマの properties.input.properties.queryParams.required が
 * 空でない配列（2026-09-28 レビュー）。queryParams が空・properties だけで必須が無い出品は入れない——クエリが任意なら、
 * 送らなかったことが 400 の原因とは言えない。
 */
export function declaresRequiredQuery(declaredSchema: unknown): boolean {
  const qp = declaredInputProperty(declaredSchema, "queryParams");
  if (typeof qp !== "object" || qp === null || Array.isArray(qp)) return false;
  const required = (qp as Record<string, unknown>).required;
  return Array.isArray(required) && required.length > 0;
}

/** declaresRequiredQuery と同じ規則の SQL（引数はスキーマの列の式・例 `e.declared_schema`）。 */
export function declaresRequiredQuerySql(schemaExpr: string): string {
  const x = assertSqlExpr("declaresRequiredQuerySql", schemaExpr);
  const req = `${x} #> '{properties,input,properties,queryParams,required}'`;
  // CASE で型を先に見る（jsonb_array_length は配列以外で落ちる。AND は評価順を保証しない）。
  return `(CASE WHEN jsonb_typeof(${x} #> '{properties,input,properties,queryParams}') = 'object' AND jsonb_typeof(${req}) = 'array' THEN jsonb_array_length(${req}) > 0 ELSE false END)`;
}

function epochMs(v: string | Date | null): number | null {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * こちらがクエリを送っていなかったための失敗（retest の (c)・/sellers の query_not_sent）:
 * Base の行・400/422 で未決済・BASE_DECLARED_QUERY_SINCE より前・行の requestQuery が無いか empty・
 * 今の出品が必須のクエリを宣言している。メソッドは問わない（クエリは GET にも POST にも足す）。
 * XRPL は 2026-09-21 から送っていたので入らない。
 */
export function queryNotSentOnOurSide(row: NotSentRowInput): boolean {
  if (!refusedUnsettled(row)) return false;
  if (!(BASE_NETWORKS as readonly string[]).includes(row.network ?? "")) return false;
  const at = epochMs(row.attemptedAt);
  if (at === null || at >= Date.parse(BASE_DECLARED_QUERY_SINCE)) return false;
  const meta = row.rawResponseMeta;
  const kind = typeof meta === "object" && meta !== null && !Array.isArray(meta) ? (meta as Record<string, unknown>).requestQuery : undefined;
  if (!(kind === undefined || kind === null || kind === "empty")) return false;
  return declaresRequiredQuery(row.declaredSchema);
}

/** queryNotSentOnOurSide と同じ規則の SQL。`row` は購入行の別名、`schema` は出品のスキーマの列の式。 */
export function queryNotSentOnOurSideSql(cols: { row: string; schema: string }): string {
  const a = assertSqlExpr("queryNotSentOnOurSideSql", cols.row);
  return (
    `(${refusedUnsettledSql(a)}` +
    ` AND ${a}.network IN (${BASE_NETWORKS.map((n) => `'${n}'`).join(", ")})` +
    ` AND ${a}.attempted_at < '${BASE_DECLARED_QUERY_SINCE}'::timestamptz` +
    ` AND coalesce(${a}.raw_response_meta->>'requestQuery', 'empty') = 'empty'` +
    ` AND ${declaresRequiredQuerySql(cols.schema)})`
  );
}
