// /resolve の応答のフェイク（2026-09-29 監査 7 周目）。pay_if_trusted は resource があると、判定の前に
// `/resolve?q=<url>&method=` でサーバの正規化を通す。既存のハーネスはこれを前置きにして、
// 「URL は掲載に結べた（resource_id はテストが渡す id と同じ）」を既定にする。
export const RESOLVED_ID = "a".repeat(64);

/** url が /resolve なら応答を返す。そうでなければ null（呼び手は自分の経路へ進む）。 */
export function resolveReply(url, { resourceId = RESOLVED_ID, listed = true, hostListings = 1 } = {}) {
  const u = String(url);
  if (!u.includes("/resolve?")) return null;
  return { ok: true, status: 200, json: async () => resolveBody({ resourceId, listed, hostListings }), headers: new Map() };
}

export function resolveBody({ resourceId = RESOLVED_ID, listed = true, hostListings = 1 } = {}) {
  const ref = (id, path) => ({ endpoint_id: "e".repeat(64), resource_id: id, observatory_id: "o", canonical_url: `https://seller.example${path}`, method: "POST" });
  const endpoints = Array.from({ length: listed ? Math.max(1, hostListings) : hostListings }, (_, i) => ref(i === 0 && listed ? resourceId : "c".repeat(64), `/p${i}`));
  return listed
    ? { query: { kind: "url", value: "" }, resource: ref(resourceId, "/p0"), endpoints }
    : { query: { kind: "url", value: "" }, endpoints, ...(endpoints.length === 0 ? { not_found: { reason: "not_in_catalog" } } : {}) };
}
