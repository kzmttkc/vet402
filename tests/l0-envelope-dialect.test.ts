// ============================================================
// §6.1 L0 Liveness — 支払い封筒はヘッダにもボディにもある。
//
// 2026-09-02 実測: 本番の最新 L0 判定 6,907 件が `fail:accepts_invalid` で、
// その実例（x402.orthogonal.com）はボディ `{}`・封筒は v2 の
// `PAYMENT-REQUIRED` ヘッダ（base64 JSON）にあった。旧 parseAccepts は
// ボディしか読まず、v2 の店を「機械が払える 402 ではない」と公開していた。
// これは SLO §12「L0 誤fail率 < 3%」の違反そのもの。
//
// 仕様 §6.1 の合格条件は「PAYMENT-REQUIRED **または互換の支払い封筒**が
// パースできる」。方言（v1 / v2 / both / unpayable）は fail ではなく
// 観測属性として残す（§5「方言差は観測属性に持つ」）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeEndpoint, type ProbeTarget } from "@/lib/observatory/l0-probe";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";

const V2_ENVELOPE = Buffer.from(
  JSON.stringify({
    x402Version: 2,
    error: "Payment required",
    accepts: [{ scheme: "exact", network: "eip155:8453", amount: "3000", asset: USDC, payTo: PAY_TO }],
  }),
).toString("base64");

const V1_BODY = JSON.stringify({
  x402Version: 1,
  accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "3000", asset: USDC, payTo: PAY_TO }],
});

function target(overrides: Partial<ProbeTarget> = {}): ProbeTarget {
  return {
    resourceUrl: "https://example.com/api/x",
    method: "GET",
    payTo: PAY_TO,
    network: "eip155:8453",
    priceAmount: "3000",
    priceAsset: USDC,
    ...overrides,
  };
}

function fake(status: number, headers: Record<string, string>, body: string) {
  return async () => new Response(body, { status, headers });
}

test("v2: PAYMENT-REQUIRED ヘッダの封筒だけで pass（ボディは {}）", async () => {
  const r = await probeEndpoint(target(), {
    fetchImpl: fake(402, { "payment-required": V2_ENVELOPE, "content-type": "application/json" }, "{}"),
  });
  assert.equal(r.verdict, "pass", `期待 pass、実際 ${r.verdict}/${r.failReason}`);
  assert.equal(r.dialect, "v2");
  assert.equal(r.acceptsValid, true);
});

test("v1: ボディの accepts だけでも pass、dialect は v1", async () => {
  const r = await probeEndpoint(target(), { fetchImpl: fake(402, { "content-type": "application/json" }, V1_BODY) });
  assert.equal(r.verdict, "pass", `期待 pass、実際 ${r.verdict}/${r.failReason}`);
  assert.equal(r.dialect, "v1");
});

test("両方にあれば both", async () => {
  const r = await probeEndpoint(target(), { fetchImpl: fake(402, { "payment-required": V2_ENVELOPE }, V1_BODY) });
  assert.equal(r.verdict, "pass");
  assert.equal(r.dialect, "both");
});

test("カタログの network が v1 スラグ（base）でも CAIP-2 の封筒と一致と見なす", async () => {
  const r = await probeEndpoint(target({ network: "base" }), {
    fetchImpl: fake(402, { "payment-required": V2_ENVELOPE }, "{}"),
  });
  assert.equal(r.verdict, "pass", `期待 pass、実際 ${r.verdict}/${r.failReason}`);
  assert.equal(r.metadataConsistent, true);
});

test("402 だが封筒がどこにも無い → fail accepts_invalid / dialect unpayable", async () => {
  const r = await probeEndpoint(target(), { fetchImpl: fake(402, {}, "{}") });
  assert.equal(r.verdict, "fail");
  assert.equal(r.failReason, "accepts_invalid");
  assert.equal(r.dialect, "unpayable");
});

test("401/403 は fail no_402（鍵を要求する壁は機械が払える 402 ではない）", async () => {
  for (const status of [401, 403]) {
    const r = await probeEndpoint(target(), { fetchImpl: fake(status, {}, "") });
    assert.equal(r.verdict, "fail");
    assert.equal(r.failReason, "no_402");
  }
});

test("429（レート制限）は判定不能 → unverified、fail にしない", async () => {
  const r = await probeEndpoint(target(), { fetchImpl: fake(429, {}, "") });
  assert.equal(r.verdict, "unverified");
  assert.equal(r.failReason, "rate_limited");
});

test("TLS エラーは判定不能 → unverified（§6.1）", async () => {
  const err = Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" });
  const r = await probeEndpoint(target(), {
    fetchImpl: async () => {
      throw err;
    },
  });
  assert.equal(r.verdict, "unverified");
  assert.equal(r.failReason, "tls");
});

test("DNS 不能・タイムアウトは到達不能 → fail（公開到達可能が合格条件）", async () => {
  const dns = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
  const r = await probeEndpoint(target(), {
    fetchImpl: async () => {
      throw dns;
    },
  });
  assert.equal(r.verdict, "fail");
  assert.equal(r.failReason, "dns");
});

test("method 未宣言は GET で測る（§6.1「GET および、掲載が POST のみなら POST」）", async () => {
  let seen: string | undefined;
  const r = await probeEndpoint(target({ method: null }), {
    fetchImpl: async (_url, init) => {
      seen = init?.method;
      return new Response("{}", { status: 402, headers: { "payment-required": V2_ENVELOPE } });
    },
  });
  assert.equal(seen, "GET");
  assert.equal(r.method, "GET");
  assert.equal(r.verdict, "pass");
});

test("rawResponseMeta に方言と封筒の所在が残る（再現手順の材料）", async () => {
  const r = await probeEndpoint(target(), { fetchImpl: fake(402, { "payment-required": V2_ENVELOPE }, "{}") });
  assert.equal(r.rawResponseMeta?.dialect, "v2");
  assert.equal(r.rawResponseMeta?.envelopeSource, "header");
});
