// F7（2026-11-27）: POST /api/v1/check/presign — 402 の本文を受けて、check と同じ判定と accept ごとの照合を返す。
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { __setCheckSellerCacheForTests, type makeGetCheckSellerCached } from "@/lib/api/check-seller-cache";
import { compareAccepts, handlePresign, parsePresignBody, resourceUrlOf } from "@/lib/api/presign-handler";
import { setMcpDepsForTest } from "@/lib/mcp/deps";
import type { McpDeps } from "@/lib/mcp/tools";
import { POST as presignPOST, GET as presignGET } from "@/app/api/v1/check/presign/route";
import { SOLANA_MAINNET } from "../packages/sdk/src/pay-or-refuse";
import { SOLANA_MAINNET_NETWORK, TERMS_BASE_NETWORK } from "../packages/sdk/src/terms-match";
import { CHAIN_PROFILES } from "../packages/sdk/src/chain-profile";

const URL_A = "https://1gateway.dev/v1/news/brief";
const OBS_ID = "00000000-0000-0000-0000-0000000000f7";
const PAY_TO = "0x6246eee0355dd7a93c888fe59e1151388a0cc5a1";
const ARB_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// 本番の 1gateway.dev の 402（2026-11-27 に取った PAYMENT-REQUIRED を短くした形）。
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

function deps(opts: { inCatalog?: boolean; verified?: boolean } = {}): McpDeps & { counts: { resolve: number; decide: number } } {
  const inCatalog = opts.inCatalog ?? true;
  const verified = opts.verified ?? true;
  const counts = { resolve: 0, decide: 0 };
  return {
    counts,
    now: () => new Date("2026-11-27T00:00:00.000Z"),
    resolve: (async () => {
      counts.resolve++;
      return inCatalog
        ? { resource: { observatory_id: OBS_ID, canonical_url: URL_A, method: "GET" }, endpoints: [] }
        : { resource: null, endpoints: [] };
    }) as unknown as McpDeps["resolve"],
    decide: (async () => {
      counts.decide++;
      return {
        recommendation: "ALLOW",
        reason_codes: ["l0_pass", "l1_delivered"],
        reasons: [],
        facts: {
          l0: { status: "pass" },
          l1: { n_attempts: 1, n_delivered: 1, n_settled: 1, last_attempt_at: null },
          l2: { status: "undeclared" },
          payees: [`eip155:42161:${PAY_TO}`],
        },
        verified_terms: verified ? VERIFIED : null,
        verified_pay_to_by_network: verified
          ? [{ network: "eip155:42161", pay_to: PAY_TO, purchase_id: VERIFIED.purchase_id, verified_at: VERIFIED.verified_at }]
          : [],
        scoredAt: "2026-11-27T00:00:00.000Z",
        freshness: { l0: null, l1: null, l2: null },
        spending_halted: false,
        evidence_age: null,
        rules_version: "2026-11-13.1",
      };
    }) as unknown as McpDeps["decide"],
    l1Purchases: async () => [],
    sellerPage: {} as McpDeps["sellerPage"],
    hostExtras: async () => ({}) as never,
  } as unknown as McpDeps & { counts: { resolve: number; decide: number } };
}

const passthrough = ((fn: () => Promise<unknown>) => async () => fn()) as unknown as Parameters<typeof makeGetCheckSellerCached>[0];

