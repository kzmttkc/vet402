// ============================================================
// §7.3 逆引きの入口: q が URL / domain / address / tx / payee_id のどれかを判別する。
// 判別は文字列の形だけで行う（DB を見ない・純関数）。
// ============================================================
export type QueryKind = "url" | "domain" | "address" | "tx" | "payee_id" | "unknown";

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
const EVM_TX = /^0x[0-9a-fA-F]{64}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/i;
const PARTY_ID = /^(eip155:\d+|solana:[1-9A-HJ-NP-Za-km-z]{32,44}):(.+)$/;

export function classifyQuery(raw: string): { kind: QueryKind; value: string } {
  const q = raw.trim();
  if (q.length === 0 || q.length > 2048) return { kind: "unknown", value: q };
  if (/^https?:\/\//i.test(q)) return { kind: "url", value: q };
  if (PARTY_ID.test(q)) return { kind: "payee_id", value: q };
  if (EVM_TX.test(q)) return { kind: "tx", value: q.toLowerCase() };
  if (EVM_ADDR.test(q)) return { kind: "address", value: q.toLowerCase() };
  if (B58.test(q) && q.length >= 80 && q.length <= 90) return { kind: "tx", value: q };
  if (B58.test(q) && q.length >= 32 && q.length <= 44) return { kind: "address", value: q };
  if (DOMAIN.test(q)) return { kind: "domain", value: q.toLowerCase() };
  return { kind: "unknown", value: q };
}

/** 400 の本文に載せる「受け付ける q の形」。docs/openapi.yaml の説明と同じ並び。 */
export const ACCEPTED_QUERY_FORMS = [
  "an absolute https URL (https://host/path)",
  "a domain (host.example)",
  "a wallet address (0x… or base58)",
  "a payee_id (chain:address, e.g. eip155:8453:0x…)",
  "a transaction hash (0x… 64 hex, or base58)",
] as const;

export type InvalidQuery = { message: string; suggestion?: string };

/**
 * 2026-09-29 再監査（DX）: `api.exa.ai/search` のように https の無い URL を渡すと
 * `{ error: "invalid_query", expected: "q" }` だけが返り、何が悪いのか・どう直すのかが
 * 本文から読めなかった。`http://` の URL は 400 にすらならず、何も入っていない 200 だった
 * （canonicalUrl が https 以外を受けないので）。形の段階で弾き、原因と直した q を返す。
 *
 * 受け付ける形なら null。判定は文字列だけ（DB を見ない）。
 */
export function explainInvalidQuery(raw: string | null): InvalidQuery | null {
  const q = (raw ?? "").trim();
  if (q.length === 0) return { message: "q is required: pass the URL, domain, address, payee_id or transaction hash to look up." };
  if (q.length > 2048) return { message: "q is longer than 2048 characters." };
  const c = classifyQuery(q);
  if (c.kind === "url") {
    let u: URL | null = null;
    try {
      u = new URL(c.value);
    } catch {
      u = null;
    }
    if (!u) return { message: "url must be an absolute https URL; this one could not be parsed." };
    if (u.protocol !== "https:") {
      return {
        message: "url must be an absolute https URL; x402 endpoints are identified by their https URL.",
        suggestion: `https://${c.value.replace(/^https?:\/\//i, "")}`,
      };
    }
    return null;
  }
  if (c.kind !== "unknown") return null;
  // host/path（スキーム抜けの URL）。ホスト部がドメインの形なら https:// を足した q を返す。
  const slash = q.indexOf("/");
  if (slash > 0 && classifyQuery(q.slice(0, slash)).kind === "domain") {
    return {
      message: "url must be an absolute https URL; q looks like a URL without its scheme.",
      suggestion: `https://${q}`,
    };
  }
  return { message: `q was not recognised as any accepted form: ${ACCEPTED_QUERY_FORMS.join("; ")}.` };
}
