// ============================================================
// §6.1 L0 — MPP 方言（Tempo・2026-09-17）。
//
// Tempo の壁は x402 の封筒ではなく `WWW-Authenticate: Payment …`（MPP）を返す。
// 合格条件: method="tempo" intent="charge" の challenge があり、request.currency が
// カタログの資産、amount が宣言額、methodDetails.chainId が 4217、recipient が address。
// 方言は "mpp"、受取先は learnedPayTo として返す（directory は受取先を載せない）。
// mpp_directory の endpoint に x402 の封筒だけが返っても pass ではない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeEndpoint, type ProbeTarget } from "@/lib/observatory/l0-probe";

const USDC_E = "0x20c000000000000000000000b9537d11c60e8b50";
const RECIPIENT = "0xca4e835F803cB0b7C428222B3A3B98518d4779Fe";
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function paymentHeader(over: { amount?: string; currency?: string; chainId?: number; recipient?: string } = {}) {
  const request = b64url({
    amount: over.amount ?? "25000",
    currency: over.currency ?? USDC_E,
    methodDetails: { chainId: over.chainId ?? 4217, feePayer: true },
    recipient: over.recipient ?? RECIPIENT,
  });
  return (
    `Payment id="p-1", realm="fal.mpp.tempo.xyz", method="tempo", intent="charge", request="${request}", ` +
    `description="flux, dev", expires="2099-01-01T00:00:00.000Z", ` +
    `Payment id="p-2", realm="fal.mpp.tempo.xyz", method="stripe", intent="charge", request="${b64url({ amount: "1", currency: "usd" })}"`
  );
}

function target(overrides: Partial<ProbeTarget> = {}): ProbeTarget {
  return {
    resourceUrl: "https://fal.mpp.tempo.xyz/fal-ai/flux/dev",
    method: "POST",
    payTo: null,
    network: "eip155:4217",
    priceAmount: "25000",
    priceAsset: USDC_E,
    source: "mpp_directory",
    ...overrides,
  };
}

const fake = (status: number, headers: Record<string, string>, body = "") => async () => new Response(body, { status, headers });

test("MPP: tempo/charge challenge matching the declaration → pass, dialect mpp, recipient learned (lowercased)", async () => {
  const r = await probeEndpoint(target(), { fetchImpl: fake(402, { "www-authenticate": paymentHeader() }) });
  assert.equal(r.verdict, "pass", `期待 pass、実際 ${r.verdict}/${r.failReason}`);
  assert.equal(r.dialect, "mpp");
  assert.equal(r.acceptsValid, true);
  assert.equal(r.priceConsistent, true);
  assert.equal(r.metadataConsistent, true);
  assert.equal(r.learnedPayTo, RECIPIENT.toLowerCase());
  assert.equal(r.rawResponseMeta?.envelopeSource, "www-authenticate");
  const mpp = r.rawResponseMeta?.mpp as { id: string; chainId: number | null }[];
  assert.equal(mpp.length, 1, "only tempo/charge challenges are kept in meta");
  assert.equal(mpp[0].chainId, 4217);
});

test("MPP: declared amount differs → fail price_mismatch; declared recipient differs → fail metadata_mismatch; no recipient learned", async () => {
  const price = await probeEndpoint(target(), { fetchImpl: fake(402, { "www-authenticate": paymentHeader({ amount: "30000" }) }) });
  assert.equal(price.verdict, "fail");
  assert.equal(price.failReason, "price_mismatch");
  assert.equal(price.dialect, "mpp");
  assert.equal(price.learnedPayTo ?? null, null);

  const payee = await probeEndpoint(target({ payTo: "0x0000000000000000000000000000000000000001" }), {
    fetchImpl: fake(402, { "www-authenticate": paymentHeader() }),
  });
  assert.equal(payee.verdict, "fail");
  assert.equal(payee.failReason, "metadata_mismatch");
});

