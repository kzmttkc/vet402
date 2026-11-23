// Base USDC paid facts lane: EIP-3009 on Base, CDP facilitator mocked, no network.
//
// Run: env -u DATABASE_URL npx tsx --test tests/rwa-paid-base.test.ts
import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { GET as BASE_GET } from "../src/app/api/v1/rwa/paid/base/facts/[address]/route";
import { GET as LEGACY_GET } from "../src/app/api/v1/rwa/paid/facts/[address]/route";
import { __resetFactsCacheForTest, cachedFactsWith } from "../packages/rwa/cache";
import {
  BadPayment,
  PAY_TO,
  PRICE_ATOMIC,
  USDC,
  X402_NETWORK,
  b64json,
  bazaarSchema,
  checkSignature,
  parsePaymentHeader,
  paymentRequirements,
  type BasePaymentPayload,
} from "../src/lib/x402/base-usdc";
import { USDG } from "../packages/rwa/x402";

const ADDR = "0xE9B08727131E34010b34006c660D4c1B436EC25f";
const payer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const FAKE_FACTS = { address: ADDR.toLowerCase(), chain_id: 4663, r1_status: "partial" };
const TX = "0x" + "ab".repeat(32);

const CDP_TEST_SECRET = "gwrAzv+S9djcR8qZOUYBHU2R899xB4LyjHEnyHjtWxhGheBgssJP6A3GwOglg5js82tCuMVU9L6sKxgJ1I0RQw==";

const TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const callBase = (headers: Record<string, string> = {}, address = ADDR) =>
  BASE_GET(new NextRequest(`http://localhost/api/v1/rwa/paid/base/facts/${address}`, { headers }), { params: Promise.resolve({ address }) });

const callLegacy = (address = ADDR) =>
  LEGACY_GET(new NextRequest(`http://localhost/api/v1/rwa/paid/facts/${address}`), { params: Promise.resolve({ address }) });

let savedId: string | undefined;
let savedSecret: string | undefined;

beforeEach(() => {
  __resetFactsCacheForTest();
  savedId = process.env.CDP_API_KEY_ID;
  savedSecret = process.env.CDP_API_KEY_SECRET;
  process.env.CDP_API_KEY_ID = "test-key-id";
  process.env.CDP_API_KEY_SECRET = CDP_TEST_SECRET;
});

afterEach(() => {
  if (savedId === undefined) delete process.env.CDP_API_KEY_ID;
  else process.env.CDP_API_KEY_ID = savedId;
  if (savedSecret === undefined) delete process.env.CDP_API_KEY_SECRET;
  else process.env.CDP_API_KEY_SECRET = savedSecret;
});

async function signed(over: {
  to?: string;
  value?: string;
  validBefore?: bigint;
  validAfter?: bigint;
  accepted?: Record<string, unknown>;
  nonce?: string;
} = {}): Promise<BasePaymentPayload> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const auth = {
    from: payer.address,
    to: (over.to ?? PAY_TO) as `0x${string}`,
    value: over.value ?? PRICE_ATOMIC,
    validAfter: (over.validAfter ?? now - 60n).toString(),
    validBefore: (over.validBefore ?? now + 120n).toString(),
    nonce: over.nonce ?? `0x${"11".repeat(32)}`,
  };
  const signature = await payer.signTypedData({
    domain: { name: "USD Coin", version: "2", chainId: 8453, verifyingContract: USDC as `0x${string}` },
    types: TRANSFER_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce as `0x${string}`,
    },
  });
  return {
    x402Version: 2,
    accepted: { ...paymentRequirements(), ...over.accepted },
    payload: { signature, authorization: auth },
  };
}

function facilitator(verify: () => Response, settle: () => Response | Promise<Response>) {
  const calls: { path: string; auth?: string; body?: string }[] = [];
  const f = mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url instanceof Request ? url.url : url.toString());
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ path: u.pathname, auth, body });
    return u.pathname.endsWith("/verify") ? verify() : settle();
  });
  return { calls, restore: () => f.mock.restore() };
}

const json = (v: unknown, status = 200, extraHeaders?: Record<string, string>) =>
  new Response(JSON.stringify(v), { status, headers: extraHeaders });
const decode = (h: string | null) => (h ? JSON.parse(Buffer.from(h, "base64").toString("utf8")) : null);
const prefill = () => cachedFactsWith(ADDR, async () => FAKE_FACTS as never);

/** Minimal draft-2020-12 check: const, enum, required, type object. */
function matchesSchema(schema: Record<string, unknown>, data: unknown): boolean {
  if (schema.type === "object" && typeof data === "object" && data !== null) {
    const d = data as Record<string, unknown>;
    const req = (schema.required as string[] | undefined) ?? [];
    for (const key of req) {
      if (!(key in d)) return false;
      const sub = (schema.properties as Record<string, Record<string, unknown>>)[key];
      if (sub && !matchesSchema(sub, d[key])) return false;
    }
    return true;
  }
  if (schema.const !== undefined) return data === schema.const;
  if (Array.isArray(schema.enum)) return schema.enum.includes(data);
  if (schema.type === "string") return typeof data === "string";
  return true;
}

