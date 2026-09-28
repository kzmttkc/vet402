// The paid lane (SPEC patch 017): 402 terms, payment-header checks, and the
// money invariants. Nobody is charged for a record they did not get; once
// settle has been sent, the record comes back unless the facilitator said
// plainly that no money moved. The facilitator is mocked and the record comes
// from a pre-filled cache; nothing reaches the chain.
//
// Run from the repo root: npx tsx --test packages/rwa/test/x402.test.ts
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { GET } from "../../../src/app/api/v1/rwa/paid/facts/[address]/route";
import { __resetFactsCacheForTest, cachedFactsWith } from "../cache";
import {
  BadPayment,
  PAY_TO,
  PERMIT2,
  PRICE_ATOMIC,
  USDG,
  X402_PERMIT2_PROXY,
  b64json,
  checkSignature,
  parsePaymentHeader,
  paymentRequirements,
  type PaymentPayload,
} from "../x402";

const ADDR = "0xE9B08727131E34010b34006c660D4c1B436EC25f";
// A fixed test key (well known, never funded). Only used to sign in these tests.
const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const FAKE_FACTS = { address: ADDR.toLowerCase(), chain_id: 4663, r1_status: "partial" };
const TX = "0x" + "ab".repeat(32);

const call = (headers: Record<string, string> = {}, address = ADDR) =>
  GET(new NextRequest(`http://localhost/api/v1/rwa/paid/facts/${address}`, { headers }), { params: Promise.resolve({ address }) });

async function signed(over: { to?: string; token?: string; amount?: string; spender?: string; deadline?: bigint; validAfter?: bigint; accepted?: Record<string, unknown> } = {}): Promise<PaymentPayload> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const m = {
    permitted: { token: (over.token ?? USDG) as `0x${string}`, amount: BigInt(over.amount ?? PRICE_ATOMIC) },
    spender: (over.spender ?? X402_PERMIT2_PROXY) as `0x${string}`,
    nonce: 12345n,
    deadline: over.deadline ?? now + 120n,
    witness: { to: (over.to ?? PAY_TO) as `0x${string}`, validAfter: over.validAfter ?? now - 60n },
  };
  const signature = await payer.signTypedData({
    domain: { name: "Permit2", chainId: 4663, verifyingContract: PERMIT2 },
    types: {
      PermitWitnessTransferFrom: [
        { name: "permitted", type: "TokenPermissions" },
        { name: "spender", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "witness", type: "Witness" },
      ],
      TokenPermissions: [
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
      ],
      Witness: [
        { name: "to", type: "address" },
        { name: "validAfter", type: "uint256" },
      ],
    },
    primaryType: "PermitWitnessTransferFrom",
    message: m,
  });
  return {
    x402Version: 2,
    accepted: { ...paymentRequirements(), ...over.accepted },
    payload: {
      signature,
      permit2Authorization: {
        permitted: { token: m.permitted.token, amount: m.permitted.amount.toString() },
        from: payer.address,
        spender: m.spender,
        nonce: m.nonce.toString(),
        deadline: m.deadline.toString(),
        witness: { to: m.witness.to, validAfter: m.witness.validAfter.toString() },
      },
    },
  };
}

/** Facilitator mock: answers /verify and /settle from the given functions and records the calls. */
function facilitator(verify: () => Response, settle: () => Response | Promise<Response>) {
  const calls: string[] = [];
  const f = mock.method(globalThis, "fetch", async (url: string) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    return path === "/verify" ? verify() : settle();
  });
  return { calls, restore: () => f.mock.restore() };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const decode = (h: string | null) => (h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null);
const prefill = () => cachedFactsWith(ADDR, async () => FAKE_FACTS as never);

beforeEach(() => __resetFactsCacheForTest());

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
  assert.deepEqual(decode(res.headers.get("PAYMENT-REQUIRED")), body);
  assert.equal(body.x402Version, 2);
  assert.equal(body.resource.url, `http://localhost/api/v1/rwa/paid/facts/${ADDR}`);
});

test("the header checks refuse a payment for anything but our exact terms", async () => {
  const bad = async (p: Promise<PaymentPayload> | PaymentPayload, reason: string) => {
    const header = b64json(await p);
    assert.throws(() => parsePaymentHeader(header), (e) => e instanceof BadPayment && e.reason === reason, reason);
  };
  const other = "0x2222222222222222222222222222222222222222";
  await bad(signed({ accepted: { payTo: other } }), "wrong_pay_to");
  await bad(signed({ accepted: { amount: "9999" } }), "amount_is_not_the_price");
  await bad(signed({ accepted: { amount: "20000" } }), "amount_is_not_the_price");
  await bad(signed({ accepted: { network: "eip155:8453" } }), "wrong_scheme_or_network");
  await bad(signed({ accepted: { asset: other } }), "wrong_asset");
  await bad(signed({ to: other }), "witness_to_is_not_pay_to");
  await bad(signed({ token: other }), "permitted_token_is_not_usdg");
  await bad(signed({ amount: "20000" }), "permitted_amount_is_not_the_price");
  await bad(signed({ spender: other }), "spender_is_not_the_x402_proxy");
  const now = BigInt(Math.floor(Date.now() / 1000));
  await bad(signed({ deadline: now + 10n }), "deadline_too_soon");
  await bad(signed({ validAfter: now + 600n }), "not_valid_yet");
  const noAuth = await signed();
  delete (noAuth.payload as Record<string, unknown>).permit2Authorization;
  await bad(noAuth, "permit2_authorization_required");
  assert.throws(() => parsePaymentHeader("not base64 json"), BadPayment);
  assert.ok(parsePaymentHeader(b64json(await signed())));
});

