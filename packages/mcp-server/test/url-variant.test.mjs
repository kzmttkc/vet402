// URL の書き方しだいで BLOCK を素通りしない（2026-09-29 監査 7 周目・高）。
//
// 穴: 凍結中の SDK と、それに id を渡す pay_if_trusted は、resource_id を生の URL から
// sha256("<METHOD> <url>") で作れた。表記が違う（末尾スラッシュ・ホストの大文字・:443・クエリの並び）と
// /decision は 404 → 「カタログ外」として受取人スコア（ここでは ALLOW）で払えた——BLOCK の資源にも。
// 直し: 払う前に /resolve でサーバの正規化を通し、正規の id で判定と SDK を引く。結べないのにホストに
// 掲載があれば払わない。404 は host_known: false のときだけカタログ外として SDK へ渡す。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { payIfTrusted } from "../dist/pay-if-trusted.js";

const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const PAYEE = "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB";
const b64 = (o) => btoa(JSON.stringify(o));
const ACCEPT = { scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAYEE, extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" } };

/** サーバの正規化の写し（テスト用の最小形: host 小文字・:443 除去・末尾スラッシュ除去・クエリ辞書順）。 */
function canonical(raw) {
  const u = new URL(raw);
  const path = u.pathname.replace(/\/+$/, "");
  const q = [...u.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
  return `https://${u.host.toLowerCase()}${path}${q ? `?${q}` : ""}`;
}

/** 掲載 2 件（同じホスト）と、その判定を持つ偽の vet402 ＋ 402 を返す売り手。 */
function world({ listings, hostKnownOn404 = "compute" } = {}) {
  const byId = new Map(listings.map((l) => [sha(`${l.method} ${canonical(l.url)}`), l]));
  const calls = [];
  const accessed = [];
  const signer = new Proxy(
    { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => `0x${"ab".repeat(32)}1b` },
    { get: (t, p) => (accessed.push(String(p)), Reflect.get(t, p)) },
  );
  // サーバと同じ: 同じホスト（サブドメインを含めない）の掲載中（active）の出品だけ。受取人の人数も返す。
  const live = (raw) => listings.filter((l) => (l.status ?? "active") === "active" && new URL(canonical(l.url)).host === new URL(canonical(raw)).host);
  const hostListed = (raw) => live(raw).length > 0;
  const json = (status, body, headers = new Map()) => ({ ok: status < 400, status, json: async () => body, headers });
  const fetch = async (u, init) => {
    const url = new URL(String(u));
    calls.push(String(u));
    if (url.pathname.endsWith("/resolve")) {
      const q = url.searchParams.get("q");
      const m = url.searchParams.get("method") ?? "GET";
      const id = sha(`${m} ${canonical(q)}`);
      const hit = byId.get(id);
      const endpoints = listings.filter((l) => hostListed(q)).map((l) => ({ resource_id: sha(`${l.method} ${canonical(l.url)}`), canonical_url: canonical(l.url), method: l.method, endpoint_id: "e" }));
      return json(200, { query: { kind: "url", value: q }, ...(hit ? { resource: { resource_id: id, canonical_url: canonical(q), method: m, endpoint_id: "e" } } : {}), endpoints });
    }
    const dm = /\/resources\/([0-9a-f]{64})\/decision/.exec(url.pathname);
    if (dm) {
      const l = byId.get(dm[1]);
      if (!l) {
        const raw = url.searchParams.get("url");
        const hk = hostKnownOn404 === "compute" ? (raw ? hostListed(raw) : null) : hostKnownOn404;
        const sellers = hostKnownOn404 === "compute" && raw ? new Set(live(raw).map((l) => l.payee ?? PAYEE)).size : undefined;
        return json(404, hk === "absent" ? { error: "not_found" } : { error: "not_found", host_known: hk, ...(sellers === undefined ? {} : { host_sellers: sellers }) });
      }
      return json(200, { recommendation: l.recommendation, reason_codes: l.recommendation === "BLOCK" ? ["l0_fail"] : ["l0_pass", "l1_delivered"], facts: {}, evidence: [], degraded: false });
    }
    if (url.pathname.includes("/payees/")) return json(200, { recommendation: "ALLOW", score: 90, degraded: false, signalsUnavailable: [] });
    if (url.pathname.includes("/payments/x402")) return json(200, {});
    // 売り手（どの書き方でも同じ売り手）
    const h = init?.headers ?? {};
    if (!h["PAYMENT-SIGNATURE"]) return json(402, {}, new Map([["payment-required", b64({ x402Version: 2, accepts: [ACCEPT] })]]));
    return json(200, { data: "ok" }, new Map([["PAYMENT-RESPONSE", b64({ success: true, transaction: "0xtx", network: ACCEPT.network })]]));
  };
  return { fetch, calls, signer, signs: () => accessed.filter((k) => k.startsWith("sign")) };
}

const BLOCKED = { url: "https://api.exa.ai/search", method: "POST", recommendation: "BLOCK" };
const NEIGHBOUR = { url: "https://api.exa.ai/contents", method: "POST", recommendation: "ALLOW" };
const QUERY_BLOCKED = { url: "https://q.example/x?a=1&b=2", method: "GET", recommendation: "BLOCK" };

const SPELLINGS = [
  ["末尾スラッシュ", "POST", "https://api.exa.ai/search/"],
  ["ホストの大文字", "POST", "https://API.EXA.AI/search"],
  ["既定ポート :443", "POST", "https://api.exa.ai:443/search"],
  ["全部の組み合わせ", "POST", "https://API.EXA.AI:443/search/"],
  ["クエリの並び", "GET", "https://q.example/x?b=2&a=1"],
];

for (const [label, method, url] of SPELLINGS) {
  test(`${label}: SDK と同じ生の id（sha256("${method} ${url}")）を渡しても BLOCK の資源に払わない`, async () => {
    const w = world({ listings: [BLOCKED, NEIGHBOUR, QUERY_BLOCKED] });
    const r = await payIfTrusted({ resourceId: sha(`${method} ${url}`), resource: url, method, payee: PAYEE, amountUsd: 0.01, maxPerTxUsd: 1, signer: w.signer, fetch: w.fetch });
    assert.equal(r.decision, "REFUSE", JSON.stringify(r));
    assert.ok(r.refuse_reasons.includes("l0_fail"), `BLOCK の理由がそのまま返る: ${r.refuse_reasons}`);
    assert.deepEqual(w.signs(), [], "署名器に触っていない");
    assert.equal(w.calls.filter((c) => !c.includes("/api/v1") && !c.includes("vet402")).length, 0, "売り手へ出ていない");
    const decisionIds = w.calls.map((c) => /\/resources\/([0-9a-f]{64})\/decision/.exec(c)?.[1]).filter(Boolean);
    const canonicalId = sha(`${method} ${canonical(url)}`);
    assert.ok(decisionIds.length > 0 && decisionIds.every((id) => id === canonicalId), "判定は正規の id で引いた");
  });
}

test("対照: 正規の書き方の ALLOW の隣は払える（直しが「常に拒否」に退化していない）・SDK も正規の id で引く", async () => {
  const w = world({ listings: [BLOCKED, NEIGHBOUR] });
  const spelled = "https://API.exa.ai/contents/";
  const r = await payIfTrusted({ resourceId: sha(`POST ${spelled}`), resource: spelled, method: "POST", payee: PAYEE, amountUsd: 0.01, maxPerTxUsd: 1, signer: w.signer, fetch: w.fetch });
  assert.equal(r.decision, "PAID", JSON.stringify(r.refuse_reasons));
  assert.equal(w.signs().length, 1);
  assert.match(r.summary, /used vet402's id/, "渡した id を差し替えたことを言う");
  const decisionIds = w.calls.map((c) => /\/resources\/([0-9a-f]{64})\/decision/.exec(c)?.[1]).filter(Boolean);
  assert.ok(decisionIds.length >= 2, "MCP と SDK の 2 回");
  assert.ok(decisionIds.every((id) => id === sha(`POST ${canonical(NEIGHBOUR.url)}`)));
});

test("掲載に結べないのに、同じホストに 1 人の売り手の掲載中の出品がある URL は払わない（resource_unresolved_host_known）", async () => {
  const w = world({ listings: [BLOCKED] });
  const url = "https://api.exa.ai/search/v2"; // 同じホストの、掲載に無い書き方
  const r = await payIfTrusted({ resourceId: sha(`POST ${url}`), resource: url, method: "POST", payee: PAYEE, amountUsd: 0.01, maxPerTxUsd: 1, signer: w.signer, fetch: w.fetch });
  assert.equal(r.decision, "REFUSE");
  assert.ok(r.refuse_reasons.includes("resource_unresolved_host_known"), String(r.refuse_reasons));
  assert.deepEqual(w.signs(), []);
});

test("本当にカタログ外（ホストにも掲載なし・404 が host_known: false）は従来どおり SDK が受取人スコアで判定する", async () => {
  const w = world({ listings: [BLOCKED] });
  const url = "https://unlisted.example/x";
  const r = await payIfTrusted({ resourceId: sha(`GET ${url}`), resource: url, payee: PAYEE, amountUsd: 0.01, maxPerTxUsd: 1, signer: w.signer, fetch: w.fetch });
  assert.equal(r.decision, "PAID", JSON.stringify(r.refuse_reasons));
  assert.ok(w.calls.some((c) => c.includes("/payees/")), "受取人スコアを引いた");
  assert.ok(w.calls.some((c) => c.includes("/decision") && c.includes("url=")), "404 の理由を問うため url= を付けた");
});

for (const [label, hk, reason] of [
  ["404 に host_known が無い（理由が分からない）", "absent", "evidence_unavailable"],
  ["404 が host_known: null", null, "evidence_unavailable"],
  ["404 が host_known: true", true, "resource_unresolved_host_known"],
]) {
  test(`${label} → 払わない`, async () => {
    const w = world({ listings: [BLOCKED], hostKnownOn404: hk });
    const url = "https://unlisted.example/x";
    const r = await payIfTrusted({ resourceId: sha(`GET ${url}`), resource: url, payee: PAYEE, amountUsd: 0.01, maxPerTxUsd: 1, signer: w.signer, fetch: w.fetch });
    assert.equal(r.decision, "REFUSE");
    assert.ok(r.refuse_reasons.includes(reason), String(r.refuse_reasons));
    assert.deepEqual(w.signs(), []);
  });
}

test("払う URL は掲載に無いのに、resourceId が別の掲載（ALLOW）を指す → 払わない（resource_id_mismatch）", async () => {
  const w = world({ listings: [NEIGHBOUR] });
  const url = "https://unlisted.example/x";
  const r = await payIfTrusted({ resourceId: sha(`POST ${NEIGHBOUR.url}`), resource: url, method: "POST", payee: PAYEE, amountUsd: 0.01, maxPerTxUsd: 1, signer: w.signer, fetch: w.fetch });
  assert.equal(r.decision, "REFUSE");
  assert.ok(r.refuse_reasons.includes("resource_id_mismatch"), String(r.refuse_reasons));
  assert.deepEqual(w.signs(), []);
});

test("/resolve が読めない → 払わない（evidence_unavailable）・判定も署名も無し", async () => {
  const w = world({ listings: [BLOCKED] });
  const fetch = async (u, init) => (String(u).includes("/resolve?") ? { ok: false, status: 503, json: async () => ({ error: "resolve_unavailable" }), headers: new Map() } : w.fetch(u, init));
  const r = await payIfTrusted({ resourceId: sha("POST https://api.exa.ai/search/"), resource: "https://api.exa.ai/search/", method: "POST", payee: PAYEE, amountUsd: 0.01, maxPerTxUsd: 1, signer: w.signer, fetch });
  assert.equal(r.decision, "REFUSE");
  assert.deepEqual(r.refuse_reasons, ["evidence_unavailable"]);
  assert.deepEqual(w.signs(), []);
});

const SHARED = [
  { url: "https://x402.shared.example/a", method: "GET", recommendation: "BLOCK", payee: "0x" + "01".repeat(20) },
  { url: "https://x402.shared.example/b", method: "GET", recommendation: "ALLOW", payee: "0x" + "02".repeat(20) },
];

test("共有ホスト（受取人 2 人以上）の未掲載の売り手は止めない: 既定はカタログ外と同じで払い、summary に resource_unresolved", async () => {
  const w = world({ listings: SHARED });
  const url = "https://x402.shared.example/new-seller";
  const r = await payIfTrusted({ resourceId: sha(`GET ${url}`), resource: url, payee: PAYEE, amountUsd: 0.01, maxPerTxUsd: 1, signer: w.signer, fetch: w.fetch });
  assert.equal(r.decision, "PAID", JSON.stringify(r.refuse_reasons));
  assert.match(r.summary, /resource_unresolved/);
  assert.ok(w.calls.some((c) => c.includes("/payees/")), "カタログ外と同じく受取人スコアで判定した");
});

test("共有ホストの未掲載の売り手は onUnresolved: refuse なら払わない（resource_unresolved）", async () => {
  const w = world({ listings: SHARED });
  const url = "https://x402.shared.example/new-seller";
  const r = await payIfTrusted({ resourceId: sha(`GET ${url}`), resource: url, payee: PAYEE, amountUsd: 0.01, maxPerTxUsd: 1, signer: w.signer, fetch: w.fetch, onUnresolved: "refuse" });
  assert.equal(r.decision, "REFUSE");
  assert.ok(r.refuse_reasons.includes("resource_unresolved"), String(r.refuse_reasons));
  assert.deepEqual(w.signs(), []);
});

test("取り下げ済みの出品しか無いホストでは止めない（host_known: false・カタログ外として判定）", async () => {
  const w = world({ listings: [{ ...BLOCKED, url: "https://gone.example/search", status: "delisted" }] });
  const url = "https://gone.example/other";
  const r = await payIfTrusted({ resourceId: sha(`POST ${url}`), resource: url, method: "POST", payee: PAYEE, amountUsd: 0.01, maxPerTxUsd: 1, signer: w.signer, fetch: w.fetch });
  assert.equal(r.decision, "PAID", JSON.stringify(r.refuse_reasons));
});

test("サブドメインの掲載は同じホストに数えない（host_known: false）", async () => {
  const w = world({ listings: [{ ...BLOCKED, url: "https://api.sub.example/search" }] });
  const url = "https://sub.example/other";
  const r = await payIfTrusted({ resourceId: sha(`POST ${url}`), resource: url, method: "POST", payee: PAYEE, amountUsd: 0.01, maxPerTxUsd: 1, signer: w.signer, fetch: w.fetch });
  assert.equal(r.decision, "PAID", JSON.stringify(r.refuse_reasons));
});
