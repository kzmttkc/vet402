// ============================================================
// 支払い付き応答の本文の指紋（2026-11-24・F3）— 第三者が本文を受け取らずに照合する。
//
// 記録（raw_response_meta）:
//   responseSha256  支払い付き応答として最後まで読んだバイト列の SHA-256（小文字 hex 64）
//   responseBytes   そのバイト数
//   responseFingerprint  "truncated" | "partial" — 読み切れなかったとき（hash は出さない）
//
// 公開 export の列:
//   response_sha256 / response_bytes（export-columns.ts）
//
// 何を出し、何を出さないか:
//   - 出す: 本文を最後まで読めた行だけ hash とバイト数。
//   - 出さない: 上限超え・読み取り失敗・応答を読めなかった行（CSV では空）。
//
// 記録が無い行は null（CSV では空）。0 バイトの空本文を読み切れた行は 0 と hash を出す。
// ============================================================
import { createHash } from "node:crypto";

import { L1_PAID_BODY_CAP_BYTES } from "./l2-check";

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export type PaidResponseFingerprintComplete = {
  responseSha256: string;
  responseBytes: number;
};

export type PaidResponseFingerprintIncomplete = {
  responseFingerprint: "truncated" | "partial";
};

export type PaidResponseFingerprintRecord = PaidResponseFingerprintComplete | PaidResponseFingerprintIncomplete;

function asMeta(meta: unknown): Record<string, unknown> | null {
  return typeof meta === "object" && meta !== null && !Array.isArray(meta) ? (meta as Record<string, unknown>) : null;
}

/**
 * ランナーが行の raw_response_meta に残す形。`paid` が true で応答本文の読み取りを試み、
 * `raw` が渡されたときだけ返す（空の Uint8Array は有効）。
 * 指紋は `bodyReadError === null` かつ `raw.byteLength <= capBytes` のときだけ。
 */
export function paidResponseFingerprintRecord(
  paid: boolean,
  raw: Uint8Array | null | undefined,
  bodyReadError: unknown | null,
  capBytes: number = L1_PAID_BODY_CAP_BYTES,
): PaidResponseFingerprintRecord | null {
  if (!paid || raw === null || raw === undefined) return null;
  if (bodyReadError !== null) {
    return { responseFingerprint: "partial" };
  }
  if (raw.byteLength > capBytes) {
    return { responseFingerprint: "truncated" };
  }
  return {
    responseSha256: createHash("sha256").update(raw).digest("hex"),
    responseBytes: raw.byteLength,
  };
}

/** 1 行の SHA-256。記録が無い・形が違えば null。 */
export function responseSha256Of(meta: unknown): string | null {
  const h = asMeta(meta)?.responseSha256;
  return typeof h === "string" && SHA256_HEX_RE.test(h) ? h : null;
}

/** 1 行のバイト数。responseSha256 と揃った行だけ。0 は空本文の記録あり。 */
export function responseBytesOf(meta: unknown): number | null {
  if (responseSha256Of(meta) === null) return null;
  const b = asMeta(meta)?.responseBytes;
  return typeof b === "number" && Number.isInteger(b) && b >= 0 ? b : null;
}

function assertAlias(fn: string, alias: string): string {
  if (alias !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`${fn}: alias must be a plain identifier, got ${JSON.stringify(alias)}`);
  }
  return alias === "" ? "" : `${alias}.`;
}

/** `responseSha256Of` と同じ規則の SQL 式。 */
export function responseSha256Sql(alias = ""): string {
  const p = assertAlias("responseSha256Sql", alias);
  return (
    `CASE WHEN jsonb_typeof(${p}raw_response_meta->'responseSha256') = 'string'` +
    ` AND ${p}raw_response_meta->>'responseSha256' ~ '^[0-9a-f]{64}$'` +
    ` THEN ${p}raw_response_meta->>'responseSha256' END`
  );
}

/** `responseBytesOf` と同じ規則の SQL 式。 */
export function responseBytesSql(alias = ""): string {
  const p = assertAlias("responseBytesSql", alias);
  return (
    `CASE WHEN jsonb_typeof(${p}raw_response_meta->'responseSha256') = 'string'` +
    ` AND ${p}raw_response_meta->>'responseSha256' ~ '^[0-9a-f]{64}$'` +
    ` AND jsonb_typeof(${p}raw_response_meta->'responseBytes') = 'number'` +
    ` AND (${p}raw_response_meta->>'responseBytes') ~ '^[0-9]+$'` +
    ` THEN ${p}raw_response_meta->>'responseBytes' END`
  );
}