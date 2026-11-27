// M5a: /api/v1/check の checkSeller 読み取りを 60 秒サーバキャッシュする（2026-11-18）。
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { DECISION_RULES_VERSION } from "@/lib/decision/rules";
import { verdictNextStep } from "@/lib/decision/verdict-next-step";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { handleCheck } from "@/lib/api/check-handler";
import {
  __resetCheckSellerLatencyHelpersForTests,
  __setCheckSellerCacheForTests,
  CHECK_SELLER_CACHE_SECONDS,
  CHECK_SELLER_PREFETCH_LEAD_SECONDS,
  checkSellerCacheKey,
  checkSellerCacheKeyParts,
  checkSellerFreezeForCache,
  isCheckSellerCachedReadFresh,
  makeGetCheckSellerCached,
  prefetchedByStoreKeyForTests,
  prefetchInflightForTests,
  type CheckSellerCachedPayload,
  type CheckSellerCacheTiming,
} from "@/lib/api/check-seller-cache";
import { setAfterResponseSchedulerForTest } from "@/lib/util/after-response";
import { RESOLVE_KEYLESS_LIMIT } from "@/lib/api/keyless-limits";
import { setMcpDepsForTest } from "@/lib/mcp/deps";
import type { McpDeps } from "@/lib/mcp/tools";
import { handleKeylessCheckRoute } from "@/lib/api/keyless-check-route";
import { GET as getCheck } from "@/app/api/v1/check/route";
import { verdictReceiptMessage } from "@/lib/receipts/verdict-receipt";
import { matchSignatureForm } from "@/lib/verify-message";

const SIGNER_ENV = "VET402_RECEIPT_SIGNER_KEY";
const TEST_SIGNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const URL_A = "https://api.example.org/x";
const URL_B = "https://api.other.org/y";
const OBS_ID = "00000000-0000-0000-0000-000000000001";

function countingDeps(asOf: string, extra?: Partial<McpDeps>): McpDeps & { counts: { resolve: number } } {
  const counts = { resolve: 0 };
  return {
    counts,
    now: () => new Date(asOf),
    resolve: (async () => {
      counts.resolve++;
      return { resource: null, endpoints: [] };
    }) as unknown as McpDeps["resolve"],
    decide: (async () => null) as unknown as McpDeps["decide"],
    l1Purchases: async () => [],
    sellerPage: {} as McpDeps["sellerPage"],
    hostExtras: async () => ({}) as never,
    ...extra,
  } as unknown as McpDeps & { counts: { resolve: number } };
}

function depsWithDecision(spendingHalted: boolean, asOf: string): McpDeps & { counts: { resolve: number; decide: number } } {
  const counts = { resolve: 0, decide: 0 };
  return {
    counts,
    now: () => new Date(asOf),
    resolve: (async () => {
      counts.resolve++;
      return {
        resource: { observatory_id: OBS_ID, canonical_url: URL_A, method: "GET" },
        endpoints: [],
      };
    }) as unknown as McpDeps["resolve"],
    decide: (async () => {
      counts.decide++;
      return {
        recommendation: spendingHalted ? "BLOCK" : "ALLOW",
        reason_codes: [],
        reasons: [],
        facts: {
          l0: { status: "pass", observed_at: null, dialect: null, fail_reason: null },
          l1: { n_attempts: 0, n_delivered: 0, n_settled: 0, last_attempt_at: null },
          l2: { status: "undeclared" },
        },
        scoredAt: asOf,
        freshness: { l0: null, l1: null, l2: null },
        spending_halted: spendingHalted,
        evidence_age: null,
      };
    }) as unknown as McpDeps["decide"],
    l1Purchases: async () => [],
    sellerPage: {} as McpDeps["sellerPage"],
    hostExtras: async () => ({}) as never,
  } as unknown as McpDeps & { counts: { resolve: number; decide: number } };
}

function storingCache(ttlMs = 60_000) {
  const store = new Map<string, { value: CheckSellerCachedPayload; expiresAt: number }>();
  return ((fn: () => Promise<unknown>, keys: string[]) => {
    return async () => {
      const k = keys.join("|");
      const hit = store.get(k);
      const now = Date.now();
      if (hit && hit.expiresAt > now) return hit.value;
      if (hit) store.delete(k);
      const value = (await fn()) as CheckSellerCachedPayload;
      store.set(k, { value, expiresAt: now + ttlMs });
      return value;
    };
  }) as unknown as Parameters<typeof makeGetCheckSellerCached>[0];
}

