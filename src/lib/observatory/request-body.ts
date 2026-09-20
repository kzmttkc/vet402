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
