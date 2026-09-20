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