/** 1 回目は充填、2 回目以降は古い cacheReadAt を返す（Next の stale 返却を模す）。 */
function staleAfterFirstFill(staleReadAt: string) {
  let calls = 0;
  return ((fn: () => Promise<unknown>, _keys: string[]) => {
    return async () => {
      calls++;
      if (calls === 1) return (await fn()) as CheckSellerCachedPayload;
      const payload = checkSellerFreezeForCache({
        evidence_age: null,
        canonical_url: URL_A,
        method: "GET",
        not_in_catalog: true,
        recommendation: null,
        reason_codes: [],
        reasons: [],
        delivery: null,
        l0_status: null,
        verified_terms: null,
        verified_pay_to_by_network: [],
        spending_halted: null,
        refunds: null,
        freshness: null,
        l1_purchases: [],
        same_host_listings: [],
        listing_sources: [],
        note: null,
        record_url: null,
        diagnose_url: null,
        method_url: "https://vet402.com/docs/methodology",
        as_of: "2026-11-18T09:00:00.000Z",
        truncated: false,
        next_action: null,
        rules_version: DECISION_RULES_VERSION,
      });
      return { out: payload, cacheReadAt: staleReadAt };
    };
  }) as unknown as Parameters<typeof makeGetCheckSellerCached>[0];
}

const savedProxyHeaderSource = process.env.PROXY_HEADER_SOURCE;

afterEach(() => {
  __setCheckSellerCacheForTests(null);
  __resetCheckSellerLatencyHelpersForTests();
  setAfterResponseSchedulerForTest(null);
  setMcpDepsForTest(null);
  delete process.env[SIGNER_ENV];
  if (savedProxyHeaderSource === undefined) delete process.env.PROXY_HEADER_SOURCE;
  else process.env.PROXY_HEADER_SOURCE = savedProxyHeaderSource;
});

function withGenericClientIp<T>(fn: () => Promise<T>): Promise<T> {
  process.env.PROXY_HEADER_SOURCE = "generic";
  return fn();
}

test("cache key: normalized URLs and methods do not collide", () => {
  assert.equal(checkSellerCacheKey("https://API.EXAMPLE.org/x/", "get"), checkSellerCacheKey("https://api.example.org/x", "GET"));
  assert.notEqual(checkSellerCacheKey(URL_A, "GET"), checkSellerCacheKey(URL_B, "GET"));
  assert.notEqual(checkSellerCacheKey(URL_A, "GET"), checkSellerCacheKey(URL_A, "POST"));
  assert.notEqual(checkSellerCacheKey(URL_A), checkSellerCacheKey(URL_A, "GET"));
});

test("cache key: pipe in URL does not merge with method suffix", () => {
  const withPipe = checkSellerCacheKeyParts("https://api.example.org/foo|bar");
  const split = checkSellerCacheKeyParts("https://api.example.org/foo", "bar");
  assert.notDeepEqual(withPipe, split);
});

test("second identical check does not call resolve again", async () => {
  __setCheckSellerCacheForTests(storingCache());
  const deps = countingDeps("2026-11-18T10:00:00.000Z");
  const req = () => new Request(`https://vet402.com/api/v1/check?url=${encodeURIComponent(URL_A)}`);
  await handleCheck(req(), deps);
  await handleCheck(req(), deps);
  assert.equal(deps.counts.resolve, 1);
});

test("different URL or method uses separate cache entries", async () => {
  __setCheckSellerCacheForTests(storingCache());
  const deps = countingDeps("2026-11-18T10:00:00.000Z");
  await handleCheck(new Request(`https://vet402.com/api/v1/check?url=${encodeURIComponent(URL_A)}`), deps);
  await handleCheck(new Request(`https://vet402.com/api/v1/check?url=${encodeURIComponent(URL_B)}`), deps);
  await handleCheck(new Request(`https://vet402.com/api/v1/check?url=${encodeURIComponent(URL_A)}&method=POST`), deps);
  assert.equal(deps.counts.resolve, 3);
});

test("cache expires after the revalidate window", async () => {
  __setCheckSellerCacheForTests(storingCache(0));
  const deps = countingDeps("2026-11-18T10:00:00.000Z");
  const req = () => new Request(`https://vet402.com/api/v1/check?url=${encodeURIComponent(URL_A)}`);
  await handleCheck(req(), deps);
  await handleCheck(req(), deps);
  assert.equal(deps.counts.resolve, 2, "ttl 0 forces a fresh read on the second call");
});

test("stale unstable_cache payload older than 60s triggers a fresh read", async () => {
  const staleAt = new Date(Date.now() - (CHECK_SELLER_CACHE_SECONDS + 5) * 1000).toISOString();
  __setCheckSellerCacheForTests(staleAfterFirstFill(staleAt));
  const asOfFirst = "2026-11-18T10:00:00.000Z";
  const asOfSecond = "2026-11-18T10:02:00.000Z";
  const deps = depsWithDecision(false, asOfFirst);
  const req = () => new Request(`https://vet402.com/api/v1/check?url=${encodeURIComponent(URL_A)}`);
  const first = await (await handleCheck(req(), deps)).json();
  assert.equal(deps.counts.resolve, 1);
  assert.equal(deps.counts.decide, 1);

  deps.now = () => new Date(asOfSecond);
  (deps.decide as McpDeps["decide"]) = (async () => ({
    recommendation: "ALLOW",
    reason_codes: [],
    reasons: [],
    facts: {
      l0: { status: "pass", observed_at: null, dialect: null, fail_reason: null },
      l1: { n_attempts: 0, n_delivered: 0, n_settled: 0, last_attempt_at: null },
      l2: { status: "undeclared" },
    },
    scoredAt: asOfSecond,
    freshness: { l0: null, l1: null, l2: null },
    spending_halted: false,
    evidence_age: null,
  })) as unknown as McpDeps["decide"];

  const second = await (await handleCheck(req(), deps)).json();
  assert.equal(deps.counts.resolve, 2, "aged cache must not skip resolve");
  assert.equal(second.as_of, asOfSecond);
  assert.equal(first.not_in_catalog, false);
  assert.equal(second.not_in_catalog, false);
});

