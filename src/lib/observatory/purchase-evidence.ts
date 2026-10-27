// ============================================================
// L1 の購入ごとの証拠（2026-10-27）。
//
// 1 回の購入（予約行）ごとに、内部の記録として 2 つを残す:
//   challenge_402    その購入のときに受け取った 402 の応答（HTTP status・x402Version・accepts の全体・
//                    選んだ accept・ヘッダーで来たときはデコード後の JSON。Tempo は MPP の challenge）。
//   payment_payload  有料の要求に載せた支払いペイロード（X-PAYMENT / PAYMENT-SIGNATURE / MPP の credential を
//                    デコードした JSON）。
// 売り手ごとに「受け取った challenge・こちらが出した署名済みペイロード・結果」を示すため（Celo Prezenti の
// マイルストーン）。結果（tx hash・誤り・時間切れ）は既存の列にある。
//
// **payment_payload は公開しない。** 署名済みの EIP-3009 authorization などは validBefore まで誰でも決済に出せる。
// 公開の面（export.csv・API・demo/verify・公開ページ・ログ）はこの 2 列を読まない
// （tests/l1-purchase-evidence.pg.test.ts が公開の書き出しの列を固定している）。
//
// 秘密を入れない: 残すのは売り手の 402 の本文（または PAYMENT-REQUIRED / WWW-Authenticate の値）と、
// 支払いヘッダー 1 本の値のデコード結果だけ。他の要求ヘッダー・API キー・RPC の URL・鍵は受け取りもしない。
// 列ごとに PURCHASE_EVIDENCE_MAX_BYTES で切り詰め、切ったら `truncated` の印を付ける。
// ============================================================
import { parseChallenge } from "./x402-payer";

/** 1 列あたりの上限（JSON に直したときの UTF-8 バイト数）。 */
export const PURCHASE_EVIDENCE_MAX_BYTES = 32 * 1024;

/** 記録の形の版。読み手が形の変化を見分けるため。 */
export const PURCHASE_EVIDENCE_VERSION = 1;

type Json = Record<string, unknown>;

function asRecord(v: unknown): Json | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/** Postgres の jsonb が受け付けない文字（U+0000・孤立サロゲート）を落とす。l1-runner の pgSafeText と同じ規則。 */
function pgSafeText(value: string): string {
  return value
    .replaceAll("\u0000", "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

function pgSafe(value: unknown): unknown {
  if (typeof value === "string") return pgSafeText(value);
  if (Array.isArray(value)) return value.map((v) => pgSafe(v));
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const out: Json = {};
    for (const [k, v] of Object.entries(value as Json)) out[pgSafeText(k)] = pgSafe(v);
    return out;
  }
  return value;
}

/** 文字列を UTF-8 で maxBytes 以下に切る（文字の途中で切らない）。 */
function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  // サロゲートの対の片方で終わらせない。
  const code = text.charCodeAt(lo - 1);
  return code >= 0xd800 && code <= 0xdbff ? text.slice(0, lo - 1) : text.slice(0, lo);
}

/**
 * 上限に収める。収まればそのまま。超えたら `bulkyKey` の値を「元の JSON の先頭（文字列）」に置き換え、
 * `truncated: { field, originalBytes }` の印を付ける。それでも超えるなら（bulkyKey 以外が大きい）、
 * 全体を先頭だけの文字列にして印を付ける。どちらも結果は必ず maxBytes 以下。
 */
export function capPurchaseEvidence(value: Json, bulkyKey: string, maxBytes = PURCHASE_EVIDENCE_MAX_BYTES): Json {
  const safe = pgSafe(value) as Json;
  const originalBytes = jsonBytes(safe);
  if (originalBytes <= maxBytes) return safe;

  const fit = (build: (prefix: string) => Json, source: string): Json | null => {
    // JSON の文字列にすると引用符・バックスラッシュのぶん膨らむので、溢れたぶんだけ縮めて測り直す。
    let budget = maxBytes;
    for (let i = 0; i < 12; i++) {
      const prefix = utf8Prefix(source, budget);
      const out = build(prefix);
      const over = jsonBytes(out) - maxBytes;
      if (over <= 0) return out;
      budget -= Math.max(over, 16);
      if (budget <= 0) break;
    }
    return null;
  };

  if (bulkyKey in safe) {
    const bulkySource = JSON.stringify(safe[bulkyKey]) ?? "null";
    const rest = { ...safe };
    delete rest[bulkyKey];
    const out = fit(
      (prefix) => ({ ...rest, [bulkyKey]: prefix, truncated: { field: bulkyKey, originalBytes, note: `${bulkyKey} holds the first bytes of its JSON text` } }),
      bulkySource,
    );
    if (out) return out;
  }
  const whole = JSON.stringify(safe);
  return (
    fit((prefix) => ({ v: PURCHASE_EVIDENCE_VERSION, truncated: { field: "*", originalBytes, note: "json holds the first bytes of the whole record" }, json: prefix }), whole) ?? {
      v: PURCHASE_EVIDENCE_VERSION,
      truncated: { field: "*", originalBytes },
    }
  );
}

