// ============================================================
// §5 オブジェクト識別子（製品定義書 v1.0）。
//
//   resource_id    = sha256(method + " " + canonical_url)
//   endpoint_hash  = sha256(origin + pathname_prefix)      ※仕様の endpoint_id
//   payee_id       = chain_caip2 + ":" + address            （EVM は小文字）
//   payer_id       = 同上
//   agent_id       = "eip155:<chainId>:8004:" + tokenId
//   observation_id = sha256(resource_id + observed_at + probe_type)
//   purchase_id    = chain_caip2 + ":" + tx_hash
//
// 既存の uuid（x402_endpoints.id 等）は主キーのまま残す。これらは列として
// 並走し、公開 API と逆引きの鍵になる。「同一 ID で結合されていること」が
// §1 の「頭ひとつ抜ける」の操作定義なので、算出はここ 1 箇所に置く。
//
// 仕様からの逸脱（意図的・開示）:
//   - payee/payer の address_lower は EVM にのみ適用する。Solana の base58 は
//     大文字小文字が口座の同一性を担うので、小文字化すると別口座に潰れる。
//   - pathname_prefix は「最後のセグメントを落とした親パス」と定義する
//     （Bazaar の掲載単位が /api/{name} 形で並ぶことが多い）。1 セグメント以下は "/"。
// ============================================================
import { createHash } from "node:crypto";
import { toCaip2 } from "@/lib/observatory/chains";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * 署名・時刻など、宣言できず測定対象から外す可変クエリ名（小文字比較）。
 * 外した名前は undeclaredQuery として開示する（§5「undeclared とする」）。
 */
export const VOLATILE_QUERY_KEYS: ReadonlySet<string> = new Set([
  "sig",
  "signature",
  "ts",
  "timestamp",
  "nonce",
  "token",
  "apikey",
  "api_key",
  "key",
  "expires",
  "exp",
]);

export type CanonicalUrl = { url: string; undeclaredQuery: string[] };

export function canonicalUrl(raw: string): CanonicalUrl | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const port = u.port && u.port !== "443" ? `:${u.port}` : "";
  let path = u.pathname.replace(/\/+$/, "");
  if (path === "/") path = "";
  const kept: [string, string][] = [];
  const undeclared: string[] = [];
  for (const [k, v] of u.searchParams) {
    if (VOLATILE_QUERY_KEYS.has(k.toLowerCase())) undeclared.push(k);
    else kept.push([k, v]);
  }
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return { url: `https://${host}${port}${path}${qs ? `?${qs}` : ""}`, undeclaredQuery: undeclared.sort() };
}

export function resourceId(method: string, rawUrl: string): string {
  const c = canonicalUrl(rawUrl);
  const url = c ? c.url : rawUrl.trim();
  return sha256(`${method.toUpperCase()} ${url}`);
}

export function endpointHash(rawUrl: string): string {
  const c = canonicalUrl(rawUrl);
  let u: URL;
  try {
    u = new URL(c ? c.url : rawUrl.trim());
  } catch {
    return sha256(rawUrl.trim());
  }
  const segs = u.pathname.split("/").filter(Boolean);
  const prefix = segs.length <= 1 ? "/" : `/${segs.slice(0, -1).join("/")}`;
  return sha256(`${u.origin}${prefix}`);
}

export function payeeId(chain: string, address: string): string {
  const caip2 = toCaip2(chain) ?? chain;
  const a = caip2.startsWith("eip155:") ? address.toLowerCase() : address;
  return `${caip2}:${a}`;
}
export const payerId = payeeId;

export function purchaseId(chain: string, txHash: string): string {
  const caip2 = toCaip2(chain) ?? chain;
  return `${caip2}:${caip2.startsWith("eip155:") ? txHash.toLowerCase() : txHash}`;
}

export function observationId(resourceIdHex: string, observedAtIso: string, probeType: "L0" | "L1" | "L2"): string {
  return sha256(`${resourceIdHex}${observedAtIso}${probeType}`);
}

export function agentId8004(chainId: number, tokenId: string | bigint): string {
  return `eip155:${chainId}:8004:${String(tokenId)}`;
}

/** payee_id / payer_id を (chain, address) に戻す。形が違えば null。 */
export function parsePartyId(id: string): { chain: string; address: string } | null {
  const m = /^((?:eip155:\d+)|(?:solana:[1-9A-HJ-NP-Za-km-z]{32,44})):(.+)$/.exec(id);
  if (!m) return null;
  return { chain: m[1], address: m[2] };
}

export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