test("stale refresh failure returns 503 without stale body", async () => {
  const aged: CheckSellerCachedPayload = {
    out: checkSellerFreezeForCache({
      evidence_age: null,
      canonical_url: URL_A,
      method: "GET",
      not_in_catalog: false,
      recommendation: "ALLOW",
      reason_codes: [],
      reasons: [],
      delivery: null,
      l0_status: null,
      verified_terms: null,
      verified_pay_to_by_network: [],
      spending_halted: false,
      refunds: null,
      freshness: null,
      l1_purchases: [],
      same_host_listings: [],
      listing_sources: [],
      note: null,
      record_url: null,
      diagnose_url: null,
      method_url: "https://vet402.com/docs/methodology",
      as_of: "2026-11-18T09:00:00.000Z",
      truncated: false,
      next_action: verdictNextStep("ALLOW"),
      rules_version: DECISION_RULES_VERSION,
    }),
    cacheReadAt: new Date(Date.now() - (CHECK_SELLER_CACHE_SECONDS + 30) * 1000).toISOString(),
  };
  __setCheckSellerCacheForTests((() => async () => aged) as unknown as Parameters<typeof makeGetCheckSellerCached>[0]);

  const deps = countingDeps("2026-11-18T10:00:00.000Z");
  deps.resolve = (async () => {
    throw new Error("db down");
  }) as unknown as McpDeps["resolve"];

  const res = await handleCheck(new Request(`https://vet402.com/api/v1/check?url=${encodeURIComponent(URL_A)}`), deps);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error, "temporarily_unavailable");
  assert.equal(body.recommendation, undefined);
});

test("spending_halted change is visible after cacheReadAt ages out", async () => {
  let halted = false;
  const asOf = "2026-11-18T10:00:00.000Z";
  let calls = 0;
  const staleAt = new Date(Date.now() - (CHECK_SELLER_CACHE_SECONDS + 1) * 1000).toISOString();
  const cache = ((fn: () => Promise<unknown>, _keys: string[]) => {
    return async () => {
      calls++;
      if (calls === 1) return (await fn()) as CheckSellerCachedPayload;
      return {
        out: checkSellerFreezeForCache({
          evidence_age: null,
          canonical_url: URL_A,
          method: "GET",
          not_in_catalog: false,
          recommendation: "ALLOW",
          reason_codes: [],
          reasons: [],
          delivery: null,
          l0_status: null,
          verified_terms: null,
          verified_pay_to_by_network: [],
          spending_halted: false,
          refunds: null,
          freshness: null,
          l1_purchases: [],
          same_host_listings: [],
          listing_sources: [],
          note: null,
          record_url: null,
          diagnose_url: null,
          method_url: "https://vet402.com/docs/methodology",
          as_of: asOf,
          truncated: false,
          next_action: verdictNextStep("ALLOW"),
          rules_version: DECISION_RULES_VERSION,
        }),
        cacheReadAt: staleAt,
      };
    };
  }) as unknown as Parameters<typeof makeGetCheckSellerCached>[0];

  const deps = depsWithDecision(false, asOf);
  __setCheckSellerCacheForTests(cache);
  await handleCheck(new Request(`https://vet402.com/api/v1/check?url=${encodeURIComponent(URL_A)}`), deps);

  halted = true;
  (deps.decide as McpDeps["decide"]) = (async () => ({
    recommendation: "BLOCK",
    reason_codes: [],
    reasons: [],
    facts: {
      l0: { status: "pass", observed_at: null, dialect: null, fail_reason: null },
      l1: { n_attempts: 0, n_delivered: 0, n_settled: 0, last_attempt_at: null },
      l2: { status: "undeclared" },
    },
    scoredAt: "2026-11-18T10:02:00.000Z",
    freshness: { l0: null, l1: null, l2: null },
    spending_halted: true,
    evidence_age: null,
  })) as unknown as McpDeps["decide"];

  const body = await (await handleCheck(new Request(`https://vet402.com/api/v1/check?url=${encodeURIComponent(URL_A)}`), deps)).json();
  assert.equal(body.spending_halted, true);
  void halted;
});

