// ============================================================
// L0 の理由コード——定義の正典と、記録頁の 1 行説明（2026-09-29 監査 5 周目）。
//
// WHY: 名指しされた売り手の弁護士の立場の監査で、L0 の fail に付く理由コード
// （accepts_invalid・metadata_mismatch・price_mismatch・no_402 …）の定義がどこにも無く、
// 記録頁は理由の語だけを出していた。売り手には「何が不正だったか」が読めず、計器の誤り
// （api.strale.io の v1 封筒を 4,000 バイトで切って accepts_invalid にしていた）も外から
// 見分けられなかった。
//
// このファイルが唯一の源泉で、同じ配列から /observatory/methodology の表が、同じ関数から
// /observatory/e/[id] の理由の 1 行が作られる。l0-probe.ts が返す理由語と 1 対 1
// （tests/l0-reasons.test.ts が突き合わせる）。
// ============================================================
import { BODY_OVER_CAP_REASON, L0_BODY_CAP_BYTES, L0_BODY_CAP_RAISED_ON, L0_LEGACY_BODY_CAP_BYTES, REQUEST_SHAPE_REASON } from "./l0-probe";
import { PATH_TEMPLATE_REASON } from "./path-template";

export type L0ReasonCode = {
  code: string;
  verdict: "fail" | "unverified";
  /** 1 文の定義（英語・公開面）。 */
  meaning: string;
};

export const L0_REASON_CODES: readonly L0ReasonCode[] = [
  {
    code: "no_402",
    verdict: "fail",
    meaning:
      "The endpoint answered with a status other than 402: content without payment (2xx), an API key demand (401/403), 404, a server error (5xx), or a 400/422 to a GET.",
  },
  {
    code: "accepts_invalid",
    verdict: "fail",
    meaning:
      "The endpoint answered 402, but neither the PAYMENT-REQUIRED header nor the JSON body carried an accepts[] entry with an amount (amount or maxAmountRequired), a payTo and an asset. The record says which part was missing.",
  },
  {
    code: "price_mismatch",
    verdict: "fail",
    meaning: "No accept in the 402 carried the amount and asset the catalog listing declares. The record shows both sides.",
  },
  {
    code: "metadata_mismatch",
    verdict: "fail",
    meaning: "No accept in the 402 carried the receiving address (payTo) and network the catalog listing declares. The record shows both sides.",
  },
  {
    code: "no_mpp_challenge",
    verdict: "fail",
    meaning: "An MPP (Tempo) endpoint answered 402 with an x402 envelope and no Payment challenge, which an MPP client cannot pay.",
  },
  { code: "dns", verdict: "fail", meaning: "The host name did not resolve." },
  { code: "timeout", verdict: "fail", meaning: "No response headers arrived within 10 seconds." },
  { code: "network", verdict: "fail", meaning: "The connection failed (refused or reset) before a response." },
  { code: "redirect_limit", verdict: "fail", meaning: "The endpoint redirected more times than vet402 follows." },
  { code: "tls", verdict: "unverified", meaning: "The TLS handshake failed; vet402 cannot tell its own side from the seller's, so nothing is published against the seller." },
  { code: "unsafe_target", verdict: "unverified", meaning: "The listed URL points at (or redirects to) a non-public address, so vet402 sent nothing." },
  { code: "rate_limited", verdict: "unverified", meaning: "The endpoint answered 429; a rate limit is not a verdict on the payment wall." },
  {
    code: PATH_TEMPLATE_REASON,
    verdict: "unverified",
    meaning: "The listed URL still contains an unfilled path parameter, so no request was sent.",
  },
  {
    code: REQUEST_SHAPE_REASON,
    verdict: "unverified",
    meaning:
      "An unpaid POST (empty JSON body) or an MPP request was answered 400 or 422 with no payment challenge: the endpoint checked the input before asking for payment, and vet402 does not guess a request body.",
  },
  {
    code: BODY_OVER_CAP_REASON,
    verdict: "unverified",
    meaning: `The 402 body was larger than the ${L0_BODY_CAP_BYTES / 1024} KB vet402 reads and no PAYMENT-REQUIRED header was readable, so the envelope was not read in full.`,
  },
  {
    code: "method_undeclared",
    verdict: "unverified",
    meaning: "Before 2026-09-02 a listing without an HTTP method was not probed; since then it is probed with GET.",
  },
];

const BY_CODE = new Map(L0_REASON_CODES.map((r) => [r.code, r]));

export function l0ReasonCode(code: string | null): L0ReasonCode | null {
  return code ? BY_CODE.get(code) ?? null : null;
}