test("MPP: chainId other than 4217 → metadata_mismatch (the wall is on another chain); other currency → price_mismatch", async () => {
  const chain = await probeEndpoint(target(), { fetchImpl: fake(402, { "www-authenticate": paymentHeader({ chainId: 42431 }) }) });
  assert.equal(chain.verdict, "fail");
  assert.equal(chain.failReason, "metadata_mismatch");
  const cur = await probeEndpoint(target(), {
    fetchImpl: fake(402, { "www-authenticate": paymentHeader({ currency: "0x20c0000000000000000000000000000000000000" }) }),
  });
  assert.equal(cur.verdict, "fail");
  assert.equal(cur.failReason, "price_mismatch");
});

test("MPP: recipient that is not an address → accepts_invalid (nothing payable), dialect mpp", async () => {
  const r = await probeEndpoint(target(), { fetchImpl: fake(402, { "www-authenticate": paymentHeader({ recipient: "nope" }) }) });
  assert.equal(r.verdict, "fail");
  assert.equal(r.failReason, "accepts_invalid");
  assert.equal(r.dialect, "mpp");
});

test("mpp_directory endpoint answering 402 with an x402 envelope only (nansen, 2026-09-17) → fail no_mpp_challenge, the observed x402 dialect is kept", async () => {
  const v2 = Buffer.from(
    JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "50000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: RECIPIENT }] }),
  ).toString("base64");
  const r = await probeEndpoint(target(), { fetchImpl: fake(402, { "payment-required": v2, "content-type": "application/json" }, "{}") });
  assert.equal(r.verdict, "fail");
  assert.equal(r.failReason, "no_mpp_challenge");
  assert.equal(r.dialect, "v2");
  assert.equal(r.acceptsValid, null, "x402 accepts are not counted as MPP accepts — not judged, not false");
  assert.match(String(r.rawResponseMeta?.note), /not payable by an MPP client/);
  // 封筒も challenge も無い 402 は従来どおり accepts_invalid / unpayable
  const bare = await probeEndpoint(target(), { fetchImpl: fake(402, { "content-type": "application/json" }, "{}") });
  assert.equal(bare.failReason, "accepts_invalid");
  assert.equal(bare.dialect, "unpayable");
});

test("MPP probes send Accept-Payment: tempo/charge (the reference client's header); Bazaar probes do not", async () => {
  const seen: Record<string, string | null>[] = [];
  const capture = (status: number, headers: Record<string, string>) => async (_url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    seen.push({ accept: h.get("accept"), acceptPayment: h.get("accept-payment"), contentType: h.get("content-type"), body: typeof init?.body === "string" ? init.body : null });
    return new Response("{}", { status, headers });
  };
  await probeEndpoint(target(), { fetchImpl: capture(402, { "www-authenticate": paymentHeader() }) });
  assert.equal(seen[0].acceptPayment, "tempo/charge");
  assert.equal(seen[0].body, "{}");
  await probeEndpoint(target({ resourceUrl: "https://example.com/api/x", network: "eip155:8453", source: "cdp_bazaar", priceAmount: "3000", priceAsset: "0xUSDC" }), { fetchImpl: capture(402, {}) });
  assert.equal(seen[1].acceptPayment, null);
});

// ---- request_shape（2026-09-17・L0 の公平）: challenge 無しの 400/422 を返す MPP endpoint ----------
// vet402 は要求の本文を推測して送らない（L0 は 1 要求・副作用なし）。再試行はしない。
function counting(status: number, headers: Record<string, string> = {}, body = "{}") {
  const calls: { url: string; body: string | null }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, body: typeof init?.body === "string" ? init.body : null });
    return new Response(body, { status, headers });
  };
  return { calls, fetchImpl };
}