test("failed reads are not stored", async () => {
  const store = new Map<string, unknown>();
  const storing = ((fn: () => Promise<unknown>, keys: string[]) => async () => {
    const k = keys.join("|");
    if (store.has(k)) return store.get(k);
    const v = await fn();
    store.set(k, v);
    return v;
  }) as unknown as Parameters<typeof makeGetCheckSellerCached>[0];
  __setCheckSellerCacheForTests(storing);

  const deps = countingDeps("2026-11-18T10:00:00.000Z");
  let fail = true;
  const orig = deps.resolve;
  deps.resolve = (async (...args: Parameters<NonNullable<McpDeps["resolve"]>>) => {
    deps.counts.resolve++;
    if (fail) throw new Error("db down");
    return orig(...args);
  }) as unknown as McpDeps["resolve"];

  const req = () => new Request(`https://vet402.com/api/v1/check?url=${encodeURIComponent(URL_A)}`);
  assert.equal((await handleCheck(req(), deps)).status, 503);
  assert.equal(store.size, 0);
  fail = false;
  assert.equal((await handleCheck(req(), deps)).status, 200);
  const filled = deps.counts.resolve;
  assert.equal((await handleCheck(req(), deps)).status, 200);
  assert.equal(deps.counts.resolve, filled, "successful fill is reused after a failure");
});

test("as_of stays the cached read time when deps.now moves forward", async () => {
  __setCheckSellerCacheForTests(storingCache());
  const deps = countingDeps("2026-11-18T10:00:00.000Z");
  const qs = `?url=${encodeURIComponent(URL_A)}`;
  const first = await (await handleCheck(new Request(`https://vet402.com/api/v1/check${qs}`), deps)).json();
  deps.now = () => new Date("2026-11-18T11:00:00.000Z");
  const second = await (await handleCheck(new Request(`https://vet402.com/api/v1/check${qs}`), deps)).json();
  assert.equal(typeof first.as_of, "string");
  assert.equal(second.as_of, first.as_of);
  assert.equal(second.as_of, "2026-11-18T10:00:00.000Z");
  assert.equal(
    (await handleCheck(new Request(`https://vet402.com/api/v1/check${qs}`), deps)).headers.get("x-vet402-retrieved-at"),
    first.as_of,
  );
});

test("as_of string is shared by body, header, and verdict receipt", async () => {
  process.env[SIGNER_ENV] = TEST_SIGNER_KEY;
  __setCheckSellerCacheForTests(storingCache());
  const asOf = "2026-11-18T10:00:00.000Z";
  const deps = depsWithDecision(false, asOf);
  const qs = `?url=${encodeURIComponent(URL_A)}`;
  const res = await handleCheck(new Request(`https://vet402.com/api/v1/check${qs}`), deps);
  const body = await res.json();
  assert.equal(typeof body.as_of, "string");
  assert.equal(res.headers.get("x-vet402-retrieved-at"), body.as_of);
  assert.ok(body.receipt);
  assert.equal(typeof body.receipt.as_of, "string");
  assert.equal(body.receipt.as_of, body.as_of);
  const account = privateKeyToAccount(TEST_SIGNER_KEY);
  const message = verdictReceiptMessage({
    input_sha256: body.receipt.input_sha256,
    verdict: body.receipt.verdict,
    as_of: body.receipt.as_of,
  });
  const { matched } = await matchSignatureForm({
    address: account.address,
    signature: body.receipt.signature,
    current: message,
    legacy: message,
  });
  assert.equal(matched, "current");
});