/** 記録頁が理由の 1 行を作るのに要る、プローブ行の記録（raw_response_meta から読める範囲）。 */
export type L0ProbeDetail = {
  verdict: string;
  failReason: string | null;
  httpStatus: number | null;
  method: string | null;
  probedAt: Date | string | null;
  /** raw_response_meta.envelope（2026-09-29 以降の accepts_invalid）。 */
  envelope?: { header?: string; body?: string; missing?: string[] } | null;
  declared?: { amount?: string | null; asset?: string | null; network?: string | null; payTo?: string | null } | null;
  offered?: { amount?: string; asset?: string; network?: string; payTo?: string }[] | null;
  /**
   * 2026-09-29 の変更より前のプローブが書いた行か（raw_response_meta に bodyBytes が無い）。日付ではなく
   * 記録の形で見分ける——変更が本番に載る日と暦日がずれても、どちらの計器の行かは取り違えない。
   */
  legacyProbe?: boolean | null;
  /**
   * 旧い行で、記録した本文の先頭 500 字が埋まっていて（本文 500 字以上）、x402Version か accepts の
   * 語を含む——4,000 バイトで切って封筒を読み損ねた可能性のある行。
   */
  legacyLongEnvelope?: boolean | null;
};

const short = (v: string | null | undefined): string => {
  if (!v) return "—";
  return v.length > 14 ? `${v.slice(0, 6)}…${v.slice(-4)}` : v;
};

const HEADER_STATE: Record<string, string> = {
  absent: "no PAYMENT-REQUIRED header",
  not_base64_json: "PAYMENT-REQUIRED header is not base64 JSON",
  no_accepts_array: "PAYMENT-REQUIRED header has no accepts array",
  accepts_empty: "PAYMENT-REQUIRED header has an empty accepts array",
  accepts_unusable: "PAYMENT-REQUIRED header's accept is incomplete",
  ok: "PAYMENT-REQUIRED header readable",
};
const BODY_STATE: Record<string, string> = {
  empty: "empty body",
  not_json: "body is not JSON",
  no_accepts_array: "body has no accepts array",
  accepts_empty: "body has an empty accepts array",
  accepts_unusable: "body's accept is incomplete",
  ok: "body readable",
};

/**
 * 1 行の説明（英語）。pass と、理由の無い行は null。記録に無いことは「記録されていない」と書き、推測しない。
 */
export function l0ReasonDetail(p: L0ProbeDetail): string | null {
  if (p.verdict === "pass" || !p.failReason) return null;
  const code = p.failReason;
  switch (code) {
    case "accepts_invalid": {
      if (p.envelope && (p.envelope.header || p.envelope.body)) {
        const parts = [HEADER_STATE[p.envelope.header ?? ""] ?? null, BODY_STATE[p.envelope.body ?? ""] ?? null].filter(Boolean);
        const missing = p.envelope.missing && p.envelope.missing.length > 0 ? `; the first accept lacks ${p.envelope.missing.join(", ")}` : "";
        return `402 without a payable accept: ${parts.join("; ")}${missing}.`;
      }
      if (p.legacyProbe && p.legacyLongEnvelope) {
        return `Recorded before the ${L0_BODY_CAP_RAISED_ON} change, when the probe read only the first ${L0_LEGACY_BODY_CAP_BYTES.toLocaleString("en-US")} bytes of the 402 body; this body began like an x402 envelope, so the fail may be vet402's measuring error rather than the seller's.`;
      }
      return `402 without a payable accept in the header or the body (which part was missing was not recorded before the ${L0_BODY_CAP_RAISED_ON} change).`;
    }
    case "price_mismatch":
    case "metadata_mismatch": {
      const d = p.declared;
      const o = p.offered;
      if (!d || !o) return `${code === "price_mismatch" ? "Amount or asset" : "payTo or network"} differs from the catalog declaration (the values compared were not recorded before the ${L0_BODY_CAP_RAISED_ON} change).`;
      if (code === "price_mismatch") {
        const offered = o.map((a) => `${a.amount ?? "—"} of ${short(a.asset)}`).join(", ");
        return `Declared ${d.amount ?? "any amount"} of ${d.asset ? short(d.asset) : "any asset"}; the 402 offered ${offered || "nothing comparable"}.`;
      }
      const offered = o.map((a) => `${short(a.payTo)} on ${a.network ?? "—"}`).join(", ");
      return `Declared payTo ${d.payTo ? short(d.payTo) : "any"} on ${d.network ?? "any network"}; the 402 offered ${offered || "nothing comparable"}.`;
    }
    case "no_402": {
      if (p.httpStatus === null) return "No 402 came back.";
      const base = `HTTP ${p.httpStatus} instead of 402 to an unpaid ${p.method ?? "request"}.`;
      // 2026-09-29 より前は、空の本文の未払い POST への 400/422 もここに入れていた（今は request_shape）。
      if (p.method === "POST" && (p.httpStatus === 400 || p.httpStatus === 422) && p.legacyProbe) {
        return `${base} Recorded before the ${L0_BODY_CAP_RAISED_ON} change; the POST carried an empty JSON body, and since that change this answer is recorded as ${REQUEST_SHAPE_REASON} (unverified), not as a fail.`;
      }
      return base;
    }
    case REQUEST_SHAPE_REASON:
      return `Unpaid ${p.method === "POST" ? "POST with an empty JSON body" : "request"} answered ${p.httpStatus ?? "4xx"} before any payment challenge; not measured (vet402 does not guess the input).`;
    case BODY_OVER_CAP_REASON:
      return `402 body over ${L0_BODY_CAP_BYTES / 1024} KB with no readable PAYMENT-REQUIRED header; envelope not read in full, not measured.`;
    default: {
      const r = l0ReasonCode(code);
      return r ? r.meaning : null;
    }
  }
}