function post(body: unknown, path = "/api/v1/check/presign"): Request {
  return new Request(`https://vet402.com${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

afterEach(() => {
  __setCheckSellerCacheForTests(null);
  setMcpDepsForTest(null);
});

test("presign: the 402 body returns check's verdict and per-accept terms with the SDK words", async () => {
  __setCheckSellerCacheForTests(passthrough);
  const res = await handlePresign(post(CHALLENGE_V2), deps());
  assert.equal(res.status, 200);
  assert.match(res.headers.get("server-timing") ?? "", /^presign;dur=\d+(\.\d)?$/);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.recommendation, "ALLOW");
  assert.deepEqual(body.reason_codes, ["l0_pass", "l1_delivered"]);
  assert.equal(body.rules_version, "2026-11-13.1");
  assert.equal(body.resource_url_source, "challenge");
  assert.equal(body.x402_version, 2);
  const accepts = body.accepts as { index: number; terms_match: boolean | null; reason_codes: string[] }[];
  assert.deepEqual(
    accepts.map((a) => [a.index, a.terms_match, a.reason_codes]),
    [
      [0, false, ["payee_unverified_on_rail"]],
      [1, true, []],
      [2, false, ["price_above_declared"]],
      [3, false, ["payee_mismatch"]],
    ],
  );
  assert.deepEqual(body.matching_accepts, [1]);
});

test("presign: the base64 PAYMENT-REQUIRED header value is accepted as challenge", async () => {
  __setCheckSellerCacheForTests(passthrough);
  const header = Buffer.from(JSON.stringify(CHALLENGE_V2)).toString("base64");
  const res = await handlePresign(post({ challenge: header }), deps());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { matching_accepts: number[] };
  assert.deepEqual(body.matching_accepts, [1]);
});

test("presign: v1 accepts (network base, maxAmountRequired, resource) are normalized like the SDK", () => {
  const v1 = {
    x402Version: 1,
    accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "10000", resource: URL_A, asset: BASE_USDC, payTo: PAY_TO }],
  };
  assert.deepEqual(resourceUrlOf(v1, null), { url: URL_A, source: "challenge" });
  const [row] = compareAccepts(v1.accepts, null);
  assert.equal(row!.network, "eip155:8453");
  assert.equal(row!.amount, "10000");
  assert.equal(row!.terms_match, null);
  assert.deepEqual(row!.reason_codes, ["resource_uncatalogued"]);
});

test("presign: without verified_terms the SDK falls back to facts.payees and refuses with price_unverified", async () => {
  __setCheckSellerCacheForTests(passthrough);
  const d = deps({ verified: false });
  const res = await handlePresign(post({ challenge: CHALLENGE_V2, url: URL_A, method: "get" }), d);
  const body = (await res.json()) as { accepts: { terms_match: boolean; reason_codes: string[] }[]; resource_url_source: string };
  assert.equal(body.resource_url_source, "body");
  assert.deepEqual(body.accepts.map((a) => a.reason_codes), [["payee_mismatch"], ["price_unverified"], ["price_unverified"], ["payee_mismatch"]]);
  assert.ok(body.accepts.every((a) => a.terms_match === false));
  assert.equal(d.counts.decide, 2, "check's read and the payees read");
});

test("presign: a seller not in the catalog gets terms_match null and resource_uncatalogued", async () => {
  __setCheckSellerCacheForTests(passthrough);
  const res = await handlePresign(post(CHALLENGE_V2), deps({ inCatalog: false }));
  const body = (await res.json()) as { not_in_catalog: boolean; recommendation: unknown; accepts: { terms_match: unknown }[]; matching_accepts: number[] };
  assert.equal(body.not_in_catalog, true);
  assert.equal(body.recommendation, null);
  assert.ok(body.accepts.every((a) => a.terms_match === null));
  assert.deepEqual(body.matching_accepts, []);
});

test("presign: an unreadable accept is evidence_unavailable", () => {
  const rows = compareAccepts([{ scheme: "exact" }], { verified_terms: VERIFIED, verified_pay_to_by_network: [], facts: { payees: [] } });
  assert.deepEqual([rows[0]!.readable, rows[0]!.terms_match, rows[0]!.reason_codes], [false, false, ["evidence_unavailable"]]);
});

test("presign: bad input is 400 with a word and a message", async () => {
  __setCheckSellerCacheForTests(passthrough);
  const cases: [unknown, string][] = [
    ["not json", "invalid_body"],
    [[1, 2], "invalid_body"],
    [{ foo: 1 }, "invalid_body"],
    [{ challenge: CHALLENGE_V2, extra: 1 }, "invalid_body"],
    [{ challenge: "!!!" }, "invalid_challenge"],
    [{ x402Version: 2, accepts: [] }, "invalid_challenge"],
    [{ challenge: CHALLENGE_V2, url: "http://1gateway.dev/v1/news/brief" }, "invalid_url"],
    [{ challenge: CHALLENGE_V2, method: "G E T" }, "invalid_method"],
    [{ x402Version: 2, accepts: [{ scheme: "exact" }] }, "invalid_url"],
  ];
  for (const [body, word] of cases) {
    const res = await handlePresign(post(body), deps());
    assert.equal(res.status, 400, JSON.stringify(body));
    const out = (await res.json()) as { error: string; message?: string };
    assert.equal(out.error, word, JSON.stringify(body));
  }
  const q = await handlePresign(post(CHALLENGE_V2, "/api/v1/check/presign?url=x"), deps());
  assert.equal(q.status, 400);
  assert.equal(((await q.json()) as { error: string }).error, "invalid_query");
});

test("presign: a body over 64 KB is 413", () => {
  const big = JSON.stringify({ ...CHALLENGE_V2, pad: "x".repeat(70_000) });
  const parsed = parsePresignBody(big);
  assert.equal(parsed.ok, false);
  assert.equal(!parsed.ok && parsed.status, 413);
});

test("presign route: POST goes through the keyless check limiter, GET is 405", async () => {
  process.env.PROXY_HEADER_SOURCE = "generic";
  __setCheckSellerCacheForTests(passthrough);
  setMcpDepsForTest(deps());
  const req = new NextRequest("https://vet402.com/api/v1/check/presign", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.207" },
    body: JSON.stringify(CHALLENGE_V2),
  });
  const res = await presignPOST(req);
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("ratelimit-policy"), "RateLimit-Policy like GET /api/v1/check");
  assert.equal(res.headers.get("cache-control"), "private, no-store");
  assert.equal(presignGET!().status, 405);
});

test("terms-match has no imports and keeps the SDK's network values and predicates", () => {
  const src = readFileSync("packages/sdk/src/terms-match.ts", "utf8");
  assert.doesNotMatch(src, /^import /m, "Next's build reads this file directly; a relative .js import does not resolve there");
  assert.equal(SOLANA_MAINNET_NETWORK, SOLANA_MAINNET);
  assert.equal(TERMS_BASE_NETWORK, CHAIN_PROFILES.base.network);
  const shape = readFileSync("packages/sdk/src/verdict-shape.ts", "utf8");
  for (const fn of ["isPlainObject", "isDecimalUnits"]) {
    const body = (s: string) => new RegExp(`function ${fn}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(s)?.[1]?.trim();
    assert.ok(body(src), fn);
    assert.equal(body(src), body(shape), `${fn} differs from verdict-shape.ts`);
  }
});