test("keyless route records usage after handleCheck on 200 (not inside cached checkSeller)", () => {
  const routeSrc = readFileSync("src/lib/api/keyless-check-route.ts", "utf8");
  // 2026-11-27 F7: handler を引数にした（既定は handleCheck・presign が差し替える）。順序の検査は同じ。
  assert.match(routeSrc, /handler: \(request: NextRequest, deps: CheckSellerDeps\) => Promise<Response> = handleCheck/);
  assert.match(routeSrc, /await publicRateLimit[\s\S]*await handler\(request, deps\)/);
  assert.match(
    routeSrc,
    /if \(res\.status === 200 && keyless\)\s*\{[\s\S]*recordClientUsage\(request\.headers, usageRoute/,
  );
  assert.doesNotMatch(readFileSync("src/lib/api/check-handler.ts", "utf8"), /recordClientUsage/);
});

test("check のキャッシュヒットとミスで network は captureUsageNetwork に 1 回だけ渡る", async () => {
  __setCheckSellerCacheForTests(storingCache());
  let networks = 0;
  let reads = 0;
  const deps = depsWithDecision(false, "2026-11-18T10:00:00.000Z");
  deps.resolveForRoute = (async () => {
    reads++;
    return {
      result: {
        query: { kind: "url", value: URL_A },
        disclaimer: "",
        resource: { observatory_id: OBS_ID, canonical_url: URL_A, method: "GET" },
        endpoints: [],
      },
      usageNetwork: "eip155:8453",
    };
  }) as unknown as McpDeps["resolveForRoute"];
  deps.captureUsageNetwork = () => {
    networks++;
  };
  const read = makeGetCheckSellerCached(storingCache());
  await read(deps, { url: URL_A });
  assert.equal(reads, 1);
  assert.equal(networks, 1, "cache miss passes network once");
  networks = 0;
  await read(deps, { url: URL_A });
  assert.equal(reads, 1);
  assert.equal(networks, 1, "cache hit passes network once");
});

test("handleKeylessCheckRoute hits check on every call while checkSeller stays warm", async () => {
  await withGenericClientIp(async () => {
    const asOf = "2026-11-18T10:00:00.000Z";
    const deps = countingDeps(asOf);
    __setCheckSellerCacheForTests(storingCache());
    setMcpDepsForTest(deps);
    const url = `https://vet402.com/api/v1/check?url=${encodeURIComponent(URL_A)}`;
    const headers = { "x-forwarded-for": "198.51.100.78" };
    assert.equal(
      (await handleKeylessCheckRoute(new NextRequest(url, { headers }), "rest:check")).status,
      200,
    );
    assert.equal(
      (await handleKeylessCheckRoute(new NextRequest(url, { headers }), "rest:check")).status,
      200,
    );
    assert.equal(deps.counts.resolve, 1);
  });
});

test("429 rate limit still applies when a warm cache exists", async () => {
  await withGenericClientIp(async () => {
    const asOf = "2026-11-18T10:00:00.000Z";
    const deps = countingDeps(asOf);
    __setCheckSellerCacheForTests(storingCache());
    setMcpDepsForTest(deps);
    const url = `https://vet402.com/api/v1/check?url=${encodeURIComponent(URL_A)}`;
    const headers = { "x-forwarded-for": "198.51.100.77" };
    await getCheck(new NextRequest(url, { headers }));
    assert.equal(deps.counts.resolve, 1, "first fill reads the store");
    for (let i = 1; i < RESOLVE_KEYLESS_LIMIT; i++) {
      const res = await getCheck(new NextRequest(url, { headers }));
      assert.equal(res.status, 200);
    }
    const blocked = await getCheck(new NextRequest(url, { headers }));
    assert.equal(blocked.status, 429);
    assert.equal(deps.counts.resolve, 1, "warm cache does not bypass the per-IP limit");
  });
});

test("handleCheck adds Server-Timing on success", async () => {
  __setCheckSellerCacheForTests(storingCache());
  const res = await handleCheck(
    new Request(`https://vet402.com/api/v1/check?url=${encodeURIComponent(URL_A)}`),
    countingDeps("2026-11-18T10:00:00.000Z"),
  );
  assert.match(res.headers.get("server-timing") ?? "", /^check;dur=/);
});

function memoCache(): typeof import("next/cache").unstable_cache {
  const store = new Map<string, unknown>();
  return ((fn: () => Promise<unknown>, keys: string[]) => async () => {
    const key = JSON.stringify(keys);
    if (store.has(key)) return store.get(key);
    const value = await fn();
    store.set(key, value);
    return value;
  }) as never;
}

test("one caller's secret in the URL never reaches another caller's diagnose_url", async () => {
  const read = makeGetCheckSellerCached(memoCache());
  const deps = countingDeps("2026-11-18T00:00:00.000Z");
  const first = await read(deps, { url: `${URL_A}?api_key=SECRET-OF-CALLER-A` });
  const second = await read(deps, { url: URL_A });
  assert.equal(deps.counts.resolve, 1);
  assert.match(String(first.diagnose_url), /SECRET-OF-CALLER-A/);
  assert.doesNotMatch(String(second.diagnose_url), /SECRET-OF-CALLER-A/);
  assert.ok(String(second.diagnose_url).length > 0);
});

test("the 60 second window starts when the read starts", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-18T00:00:00.000Z") });
  const read = makeGetCheckSellerCached(memoCache());
  const deps = depsWithDecision(false, "2026-11-18T00:00:00.000Z");
  const resolve = deps.resolve;
  let slow = true;
  deps.resolve = (async (...args: Parameters<typeof resolve>) => {
    if (slow) t.mock.timers.tick(5_000);
    slow = false;
    return resolve(...args);
  }) as typeof resolve;
  await read(deps, { url: URL_A });
  t.mock.timers.tick(56_000);
  await read(deps, { url: URL_A });
  assert.equal(deps.counts.resolve, 2);
});

test("a URL that normalization pushes past the lookup limit is read as the caller sent it", async () => {
  const seen: string[] = [];
  const longUrl = `${URL_A}?q=${"あ".repeat(300)}`;
  const deps = countingDeps("2026-11-18T00:00:00.000Z", {
    resolve: (async (query: string) => {
      seen.push(query);
      return { resource: null, endpoints: [] };
    }) as unknown as McpDeps["resolve"],
  });
  await makeGetCheckSellerCached(memoCache())(deps, { url: longUrl });
  assert.deepEqual(seen, [longUrl]);
});

test("a halted answer is not reused after the flag recovers", async () => {
  const read = makeGetCheckSellerCached(memoCache());
  const halted = await read(depsWithDecision(true, "2026-11-18T00:00:00.000Z"), { url: URL_A });
  const recovered = await read(depsWithDecision(false, "2026-11-18T00:00:01.000Z"), { url: URL_A });
  assert.equal(halted.spending_halted, true);
  assert.equal(recovered.spending_halted, false);
});

test("a long caller URL does not change what the next caller receives", async () => {
  const listing = { canonical_url: `${URL_A}/other`, method: "GET", catalog_status: "listed", observatory_id: OBS_ID };
  const deps = countingDeps("2026-11-18T00:00:00.000Z", {
    resolve: (async () => ({ resource: null, endpoints: [listing, listing, listing, listing, listing] })) as unknown as McpDeps["resolve"],
  });
  const direct = await makeGetCheckSellerCached(memoCache())(deps, { url: URL_A });
  const read = makeGetCheckSellerCached(memoCache());
  await read(deps, { url: `${URL_A}?token=${"あ".repeat(1_500)}` });
  const next = await read(deps, { url: URL_A });
  assert.deepEqual(next.same_host_listings, direct.same_host_listings);
  assert.equal(next.truncated, direct.truncated);
});

test("cached wrapper matches CHECK_SELLER_CACHE_SECONDS and has no catch inside unstable_cache", () => {
  const src = readFileSync("src/lib/api/check-seller-cache.ts", "utf8");
  const inner = src.slice(src.indexOf("const read = cache("), src.indexOf("try {", src.indexOf("const read = cache(")));
  assert.match(src, new RegExp(`revalidate: CHECK_SELLER_CACHE_SECONDS`));
  assert.match(src, /\["check-seller:v2", urlKey, methodKey\]/);
  assert.doesNotMatch(src, /`\$\{c\.url\}\|\$\{m\}`/);
  assert.equal(CHECK_SELLER_CACHE_SECONDS, 60);
  assert.doesNotMatch(inner, /\bcatch\b/, "no catch inside unstable_cache");
});

test("checkSellerFreezeForCache round-trips output", () => {
  const sample = {
    evidence_age: null,
    canonical_url: URL_A,
    method: "GET",
    not_in_catalog: false,
    recommendation: "ALLOW" as const,
    reason_codes: [] as string[],
    reasons: [] as [],
    delivery: null,
    l0_status: null,
    verified_terms: null,
    verified_pay_to_by_network: [],
    spending_halted: false,
    refunds: null,
    freshness: null,
    l1_purchases: [] as [],
    same_host_listings: [] as [],
    listing_sources: [] as [],
    note: null,
    record_url: null,
    diagnose_url: null,
    method_url: "https://vet402.com/docs/methodology",
    as_of: "2026-11-18T10:00:00.000Z",
    truncated: false,
    next_action: verdictNextStep("ALLOW"),
    rules_version: DECISION_RULES_VERSION,
  };
  const frozen = checkSellerFreezeForCache(sample);
  assert.deepEqual(frozen, sample);
  assert.equal(typeof frozen.as_of, "string");
});

test("isCheckSellerCachedReadFresh respects CHECK_SELLER_CACHE_SECONDS", () => {
  const now = Date.parse("2026-11-18T10:01:00.000Z");
  assert.equal(isCheckSellerCachedReadFresh("2026-11-18T10:00:00.000Z", now), true);
  assert.equal(isCheckSellerCachedReadFresh("2026-11-18T09:59:00.000Z", now), false);
});

test("stale cacheReadAt uses a prefetched read when it is still fresh", async (t) => {
  const tasks: (() => Promise<void>)[] = [];
  setAfterResponseSchedulerForTest((task) => {
    tasks.push(task);
  });
  const store = new Map<string, { value: CheckSellerCachedPayload; expiresAt: number }>();
  const storing = ((fn: () => Promise<unknown>, keys: string[]) => {
    return async () => {
      const k = keys.join("|");
      const hit = store.get(k);
      const now = Date.now();
      if (hit && hit.expiresAt > now) return hit.value;
      if (hit) store.delete(k);
      const value = (await fn()) as CheckSellerCachedPayload;
      store.set(k, { value, expiresAt: now + CHECK_SELLER_CACHE_SECONDS * 1000 });
      return value;
    };
  }) as unknown as Parameters<typeof makeGetCheckSellerCached>[0];
  __setCheckSellerCacheForTests(storing);

  const asOfFirst = "2026-11-18T10:00:00.000Z";
  const deps = depsWithDecision(false, asOfFirst);
  const read = makeGetCheckSellerCached(storing);

  const atPrefetchLead = Date.parse(asOfFirst) + (CHECK_SELLER_CACHE_SECONDS - CHECK_SELLER_PREFETCH_LEAD_SECONDS) * 1000;
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(asOfFirst) });
  await read(deps, { url: URL_A });
  assert.equal(deps.counts.resolve, 1);
  t.mock.timers.setTime(atPrefetchLead);
  await read(deps, { url: URL_A });
  for (const task of tasks) await task();
  assert.equal(deps.counts.resolve, 2, "prefetch started a background read while the cached verdict stayed fresh");
  assert.equal(tasks.length, 1, "one after-response prefetch task");
});

