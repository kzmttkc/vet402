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

// ---- 表記の揺れの別名（2026-09-29 監査 7 周目・高）----
// SDK の payOrRefuse（凍結中）は resource_id を**生の URL** から sha256("<METHOD> <url>") で作り、
// この正規化を通さない。表記が違うと /decision が 404 になり、SDK は「カタログ外」として受取人の
// スコアで決める——BLOCK の資源にも署名まで進みうる（例: `POST https://api.exa.ai/search/`）。
// ここで作る別名は「正規形と同じ資源を指す、よくある生の書き方」のハッシュで、/decision は
// resource_id の完全一致が外れたとき別名の表（x402_resource_aliases）を引く。
//
// 揺れ（テストの表: tests/resource-id-aliases.test.ts）:
//   - 末尾スラッシュの有無（ルートの "https://h" と "https://h/" を含む）
//   - ホストの大文字小文字（全部小文字・全部大文字・掲載の生 URL の書き方）
//   - 既定ポート :443 の有無（https の既定。:80 は http の既定で、http は正規形を持たない＝掲載にならない）
//   - クエリの並び（保つ名前が ALIAS_MAX_PERMUTED_QUERY_KEYS 個以下なら全順列、超えたら正規の順と掲載の順）
//   - 掲載の生 URL そのもの（利用者が一番写しやすい書き方）
// 規則: 別名にするのは canonicalUrl(v) が正規形と**完全に同じ**になる v だけ。だから別名は
// 1 つの正規形（＝1 つの資源）にしか写らず、別の出品の resource_id とは衝突しない（method もハッシュに入る）。

/** クエリの並びを全順列で持つ上限（4! = 24）。超えたら正規の順と掲載の順だけ。 */
export const ALIAS_MAX_PERMUTED_QUERY_KEYS = 4;

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs.slice()];
  const out: T[][] = [];
  xs.forEach((x, i) => {
    for (const rest of permutations([...xs.slice(0, i), ...xs.slice(i + 1)])) out.push([x, ...rest]);
  });
  return out;
}

/**
 * 正規形と同じ資源を指す、よくある生の書き方（正規形そのものは含まない）。純関数。
 * `listedUrl` は掲載の生 URL（x402_endpoints.resource_url）。正規形にならない URL は空配列。
 */
export function resourceUrlVariants(listedUrl: string): string[] {
  const c = canonicalUrl(listedUrl);
  if (!c) return [];
  const u = new URL(c.url);
  const host = u.hostname;
  const rawHost = /^\s*https:\/\/([^/:?#]+)/i.exec(listedUrl)?.[1];
  const hosts = [...new Set([host, host.toUpperCase(), ...(rawHost ? [rawHost] : [])])];
  const ports = u.port ? [`:${u.port}`] : ["", ":443"];
  const path = u.pathname === "/" ? "" : u.pathname;
  const paths = [path, `${path}/`];
  const kept = [...u.searchParams];
  const enc = (pairs: [string, string][]) => pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  let orders: [string, string][][];
  if (kept.length === 0) orders = [[]];
  else if (kept.length <= ALIAS_MAX_PERMUTED_QUERY_KEYS) orders = permutations(kept);
  else {
    const listedOrder = (() => {
      try {
        return [...new URL(listedUrl.trim()).searchParams].filter(([k]) => !VOLATILE_QUERY_KEYS.has(k.toLowerCase()));
      } catch {
        return kept;
      }
    })();
    orders = [kept, listedOrder];
  }
  const queries = [...new Set(orders.map((o) => (o.length ? `?${enc(o)}` : "")))];
  const out = new Set<string>();
  for (const h of hosts) for (const p of ports) for (const pa of paths) for (const q of queries) out.add(`https://${h}${p}${pa}${q}`);
  out.add(listedUrl.trim());
  out.delete(c.url);
  // 規則の関門: 正規形が完全に同じものだけを残す（別の資源へ写る別名を作らない）。
  return [...out].filter((v) => canonicalUrl(v)?.url === c.url).sort();
}

/**
 * 別名の resource_id（sha256("<METHOD> <生の書き方>")）。正規の resource_id は含まない。
 * SDK と同じく method は大文字にしてからハッシュする。
 */
export function resourceIdAliases(method: string, listedUrl: string): string[] {
  const m = method.toUpperCase();
  const canonicalId = resourceId(m, listedUrl);
  return [...new Set(resourceUrlVariants(listedUrl).map((v) => sha256(`${m} ${v}`)))].filter((id) => id !== canonicalId);
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
  // XRPL の tx hash は hex（ノードは大文字・売り手は小文字で返しうる）。大文字に寄せて同じ tx を 2 行にしない
  // （2026-09-17 レビュー #3・index-xrpl.ts と同じ正規化）。
  const tx = caip2.startsWith("eip155:") ? txHash.toLowerCase() : caip2.startsWith("xrpl:") ? txHash.toUpperCase() : txHash;
  return `${caip2}:${tx}`;
}

export function observationId(resourceIdHex: string, observedAtIso: string, probeType: "L0" | "L1" | "L2"): string {
  return sha256(`${resourceIdHex}${observedAtIso}${probeType}`);
}

export function agentId8004(chainId: number, tokenId: string | bigint): string {
  return `eip155:${chainId}:8004:${String(tokenId)}`;
}

/** payee_id / payer_id を (chain, address) に戻す。形が違えば null。 */
export function parsePartyId(id: string): { chain: string; address: string } | null {
  // xrpl:<NetworkID>（2026-09-17）。r アドレスは base58 で大文字小文字が同一性を担う（Solana と同じ）。
  const m = /^((?:eip155:\d+)|(?:solana:[1-9A-HJ-NP-Za-km-z]{32,44})|(?:xrpl:\d+)):(.+)$/.exec(id);
  if (!m) return null;
  return { chain: m[1], address: m[2] };
}

export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
