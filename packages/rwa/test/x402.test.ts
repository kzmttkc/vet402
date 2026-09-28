// The paid lane (SPEC patch 017): 402 terms, payment-header checks, and the
// paths that must never charge. The facilitator is mocked; nothing reaches the chain.
//
// Run from the repo root: npx tsx --test packages/rwa/test/x402.test.ts
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET } from "../../../src/app/api/v1/rwa/paid/facts/[address]/route";
import { BadPayment, PAY_TO, PRICE_ATOMIC, USDG, b64json, parsePaymentHeader, paymentRequirements } from "../x402";

const ADDR = "0xE9B08727131E34010b34006c660D4c1B436EC25f";
const call = (headers: Record<string, string> = {}, address = ADDR) =>
  GET(new NextRequest(`http://localhost/api/v1/rwa/paid/facts/${address}`, { headers }), { params: Promise.resolve({ address }) });

function payment(over: { accepted?: Record<string, unknown>; witnessTo?: string; token?: string } = {}) {
  return {
    x402Version: 2,
    accepted: { ...paymentRequirements(), ...over.accepted },
    payload: {
      signature: "0x" + "11".repeat(65),
      permit2Authorization: {
        permitted: { token: over.token ?? USDG, amount: PRICE_ATOMIC },
        from: "0x1111111111111111111111111111111111111111",
        spender: "0x402085c248EeA27D92E8b30b2C58ed07f9E20001",
        nonce: "1",
        deadline: "9999999999",
        witness: { to: over.witnessTo ?? PAY_TO, validAfter: "0" },
      },
    },
  };
}

test("terms: exact / eip155:4663 / USDG / 0.01 / permit2, paid to the anchor wallet", () => {
  const r = paymentRequirements();
  assert.equal(r.scheme, "exact");
  assert.equal(r.network, "eip155:4663");
  assert.equal(r.asset, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  assert.equal(r.amount, "10000");
  assert.equal(r.payTo, "0x973cD8a91A771C2C04C6036888F8175D6b4F6227");
  assert.equal(r.extra.assetTransferMethod, "permit2");
});

test("no PAYMENT-SIGNATURE → 402 with PAYMENT-REQUIRED equal to the body", async () => {
  const res = await call();
  assert.equal(res.status, 402);
  const body = await res.json();
  const header = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString("utf8"));
  assert.deepEqual(header, body);
  assert.equal(body.x402Version, 2);
  assert.equal(body.accepts.length, 1);
  assert.equal(body.resource.url, `http://localhost/api/v1/rwa/paid/facts/${ADDR}`);
});

test("the header checks refuse a payment for someone else's terms", () => {
  const bad = (p: unknown, reason: string) =>
    assert.throws(() => parsePaymentHeader(b64json(p)), (e) => e instanceof BadPayment && e.reason === reason);
  bad(payment({ accepted: { payTo: "0x2222222222222222222222222222222222222222" } }), "wrong_pay_to");
  bad(payment({ accepted: { amount: "9999" } }), "amount_below_price");
  bad(payment({ accepted: { network: "eip155:8453" } }), "wrong_scheme_or_network");
  bad(payment({ accepted: { asset: "0x3333333333333333333333333333333333333333" } }), "wrong_asset");
  bad(payment({ witnessTo: "0x2222222222222222222222222222222222222222" }), "witness_to_is_not_pay_to");
  bad(payment({ token: "0x3333333333333333333333333333333333333333" }), "permitted_token_is_not_usdg");
  assert.throws(() => parsePaymentHeader("not base64 json"), BadPayment);
  assert.ok(parsePaymentHeader(b64json(payment())));
});

test("a refused header is a 402 with the reason, and the facilitator is never called", async () => {
  const f = mock.method(globalThis, "fetch", async () => new Response("{}"));
  try {
    const res = await call({ "PAYMENT-SIGNATURE": b64json(payment({ accepted: { payTo: "0x2222222222222222222222222222222222222222" } })) });
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error, "wrong_pay_to");
    assert.equal(f.mock.callCount(), 0);
  } finally {
    f.mock.restore();
  }
});

test("facilitator says invalid → 402, no settle call", async () => {
  const urls: string[] = [];
  const f = mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ isValid: false, invalidReason: "insufficient_funds" }));
  });
  try {
    const res = await call({ "PAYMENT-SIGNATURE": b64json(payment()) });
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error, "insufficient_funds");
    assert.deepEqual(urls, ["https://x402.dexter.cash/verify"]);
  } finally {
    f.mock.restore();
  }
});

test("facilitator unreachable → 502 charged:false, no settle call", async () => {
  const urls: string[] = [];
  const f = mock.method(globalThis, "fetch", async (url: string) => {
    urls.push(String(url));
    return new Response("<html>bad gateway</html>", { status: 502 });
  });
  try {
    const res = await call({ "PAYMENT-SIGNATURE": b64json(payment()) });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "facilitator_unavailable", charged: false });
    assert.deepEqual(urls, ["https://x402.dexter.cash/verify"]);
  } finally {
    f.mock.restore();
  }
});

test("invalid address never asks for money", async () => {
  const res = await call({}, "vitalik.eth");
  assert.equal(res.status, 400);
});