test("prefetched payload is used when unstable_cache cacheReadAt is stale", async (t) => {
  const asOf = "2026-11-18T10:00:00.000Z";
  const storeK = checkSellerCacheKey(URL_A)!;
  const prefetchedAt = "2026-11-18T10:00:48.000Z";
  __resetCheckSellerLatencyHelpersForTests();
  prefetchedByStoreKeyForTests(storeK, {
    out: checkSellerFreezeForCache({
      evidence_age: null,
      canonical_url: URL_A,
      method: "GET",
      not_in_catalog: false,
      recommendation: "ALLOW",
      reason_codes: [],
      reasons: [],
      delivery: null,
      l0_status: null,
      verified_terms: null,
      verified_pay_to_by_network: [],
      spending_halted: false,
      refunds: null,
      freshness: null,
      l1_purchases: [],
      same_host_listings: [],
      listing_sources: [],
      note: null,
      record_url: null,
      diagnose_url: null,
      method_url: "https://vet402.com/docs/methodology",
      as_of: asOf,
      truncated: false,
      next_action: verdictNextStep("ALLOW"),
      rules_version: DECISION_RULES_VERSION,
    }),
    cacheReadAt: prefetchedAt,
  });
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-18T10:00:55.000Z") });
  const staleOnly = (() => async () => ({
    out: checkSellerFreezeForCache({
      evidence_age: null,
      canonical_url: URL_A,
      method: "GET",
      not_in_catalog: false,
      recommendation: "ALLOW",
      reason_codes: [],
      reasons: [],
      delivery: null,
      l0_status: null,
      verified_terms: null,
      verified_pay_to_by_network: [],
      spending_halted: false,
      refunds: null,
      freshness: null,
      l1_purchases: [],
      same_host_listings: [],
      listing_sources: [],
      note: null,
      record_url: null,
      diagnose_url: null,
      method_url: "https://vet402.com/docs/methodology",
      as_of: "2026-11-18T09:00:00.000Z",
      truncated: false,
      next_action: verdictNextStep("ALLOW"),
      rules_version: DECISION_RULES_VERSION,
    }),
    cacheReadAt: "2026-11-18T09:58:00.000Z",
  })) as unknown as Parameters<typeof makeGetCheckSellerCached>[0];
  __setCheckSellerCacheForTests(staleOnly);
  const deps = countingDeps(asOf);
  const body = await makeGetCheckSellerCached(staleOnly)(deps, { url: URL_A });
  assert.equal(body.as_of, asOf);
  assert.equal(deps.counts.resolve, 0, "prefetch slot served the stale-cache miss");
});