test("the signature is recovered locally; a tampered one never reaches the facilitator", async () => {
  const good = await signed();
  assert.equal(await checkSignature(good), true);
  const tampered = structuredClone(good);
  (tampered.payload as { permit2Authorization: { nonce: string } }).permit2Authorization.nonce = "999";
  assert.equal(await checkSignature(tampered), false);
  const fx = facilitator(() => json({ isValid: true }), () => json({ success: true, transaction: TX }));
  try {
    const res = await call({ "PAYMENT-SIGNATURE": b64json(tampered) });
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error, "signature_does_not_match_from");
    assert.deepEqual(fx.calls, []);
  } finally {
    fx.restore();
  }
});

test("facilitator says invalid → 402, no settle", async () => {
  const fx = facilitator(() => json({ isValid: false, invalidReason: "insufficient_funds" }, 400), () => json({}));
  try {
    const res = await call({ "PAYMENT-SIGNATURE": b64json(await signed()) });
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error, "insufficient_funds");
    assert.deepEqual(fx.calls, ["/verify"]);
  } finally {
    fx.restore();
  }
});

test("facilitator unreachable at verify → 502 charged:false, no settle", async () => {
  const fx = facilitator(() => new Response("<html>bad gateway</html>", { status: 502 }), () => json({}));
  try {
    const res = await call({ "PAYMENT-SIGNATURE": b64json(await signed()) });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "facilitator_unavailable", charged: false });
    assert.deepEqual(fx.calls, ["/verify"]);
  } finally {
    fx.restore();
  }
});

test("no reconstruction slot free → 503 too_busy charged:false, never settled", async () => {
  const fx = facilitator(() => json({ isValid: true }), () => json({ success: true, transaction: TX }));
  let release!: () => void;
  const slot = cachedFactsWith("0x000000000000000000000000000000000000dEaD", () => new Promise((r) => (release = () => r(FAKE_FACTS as never))));
  try {
    const res = await call({ "PAYMENT-SIGNATURE": b64json(await signed()) });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "too_busy", charged: false });
    assert.deepEqual(fx.calls, ["/verify"]);
  } finally {
    release();
    await slot;
    fx.restore();
  }
});

test("settled → 200 with the record and PAYMENT-RESPONSE", async () => {
  await prefill();
  const fx = facilitator(() => json({ isValid: true, payer: payer.address }), () => json({ success: true, transaction: TX, network: "eip155:4663", payer: payer.address }));
  try {
    const res = await call({ "PAYMENT-SIGNATURE": b64json(await signed()) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).r1_status, "partial");
    assert.equal(res.headers.get("X-Payment-Status"), "settled");
    assert.equal(decode(res.headers.get("PAYMENT-RESPONSE")).transaction, TX);
    assert.deepEqual(fx.calls, ["/verify", "/settle"]);
  } finally {
    fx.restore();
  }
});

test("settle says success:false → 402 (no money moved), with the facilitator's answer", async () => {
  await prefill();
  const fx = facilitator(() => json({ isValid: true }), () => json({ success: false, errorReason: "nonce_used", transaction: "" }));
  try {
    const res = await call({ "PAYMENT-SIGNATURE": b64json(await signed()) });
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error, "nonce_used");
    assert.equal(decode(res.headers.get("PAYMENT-RESPONSE")).success, false);
  } finally {
    fx.restore();
  }
});

test("settle outcome unknown (5xx, non-JSON, thrown, success:false with a tx hash) → the record still comes back, marked unknown", async () => {
  const replies: Array<() => Response | Promise<Response>> = [
    () => json({ error: "internal" }, 500),
    () => new Response("<html>oops</html>", { status: 200 }),
    () => json({ success: true, transaction: "not-a-hash" }),
    () => Promise.reject(new Error("socket hang up")),
    () => json({ success: false, errorReason: "timeout_after_broadcast", transaction: TX }),
  ];
  for (const settle of replies) {
    __resetFactsCacheForTest();
    await prefill();
    const fx = facilitator(() => json({ isValid: true }), settle);
    try {
      const res = await call({ "PAYMENT-SIGNATURE": b64json(await signed()) });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).r1_status, "partial");
      assert.equal(res.headers.get("X-Payment-Status"), "unknown");
      assert.equal(res.headers.get("PAYMENT-RESPONSE"), null);
      assert.deepEqual(fx.calls, ["/verify", "/settle"]);
    } finally {
      fx.restore();
    }
  }
});

test("invalid address never asks for money", async () => {
  const res = await call({}, "vitalik.eth");
  assert.equal(res.status, 400);
});