test("no PAYMENT-SIGNATURE → 402 with Base USDC terms and Bazaar extension", async () => {
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
  const res = await callBase();
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.deepEqual(decode(res.headers.get("PAYMENT-REQUIRED")), body);
  const accept = body.accepts[0];
  assert.equal(accept.network, "eip155:8453");
  assert.equal(accept.asset.toLowerCase(), USDC.toLowerCase());
  assert.equal(accept.amount, "10000");
  assert.equal(accept.payTo, PAY_TO);
  const bazaar = body.extensions.bazaar;
  assert.ok(matchesSchema(bazaar.schema, bazaar.info));
});

test("wrong payTo / amount / network / expired validBefore / bad signature → 402, facilitator never called", async () => {
  const bad = async (p: Promise<BasePaymentPayload> | BasePaymentPayload, reason: string) => {
    const header = b64json(await p);
    assert.throws(() => parsePaymentHeader(header), (e) => e instanceof BadPayment && e.reason === reason, reason);
  };
  const other = "0x2222222222222222222222222222222222222222";
  await bad(signed({ accepted: { payTo: other } }), "wrong_pay_to");
  await bad(signed({ accepted: { amount: "9999" } }), "amount_is_not_the_price");
  await bad(signed({ accepted: { network: "eip155:4663" } }), "wrong_scheme_or_network");
  await bad(signed({ to: other }), "authorization_to_is_not_pay_to");
  const now = BigInt(Math.floor(Date.now() / 1000));
  await bad(signed({ validBefore: now + 10n }), "valid_before_too_soon");
  await bad(signed({ validAfter: now + 600n }), "not_valid_yet");

  const fx = facilitator(() => json({ isValid: true }), () => json({}));
  try {
    const good = await signed();
    const tampered = structuredClone(good);
    (tampered.payload as { authorization: { nonce: string } }).authorization.nonce = `0x${"22".repeat(32)}`;
    const res = await callBase({ "PAYMENT-SIGNATURE": b64json(tampered) });
    assert.equal(res.status, 402);
    assert.equal((await res.json()).error, "signature_does_not_match_from");
    assert.equal(fx.calls.length, 0);
    assert.equal(await checkSignature(tampered), false);
  } finally {
    fx.restore();
  }
});

test("missing CDP env → 503 facilitator_unconfigured, facilitator never called", async () => {
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
  const fx = facilitator(() => json({ isValid: true }), () => json({}));
  try {
    const res = await callBase({ "PAYMENT-SIGNATURE": b64json(await signed()) });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "facilitator_unconfigured", charged: false });
    assert.equal(fx.calls.length, 0);
  } finally {
    fx.restore();
  }
});

test("valid signed payment + injected fetch: verify ok → settle ok → 200 with PAYMENT-RESPONSE and X-Bazaar-Status", async () => {
  await prefill();
  const extHdr = { "EXTENSION-RESPONSES": Buffer.from(JSON.stringify({ bazaar: { status: "indexed" } }), "utf8").toString("base64") };
  const fx = facilitator(
    () => json({ isValid: true, payer: payer.address }),
  () => json({ success: true, transaction: TX, network: X402_NETWORK, payer: payer.address }, 200, extHdr),
  );
  try {
    const res = await callBase({ "PAYMENT-SIGNATURE": b64json(await signed()) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).r1_status, "partial");
    assert.equal(res.headers.get("X-Payment-Status"), "settled");
    assert.equal(decode(res.headers.get("PAYMENT-RESPONSE")).transaction, TX);
    assert.equal(res.headers.get("X-Bazaar-Status"), "indexed");
    assert.equal(fx.calls.length, 2);
    for (const c of fx.calls) {
      assert.match(c.auth ?? "", /^Bearer /);
      const posted = JSON.parse(c.body!);
      assert.ok(posted.paymentPayload.resource);
      assert.ok(posted.paymentPayload.extensions?.bazaar);
    }
    assert.equal(fx.calls[0].path, "/platform/v2/x402/verify");
    assert.equal(fx.calls[1].path, "/platform/v2/x402/settle");
  } finally {
    fx.restore();
  }
});

test("legacy paid route still answers 402 with eip155:4663 and USDG", async () => {
  const res = await callLegacy();
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.accepts[0].network, "eip155:4663");
  assert.equal(body.accepts[0].asset.toLowerCase(), USDG.toLowerCase());
  assert.equal(body.accepts[0].extra.assetTransferMethod, "permit2");
});

test("bazaar schema is pinned JSON Schema 2020-12", () => {
  const s = bazaarSchema();
  assert.equal(s.$schema, "https://json-schema.org/draft/2020-12/schema");
});