test("stale refresh coalesces in-flight reads per cache key", () => {
  const src = readFileSync("src/lib/api/check-seller-cache.ts", "utf8");
  assert.match(src, /freshInflight/, "foreground stale reads share one in-flight checkSeller per URL/method");
});
function staleCacheFor(asOfStale: string) {
  return ((fn: () => Promise<unknown>) => async () => {
    const live = (await fn()) as CheckSellerCachedPayload;
    return { ...live, out: { ...live.out, as_of: asOfStale }, cacheReadAt: "2026-11-18T09:58:00.000Z" };
  }) as unknown as Parameters<typeof makeGetCheckSellerCached>[0];
}

test("an expired prefetched read is not returned; the call reads again", async (t) => {
  const asOf = "2026-11-18T10:00:00.000Z";
  const storeK = checkSellerCacheKey(URL_A)!;
  const old = await makeGetCheckSellerCached(((fn: () => Promise<unknown>) => fn) as never)(countingDeps("2026-11-18T09:00:00.000Z"), { url: URL_A });
  prefetchedByStoreKeyForTests(storeK, { out: old, cacheReadAt: "2026-11-18T09:59:00.000Z" });
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-18T10:00:30.000Z") });
  const cache = staleCacheFor("2026-11-18T09:00:00.000Z");
  __setCheckSellerCacheForTests(cache);
  const deps = countingDeps(asOf);
  const body = await makeGetCheckSellerCached(cache)(deps, { url: URL_A });
  assert.equal(body.as_of, asOf, "the expired prefetched verdict is not served");
});

test("a failed prefetch leaves nothing behind for the next caller", async (t) => {
  const tasks: (() => Promise<void>)[] = [];
  setAfterResponseSchedulerForTest((task) => {
    tasks.push(task);
  });
  const asOf = "2026-11-18T10:00:00.000Z";
  const cache = storingCache();
  __setCheckSellerCacheForTests(cache);
  const read = makeGetCheckSellerCached(cache);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(asOf) });
  const deps = countingDeps(asOf);
  await read(deps, { url: URL_A });
  let failing = true;
  const flaky = {
    ...deps,
    resolve: (async (...args: unknown[]) => {
      if (failing) throw new Error("db down");
      return (deps.resolve as (...a: unknown[]) => unknown)(...args);
    }) as typeof deps.resolve,
  };
  t.mock.timers.setTime(Date.parse(asOf) + (CHECK_SELLER_CACHE_SECONDS - CHECK_SELLER_PREFETCH_LEAD_SECONDS + 1) * 1000);
  await read(flaky, { url: URL_A });
  for (const task of tasks) await task();
  failing = false;
  t.mock.timers.setTime(Date.parse(asOf) + (CHECK_SELLER_CACHE_SECONDS + 5) * 1000);
  const before = deps.counts.resolve;
  await read(deps, { url: URL_A });
  assert.ok(deps.counts.resolve > before, "after expiry the caller reads again instead of a stored value");
});