test("MPP 400 / 422 with no Payment challenge → unverified request_shape, exactly one request, never a guessed body", async () => {
  for (const status of [400, 422]) {
    const c = counting(status, { "content-type": "application/json", link: '</openapi.json>; rel="service-desc"' }, '{"error":"symbol is required"}');
    const r = await probeEndpoint(target(), { fetchImpl: c.fetchImpl });
    assert.equal(r.verdict, "unverified");
    assert.equal(r.failReason, "request_shape");
    assert.equal(r.httpStatus, status);
    assert.equal(r.has402Challenge, null);
    assert.equal(r.acceptsValid, null);
    assert.equal(r.dialect, null);
    assert.equal(c.calls.length, 1, "one request — no retry, no OpenAPI fetch even when the 400 advertises one");
    assert.equal(c.calls[0].body, "{}", "the only body we send is the empty JSON object");
    assert.match(String(r.rawResponseMeta?.detail), /does not guess a request body/);
    assert.equal(r.rawResponseMeta?.retry, undefined);
  }
});

test("request_shape is scoped: Bazaar 400 stays no_402 fail; MPP 404 / 401 / 500 stay no_402 fail; a 400 that carries a Payment challenge stays no_402", async () => {
  const bazaar = await probeEndpoint(target({ resourceUrl: "https://example.com/api/x", network: "eip155:8453", source: "cdp_bazaar" }), { fetchImpl: fake(400, {}, "{}") });
  assert.equal(bazaar.verdict, "fail");
  assert.equal(bazaar.failReason, "no_402");
  for (const status of [401, 404, 500]) {
    const r = await probeEndpoint(target(), { fetchImpl: fake(status, {}, "{}") });
    assert.equal(r.verdict, "fail", `status ${status}`);
    assert.equal(r.failReason, "no_402");
  }
  const withChallenge = await probeEndpoint(target(), { fetchImpl: fake(400, { "www-authenticate": paymentHeader() }, "{}") });
  assert.equal(withChallenge.verdict, "fail");
  assert.equal(withChallenge.failReason, "no_402");
});

// H3（独立レビュー）: 判定は probeEndpoint の中で完結する。source を渡さない経路（demo/verify・disputes・
// requests は network だけ渡す）でも、recheck の経路でも同じ結果になる。
test("the same 400 gives the same verdict on every path: runner (source+network), demo/requests (network only), dispute recheck", async () => {
  const body = '{"error":"query required"}';
  const viaRunner = await probeEndpoint(target(), { fetchImpl: fake(400, {}, body) });
  const viaNetworkOnly = await probeEndpoint(target({ source: undefined }), { fetchImpl: fake(400, {}, body) });
  const viaRecheck = await probeEndpoint(target({ source: undefined }), { fetchImpl: fake(400, {}, body), recheck: true });
  for (const r of [viaRunner, viaNetworkOnly, viaRecheck]) {
    assert.equal(r.verdict, "unverified");
    assert.equal(r.failReason, "request_shape");
    assert.equal(r.httpStatus, 400);
  }
  assert.equal(viaRecheck.rawResponseMeta?.route, "recheck_same_egress");
});

test("every caller of probeEndpoint hands it the endpoint's network (that alone selects the MPP rules), and none passes a request-shaping option", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  for (const rel of ["src/lib/demo/verify.ts", "src/lib/observatory/disputes.ts", "src/lib/observatory/requests.ts", "src/lib/observatory/probe-runner.ts"]) {
    const src = readFileSync(join(process.cwd(), rel), "utf8");
    const at = src.indexOf("probeEndpoint(");
    assert.ok(at > 0, `${rel} calls probeEndpoint`);
    const call = src.slice(at, at + 700);
    assert.match(call, /network:/, `${rel} passes network`);
    assert.doesNotMatch(src, /requestShape|mpp-request-shape|openapi/i, `${rel} has no request-shaping path`);
  }
  const probe = readFileSync(join(process.cwd(), "src/lib/observatory/l0-probe.ts"), "utf8");
  assert.equal((probe.match(/await fetchImpl\(/g) ?? []).length, 1, "probeEndpoint sends exactly one request");
});