function decodeBase64Json(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return undefined;
  }
}

function decodeBase64UrlJson(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** 選んだ accept から MPP の内部の写し（mpp: challenge 全体）を外す。challenge 側は challenges に残る。 */
function selectedAcceptOf(accept: unknown): unknown {
  const rec = asRecord(accept);
  if (!rec) return accept ?? null;
  if (!("mpp" in rec)) return rec;
  const { mpp, ...rest } = rec;
  const id = asRecord(mpp)?.id;
  return { ...rest, mppChallengeId: typeof id === "string" ? id : null };
}

/**
 * ① x402 の 402 応答の記録。parseChallenge と同じ順（PAYMENT-REQUIRED ヘッダー → 本文）で、どちらから読んだかを
 * `source` に残し、その文書（デコード後の JSON）を丸ごと `document` に置く。accepts は document.accepts（売り手の原文）。
 * どちらも読めなかった 402 は本文の文字列を `bodyText` に残す（ここへは来ない——読めない 402 は予約より前に落ちる）。
 */
export function x402ChallengeEvidence(input: {
  httpStatus: number;
  headers: Headers;
  bodyText: string;
  selectedAccept?: unknown;
}): Json {
  const headerValue = input.headers.get("PAYMENT-REQUIRED");
  const headerDoc = headerValue ? decodeBase64Json(headerValue) : undefined;
  const headerParses =
    headerValue !== null && parseChallenge({ bodyText: "", headers: new Headers({ "PAYMENT-REQUIRED": headerValue }) }) !== null;
  let bodyDoc: unknown = undefined;
  if (!headerParses && input.bodyText) {
    try {
      bodyDoc = JSON.parse(input.bodyText);
    } catch {
      bodyDoc = undefined;
    }
  }
  const bodyParses = !headerParses && bodyDoc !== undefined && parseChallenge({ bodyText: input.bodyText, headers: new Headers() }) !== null;
  const source = headerParses ? "header" : bodyParses ? "body" : null;
  const document = headerParses ? headerDoc : bodyParses ? bodyDoc : null;
  const docRec = asRecord(document);
  return {
    v: PURCHASE_EVIDENCE_VERSION,
    protocol: "x402",
    httpStatus: input.httpStatus,
    source,
    x402Version: docRec && typeof docRec.x402Version === "number" ? docRec.x402Version : null,
    acceptsCount: docRec && Array.isArray(docRec.accepts) ? docRec.accepts.length : null,
    selectedAccept: selectedAcceptOf(input.selectedAccept ?? null),
    // ヘッダーがあったのに読めなかった（base64 / JSON でない）ことは印だけ残す。
    ...(headerValue !== null && headerDoc === undefined ? { paymentRequiredHeader: { undecodable: true, bytes: headerValue.length } } : {}),
    ...(source === null ? { bodyText: input.bodyText } : {}),
    document: document ?? null,
  };
}

/** ① MPP（Tempo）の 402 の記録。challenge は WWW-Authenticate に載る。読み取った challenge（request はデコード済み）と原文を残す。 */
export function mppChallengeEvidence(input: {
  httpStatus: number;
  headers: Headers;
  challenges: readonly unknown[];
  selectedAccept?: unknown;
}): Json {
  return {
    v: PURCHASE_EVIDENCE_VERSION,
    protocol: "mpp",
    httpStatus: input.httpStatus,
    source: "www-authenticate",
    selectedAccept: selectedAcceptOf(input.selectedAccept ?? null),
    document: {
      wwwAuthenticate: input.headers.get("www-authenticate"),
      // raw は mppx が challenge 1 つずつ直列化し直した値で、wwwAuthenticate と重なるので外す。
      challenges: input.challenges.map((c) => {
        const { raw: _raw, ...rest } = c as Json;
        void _raw;
        return rest;
      }),
    },
  };
}

/** ①を上限に収めた最終形（document を切る）。 */
export function challengeEvidenceForRow(evidence: Json): Json {
  return capPurchaseEvidence(evidence, "document");
}

/**
 * ② 有料の要求に載せた支払いヘッダー 1 本のデコード結果。
 *   x402（X-PAYMENT / PAYMENT-SIGNATURE）は base64 の JSON。
 *   MPP（Tempo）は `Payment <base64url の JSON>`。
 * 渡すのはその 1 本の名前と値だけ（他の要求ヘッダーはここへ来ない）。読めない値は印と長さだけ残し、生の値は残さない。
 */
export function paymentPayloadEvidence(header: { headerName: string; headerValue: string }): Json {
  const value = header.headerValue;
  const mpp = /^Payment\s+(\S+)$/.exec(value);
  const decoded = mpp ? decodeBase64UrlJson(mpp[1]) : decodeBase64Json(value);
  const evidence: Json = {
    v: PURCHASE_EVIDENCE_VERSION,
    headerName: header.headerName,
    encoding: mpp ? "payment-base64url-json" : "base64-json",
    ...(decoded === undefined ? { undecodable: true, bytes: value.length } : {}),
    decoded: decoded === undefined ? null : decoded,
  };
  return capPurchaseEvidence(evidence, "decoded");
}