test("stale cache waits for an in-flight prefetch before reading again", async (t) => {
  const asOf = "2026-11-18T10:01:00.000Z";
  const storeK = checkSellerCacheKey(URL_A)!;
  __resetCheckSellerLatencyHelpersForTests();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  prefetchInflightForTests(storeK, gate);
  const staleOnly = (() => async () => ({
    out: checkSellerFreezeForCache({
      evidence_age: null,
      canonical_url: URL_A,
      method: "GET",
      not_in_catalog: false,
      recommendation: "ALLOW",
      reason_codes: [],
      reasons: [],
      delivery: null,
      l0_status: null,
      verified_terms: null,
      verified_pay_to_by_network: [],
      spending_halted: false,
      refunds: null,
      freshness: null,
      l1_purchases: [],
      same_host_listings: [],
      listing_sources: [],
      note: null,
      record_url: null,
      diagnose_url: null,
      method_url: "https://vet402.com/docs/methodology",
      as_of: "2026-11-18T09:00:00.000Z",
      truncated: false,
      next_action: verdictNextStep("ALLOW"),
      rules_version: DECISION_RULES_VERSION,
    }),
    cacheReadAt: "2026-11-18T09:58:00.000Z",
  })) as unknown as Parameters<typeof makeGetCheckSellerCached>[0];
  __setCheckSellerCacheForTests(staleOnly);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-18T10:01:00.000Z") });
  const deps = countingDeps(asOf);
  const read = makeGetCheckSellerCached(staleOnly);
  const pending = read(deps, { url: URL_A });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(deps.counts.resolve, 0, "waits for prefetch instead of an immediate fresh read");
  prefetchedByStoreKeyForTests(storeK, {
    out: checkSellerFreezeForCache({
      evidence_age: null,
      canonical_url: URL_A,
      method: "GET",
      not_in_catalog: false,
      recommendation: "ALLOW",
      reason_codes: [],
      reasons: [],
      delivery: null,
      l0_status: null,
      verified_terms: null,
      verified_pay_to_by_network: [],
      spending_halted: false,
      refunds: null,
      freshness: null,
      l1_purchases: [],
      same_host_listings: [],
      listing_sources: [],
      note: null,
      record_url: null,
      diagnose_url: null,
      method_url: "https://vet402.com/docs/methodology",
      as_of: asOf,
      truncated: false,
      next_action: verdictNextStep("ALLOW"),
      rules_version: DECISION_RULES_VERSION,
    }),
    cacheReadAt: asOf,
  });
  release();
  const body = await pending;
  assert.equal(body.as_of, asOf);
  assert.equal(deps.counts.resolve, 0, "prefetch slot served the stale-cache miss");
});

test("a rejected in-flight prefetch does not fail the caller; it reads again", async (t) => {
  const asOf = "2026-11-18T10:01:00.000Z";
  const storeK = checkSellerCacheKey(URL_A)!;
  __resetCheckSellerLatencyHelpersForTests();
  prefetchInflightForTests(storeK, Promise.reject(new Error("prefetch failed")));
  const staleOnly = (() => async () => ({
    out: {} as never,
    cacheReadAt: "2026-11-18T09:58:00.000Z",
  })) as unknown as Parameters<typeof makeGetCheckSellerCached>[0];
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(asOf) });
  const deps = countingDeps(asOf);
  const read = makeGetCheckSellerCached(staleOnly);
  const timing: CheckSellerCacheTiming = {};
  const body = await read(deps, { url: URL_A }, timing);
  assert.equal(deps.counts.resolve, 1, "after the failed prefetch the caller reads once itself");
  assert.equal(timing.path, "coalesced");
  assert.equal(body.rules_version, DECISION_RULES_VERSION, "the caller still gets an answer, not an error");
});

test("concurrent stale reads of one key share one checkSeller call", async () => {
  const asOf = "2026-11-18T10:00:00.000Z";
  const cache = (() => async () => ({ out: {} as never, cacheReadAt: "2026-11-18T09:00:00.000Z" })) as unknown as Parameters<
    typeof makeGetCheckSellerCached
  >[0];
  __setCheckSellerCacheForTests(cache);
  const deps = countingDeps(asOf);
  const read = makeGetCheckSellerCached(cache);
  const [a, b] = await Promise.all([read(deps, { url: URL_A }), read(deps, { url: URL_A })]);
  assert.equal(deps.counts.resolve, 1);
  assert.equal(a.as_of, asOf);
  assert.equal(b.as_of, asOf);
});
