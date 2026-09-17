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

test("mpp_directory endpoint answering 402 with an x402 envelope (no Payment challenge) is not a pass", async () => {
  const v2 = Buffer.from(
    JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:4217", amount: "25000", asset: USDC_E, payTo: RECIPIENT }] }),
  ).toString("base64");
  const r = await probeEndpoint(target(), { fetchImpl: fake(402, { "payment-required": v2, "content-type": "application/json" }, "{}") });
  assert.equal(r.verdict, "fail");
  assert.equal(r.failReason, "accepts_invalid");
  assert.equal(r.dialect, "unpayable");
  assert.match(String(r.rawResponseMeta?.note), /not payable by an MPP client/);
});

test("a Bazaar-sourced endpoint keeps the x402 envelope path untouched (no Payment header → v2 as before)", async () => {
  const v2 = Buffer.from(
    JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "3000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea" }] }),
  ).toString("base64");
  const r = await probeEndpoint(
    target({ resourceUrl: "https://example.com/api/x", network: "eip155:8453", priceAmount: "3000", priceAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea", source: "cdp_bazaar" }),
    { fetchImpl: fake(402, { "payment-required": v2 }, "{}") },
  );
  assert.equal(r.verdict, "pass");
  assert.equal(r.dialect, "v2");
  assert.equal(r.learnedPayTo ?? null, null);
});

test("MPP: a 200 from an MPP endpoint is no_402 like any other wall that did not stand", async () => {
  const r = await probeEndpoint(target(), { fetchImpl: fake(200, { "content-type": "application/json" }, "{}") });
  assert.equal(r.verdict, "fail");
  assert.equal(r.failReason, "no_402");
});