test("presign is listed in openapi, /docs/api data, llms.txt, llms-full and the signed routes", () => {
  assert.ok(readFileSync("docs/openapi.yaml", "utf8").includes("\n  /api/v1/check/presign:\n"));
  assert.ok(readFileSync("src/lib/docs/api-endpoints-data.tsx", "utf8").includes('path: "/api/v1/check/presign"'));
  // llms.txt is an index (PR #145): one link line there, the API line in llms-full-prose.txt.
  assert.ok(readFileSync("public/llms.txt", "utf8").includes("`POST https://vet402.com/api/v1/check/presign`"));
  assert.ok(readFileSync("public/llms-full-prose.txt", "utf8").includes("- `POST /api/v1/check/presign` takes the 402"));
  assert.ok(readFileSync("docs/response-signatures.md", "utf8").includes("POST /api/v1/check/presign"));
});

test("presign latency file: target_met is true only with 20+ samples and p99 within the target", async () => {
  const doc = JSON.parse(readFileSync("public/data/presign-latency.json", "utf8")) as {
    samples: number;
    server_ms: { p50: number | null; p99: number | null };
    target_p99_server_ms: number;
    target_met: boolean;
  };
  assert.equal(doc.target_p99_server_ms, 300);
  const met = doc.samples >= 20 && doc.server_ms.p99 !== null && doc.server_ms.p99 <= doc.target_p99_server_ms;
  assert.equal(doc.target_met, met);
  if (doc.samples === 0) assert.equal(doc.server_ms.p99, null);
  const { nearestRank } = await import("../scripts/presign-latency-probe");
  assert.equal(nearestRank([1, 2, 3, 4], 0.5), 2);
  assert.equal(nearestRank(Array.from({ length: 30 }, (_, i) => i + 1), 0.99), 30);
  assert.equal(nearestRank([], 0.99), null);
});

test("presign: an accept whose amount is not an integer string is evidence_unavailable, not a 503", async () => {
  __setCheckSellerCacheForTests(passthrough);
  const challenge = { ...CHALLENGE_V2, accepts: [{ ...CHALLENGE_V2.accepts[1], amount: "0.01" }, { ...CHALLENGE_V2.accepts[1], amount: "1e6" }] };
  const res = await handlePresign(post(challenge), deps());
  assert.equal(res.status, 200);
  const body = (await res.json()) as { accepts: { readable: boolean; terms_match: boolean; reason_codes: string[] }[] };
  assert.deepEqual(body.accepts.map((a) => [a.readable, a.terms_match, a.reason_codes]), [[false, false, ["evidence_unavailable"]], [false, false, ["evidence_unavailable"]]]);
});
