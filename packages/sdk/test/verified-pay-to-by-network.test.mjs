// verified_pay_to_by_network: cross-rail payee check when the field is present.
import test from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { pay } from "../dist/index.js";

const GOOD = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const GOOD_EIP55 = getAddress(GOOD);
const EVIL = "0x2222222222222222222222222222222222222222";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ARB_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const RESOURCE = "https://good-seller.example/api/data";
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

function decisionBody(terms, { payees, verifiedPayToByNetwork, omitVerifiedList } = {}) {
  const body = {
    recommendation: "ALLOW",
    reason_codes: ["l0_pass", "l1_delivered"],
    degraded: false,
    facts: payees ? { payees } : {},
    evidence: [],
    rules_version: "stub",
    scoredAt: new Date().toISOString(),
    cacheExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    verified_terms: terms,
  };
  if (!omitVerifiedList && verifiedPayToByNetwork !== undefined) {
    body.verified_pay_to_by_network = verifiedPayToByNetwork;
  }
  return body;
}

const challenge = (payTo, amount) =>
  b64({
    x402Version: 2,
    accepts: [
      { scheme: "exact", network: "eip155:8453", amount, asset: USDC, payTo, maxTimeoutSeconds: 60 },
    ],
  });

function stubFetch(decision, payTo, amount) {
  return async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init.headers);
    const paid = headers.has("payment-signature") || headers.has("x-payment");
    if (url.includes("/resolve")) {
      return new Response(JSON.stringify({ resource: { resource_id: "a".repeat(64) } }), { status: 200 });
    }
    if (url.includes("/decision")) return new Response(JSON.stringify(decision), { status: 200 });
    if (url.includes("/payments/x402")) return new Response("{}");
    if (url === RESOURCE && !paid) {
      return new Response(null, { status: 402, headers: { "payment-required": challenge(payTo, amount) } });
    }
    if (url === RESOURCE && paid) {
      return new Response("{}", {
        status: 200,
        headers: {
          "payment-response": b64({
            success: true,
            transaction: "0x" + "ab".repeat(32),
            network: "eip155:8453",
          }),
        },
      });
    }
    return new Response("{}", { status: 500 });
  };
}

const account = {
  address: "0x3333333333333333333333333333333333333333",
  signTypedData: async () => "0x" + "00".repeat(65),
};

const ARB_TERMS = {
  purchase_id: "p-arb",
  pay_to: GOOD,
  asset: ARB_USDC,
  amount: "10000",
  decimals: 6,
  network: "eip155:42161",
  scheme: "exact",
};

const verifiedRow = (payTo = GOOD) => ({
  network: "eip155:8453",
  pay_to: payTo,
  purchase_id: "eip155:8453:0x" + "cd".repeat(32),
  verified_at: "2026-11-22T00:00:00.000Z",
});

test("cross-rail: (network, payTo) in verified_pay_to_by_network → paid", async () => {
  const decision = decisionBody(ARB_TERMS, {
    payees: [],
    verifiedPayToByNetwork: [verifiedRow()],
  });
  const r = await pay(RESOURCE, undefined, { account, fetch: stubFetch(decision, GOOD, "10000") });
  assert.equal(r.status, "paid", JSON.stringify(r.reasonCodes ?? []));
});

test("cross-rail: pair absent from verified_pay_to_by_network → payee_unverified_on_rail", async () => {
  const decision = decisionBody(ARB_TERMS, {
    payees: [`eip155:8453:${GOOD}`],
    verifiedPayToByNetwork: [verifiedRow(EVIL)],
  });
  const r = await pay(RESOURCE, undefined, { account, fetch: stubFetch(decision, GOOD, "10000") });
  assert.equal(r.status, "refused");
  assert.ok(r.reasonCodes.includes("payee_unverified_on_rail"));
});

test("cross-rail: field absent → facts.payees fallback (known payee pays)", async () => {
  const decision = decisionBody(ARB_TERMS, {
    payees: [`eip155:8453:${GOOD}`],
    omitVerifiedList: true,
  });
  const r = await pay(RESOURCE, undefined, { account, fetch: stubFetch(decision, GOOD, "10000") });
  assert.equal(r.status, "paid", JSON.stringify(r.reasonCodes ?? []));
});

test("cross-rail: field absent → facts.payees fallback (unknown payee refused)", async () => {
  const decision = decisionBody(ARB_TERMS, {
    payees: [`eip155:8453:${EVIL}`],
    omitVerifiedList: true,
  });
  const r = await pay(RESOURCE, undefined, { account, fetch: stubFetch(decision, GOOD, "10000") });
  assert.equal(r.status, "refused");
  assert.ok(r.reasonCodes.includes("payee_unverified_on_rail"));
});

test("cross-rail: mixed-case EVM payTo in 402 matches lowercase verified_pay_to_by_network row", async () => {
  const decision = decisionBody(ARB_TERMS, {
    payees: [],
    verifiedPayToByNetwork: [verifiedRow(GOOD.toLowerCase())],
  });
  const r = await pay(RESOURCE, undefined, {
    account,
    fetch: stubFetch(decision, GOOD_EIP55, "10000"),
  });
  assert.equal(r.status, "paid", JSON.stringify(r.reasonCodes ?? []));
});