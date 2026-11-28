// Pay Guard Track A (A0): policy を送らない POST /api/v1/check/presign の応答を byte 単位で固定する。
// 仕様 N1・§10 Track A。policy / guard 拡張（12/8 以降）が既存の wire 形を変えないことを先に固定する。
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { handlePresign } from "@/lib/api/presign-handler";
import { __setCheckSellerCacheForTests, type makeGetCheckSellerCached } from "@/lib/api/check-seller-cache";
import { resetResponseSigningCacheForTests } from "@/lib/signing/response-signature";
import { setMcpDepsForTest } from "@/lib/mcp/deps";
import type { McpDeps } from "@/lib/mcp/tools";

const GOLDEN = "tests/fixtures/pay-guard-presign-no-policy.golden.txt";
/** PKCS#8 Ed25519。他の署名試験と共有しない（kid を固定するため）。 */
const PINNED_SIGNING_KEY_B64 = "MC4CAQAwBQYDK2VwBCIEIIIAOKA/hOreLa5JiEfX6dBLZj0AjgP/UjxyQl8gaXYE";

const URL_A = "https://1gateway.dev/v1/news/brief";
const PAY_TO = "0x6246eee0355dd7a93c888fe59e1151388a0cc5a1";
const ARB_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OBS_ID = "00000000-0000-0000-0000-0000000000f7";

const CHALLENGE_V2 = {
  x402Version: 2,
  error: "Payment required",
  resource: { url: URL_A, mimeType: "application/json" },
  accepts: [
    { scheme: "exact", network: "eip155:8453", amount: "7000", asset: BASE_USDC, payTo: "0x6246eee0355Dd7A93C888fE59e1151388A0cC5a1", maxTimeoutSeconds: 300 },
    { scheme: "exact", network: "eip155:42161", amount: "7000", asset: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", payTo: "0x6246eee0355Dd7A93C888fE59e1151388A0cC5a1", maxTimeoutSeconds: 300 },
    { scheme: "exact", network: "eip155:42161", amount: "9000", asset: ARB_USDC, payTo: PAY_TO },
    { scheme: "exact", network: "eip155:42161", amount: "7000", asset: ARB_USDC, payTo: "0x000000000000000000000000000000000000dead" },
  ],
};

const VERIFIED = {
  purchase_id: "eip155:42161:0xabc",
  pay_to: PAY_TO,
  asset: ARB_USDC,
  amount: "7000",
  decimals: 6,
  network: "eip155:42161",
  scheme: "exact",
  protocol: "x402",
  verified_at: "2026-11-25T06:01:44.136Z",
};

function deps(): McpDeps {
  return {
    now: () => new Date("2026-11-27T00:00:00.000Z"),
    resolve: (async () => ({
      resource: { observatory_id: OBS_ID, canonical_url: URL_A, method: "GET" },
      endpoints: [],
    })) as unknown as McpDeps["resolve"],
    decide: (async () => ({
      recommendation: "ALLOW",
      reason_codes: ["l0_pass", "l1_delivered"],
      reasons: [],
      facts: {
        l0: { status: "pass" },
        l1: { n_attempts: 1, n_delivered: 1, n_settled: 1, last_attempt_at: null },
        l2: { status: "undeclared" },
        payees: [`eip155:42161:${PAY_TO}`],
      },
      verified_terms: VERIFIED,
      verified_pay_to_by_network: [{ network: "eip155:42161", pay_to: PAY_TO, purchase_id: VERIFIED.purchase_id, verified_at: VERIFIED.verified_at }],
      scoredAt: "2026-11-27T00:00:00.000Z",
      freshness: { l0: null, l1: null, l2: null },
      spending_halted: false,
      evidence_age: null,
      rules_version: "2026-11-13.1",
    })) as unknown as McpDeps["decide"],
    l1Purchases: async () => [],
    sellerPage: {} as McpDeps["sellerPage"],
    hostExtras: async () => ({}) as never,
  } as unknown as McpDeps;
}

const passthrough = ((fn: () => Promise<unknown>) => async () => fn()) as unknown as Parameters<typeof makeGetCheckSellerCached>[0];

let savedKey: string | undefined;
let savedPerf: typeof performance.now;

beforeEach(() => {
  savedKey = process.env.VET402_RESPONSE_SIGNING_KEY;
  process.env.VET402_RESPONSE_SIGNING_KEY = PINNED_SIGNING_KEY_B64;
  delete process.env.VET402_RESPONSE_SIGNING_PREVIOUS_PUBLIC_JWK;
  resetResponseSigningCacheForTests();
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-28T00:00:00.000Z") });
  savedPerf = performance.now.bind(performance);
  let tick = 1000;
  performance.now = () => {
    tick += 0.1;
    return tick;
  };
  __setCheckSellerCacheForTests(passthrough);
  setMcpDepsForTest(deps());
});

afterEach(() => {
  mock.timers.reset();
  performance.now = savedPerf;
  if (savedKey === undefined) delete process.env.VET402_RESPONSE_SIGNING_KEY;
  else process.env.VET402_RESPONSE_SIGNING_KEY = savedKey;
  resetResponseSigningCacheForTests();
  __setCheckSellerCacheForTests(null);
  setMcpDepsForTest(null);
});

function wireSnapshot(res: Response, bodyText: string): string {
  const headerLines = [
    `status:${res.status}`,
    `cache-control:${res.headers.get("cache-control") ?? ""}`,
    `content-type:${res.headers.get("content-type") ?? ""}`,
    `x-robots-tag:${res.headers.get("x-robots-tag") ?? ""}`,
    `vet402-signature:${res.headers.get("Vet402-Signature") ?? ""}`,
    `server-timing:${res.headers.get("Server-Timing") ?? ""}`,
  ];
  return `${headerLines.join("\n")}\n\n${bodyText}`;
}

async function presignWithoutPolicy(): Promise<{ res: Response; wire: string }> {
  const request = new Request("https://vet402.com/api/v1/check/presign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(CHALLENGE_V2),
  });
  const res = await handlePresign(request, deps());
  const bodyText = await res.text();
  return { res, wire: wireSnapshot(res, bodyText) };
}

test("pay-guard: presign without policy matches the pinned wire snapshot (body, signature header, cache, timing)", async () => {
  const { res, wire } = await presignWithoutPolicy();
  assert.equal(res.status, 200);
  const parsed = JSON.parse(wire.split("\n\n")[1]!) as Record<string, unknown>;
  assert.equal("policy" in parsed, false);
  assert.equal("guard" in parsed, false);
  assert.equal("caller_policy" in parsed, false);

  if (process.env.UPDATE_PAY_GUARD_PRESIGN_GOLDEN === "1") {
    writeFileSync(GOLDEN, wire, "utf8");
  }
  const golden = readFileSync(GOLDEN, "utf8");
  assert.equal(wire, golden, "policy-less presign response must stay byte-identical on the pinned wire");
});