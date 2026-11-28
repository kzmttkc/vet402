// 依頼 Z: 初めての売り手の coalesced 誤表示・resolve の二重読み・GET/POST 合流。
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { __setDbForTests } from "@/lib/db/client";
import {
  __resetCheckSellerLatencyHelpersForTests,
  __setCheckSellerCacheForTests,
  makeGetCheckSellerCached,
  type CheckSellerCacheTiming,
} from "@/lib/api/check-seller-cache";
import { preferGetResourceHit, resourceHitDefaultMethods } from "@/lib/resolve/lookup";
import { resourceId as toResourceId, endpointHash } from "@/lib/ids/canonical";
import type { McpDeps } from "@/lib/mcp/tools";
const URL_A = "https://seller-a.example/api";
const URL_B = "https://seller-b.example/api";

function staleOnlyCache() {
  return (() => async () => ({
    out: {} as never,
    cacheReadAt: "2026-01-01T00:00:00.000Z",
  })) as unknown as Parameters<typeof makeGetCheckSellerCached>[0];
}

function countingDeps(asOf: string): McpDeps & { counts: { resolve: number } } {
  const counts = { resolve: 0 };
  return {
    counts,
    resolve: (async () => {
      counts.resolve++;
      return { resource: null, endpoints: [] };
    }) as unknown as McpDeps["resolve"],
    decide: async () => null,
    l1Purchases: async () => [],
    sellerPage: {} as McpDeps["sellerPage"],
    hostExtras: async () => ({}) as never,
    now: () => new Date(asOf),
  } as unknown as McpDeps & { counts: { resolve: number } };
}

afterEach(() => {
  __setCheckSellerCacheForTests(null);
  __resetCheckSellerLatencyHelpersForTests();
  __setDbForTests(null);
});

test("distinct sellers in sequence: stale refresh is fresh, not coalesced", async () => {
  __setCheckSellerCacheForTests(staleOnlyCache());
  const read = makeGetCheckSellerCached(staleOnlyCache());
  const deps = countingDeps("2026-11-28T12:00:00.000Z");
  const tA: CheckSellerCacheTiming = {};
  const tB: CheckSellerCacheTiming = {};
  await read(deps, { url: URL_A }, tA);
  await read(deps, { url: URL_B }, tB);
  assert.equal(tA.path, "fresh", "stale cache on one seller is a foreground refresh, not cross-seller coalescing");
  assert.equal(tB.path, "fresh");
  assert.equal(deps.counts.resolve, 2, "each distinct seller gets its own read");
});

test("same seller concurrent stale reads: second caller is coalesced", async () => {
  __setCheckSellerCacheForTests(staleOnlyCache());
  const read = makeGetCheckSellerCached(staleOnlyCache());
  const deps = countingDeps("2026-11-28T12:00:00.000Z");
  const timingA: CheckSellerCacheTiming = {};
  const timingB: CheckSellerCacheTiming = {};
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow = {
    ...deps,
    resolve: (async () => {
      await gate;
      deps.counts.resolve++;
      return { resource: null, endpoints: [] };
    }) as unknown as McpDeps["resolve"],
  };
  const runA = read(slow, { url: URL_A }, timingA);
  const runB = read(slow, { url: URL_A }, timingB);
  await new Promise((r) => setImmediate(r));
  release();
  await Promise.all([runA, runB]);
  assert.equal(deps.counts.resolve, 1);
  const paths = new Set([timingA.path, timingB.path]);
  assert.ok(paths.has("coalesced"), `expected one coalesced caller, got ${timingA.path} / ${timingB.path}`);
  assert.ok(paths.has("fresh"));
});

test("stale cache + background revalidate: one checkSeller read", async () => {
  let innerReads = 0;
  const revalidateAndStale = ((fn: () => Promise<unknown>) => {
    let n = 0;
    return async () => {
      n++;
      if (n === 1) {
        innerReads++;
        void fn();
        return { out: {} as never, cacheReadAt: "2026-01-01T00:00:00.000Z" };
      }
      return fn();
    };
  }) as unknown as Parameters<typeof makeGetCheckSellerCached>[0];
  __setCheckSellerCacheForTests(revalidateAndStale);
  const deps = countingDeps("2026-11-28T12:00:00.000Z");
  await makeGetCheckSellerCached(revalidateAndStale)(deps, { url: URL_A });
  assert.equal(innerReads, 1, "background revalidation shares one in-flight read with the caller");
  assert.equal(deps.counts.resolve, 1);
});

test("resourceHitDefaultMethods: GET と POST を IN 1 本で読む", async () => {
  const URL = "https://resolve-one-query.example/r";
  const getId = toResourceId("GET", URL);
  let executes = 0;
  __setDbForTests({
    execute: async () => {
      executes++;
      return {
        rows: [
          {
            observatory_id: "00000000-0000-0000-0000-000000000001",
            endpoint_hash: endpointHash(URL),
            resource_id: getId,
            canonical_url: URL,
            method: "GET",
            payee_id: null,
            status: "active",
            first_seen: null,
            last_seen: null,
            network: "eip155:8453",
          },
        ],
      };
    },
  } as never);
  const hit = await resourceHitDefaultMethods(URL);
  assert.equal(executes, 1);
  assert.equal(hit?.ref.observatory_id, "00000000-0000-0000-0000-000000000001");
});

test("resourceHitDefaultMethods: POST が落ちても GET があれば返す（直列と同じ優先）", async () => {
  const getRef = {
    ref: {
      endpoint_id: "g",
      resource_id: "rid-g",
      observatory_id: "obs-g",
      canonical_url: "https://x",
      method: "GET",
      payee_id: null,
      catalog_status: "listed" as const,
      first_seen: null,
      last_seen: null,
    },
    network: "eip155:8453",
  };
  const URL = "https://post-fail.example/r";
  const getId = toResourceId("GET", URL);
  const postId = toResourceId("POST", URL);
  let n = 0;
  __setDbForTests({
    execute: async () => {
      n++;
      if (n === 1) {
        return {
          rows: [
            {
              observatory_id: "obs-g",
              endpoint_hash: "g",
              resource_id: getId,
              canonical_url: URL,
              method: "GET",
              payee_id: null,
              status: "active",
              first_seen: null,
              last_seen: null,
              network: "eip155:8453",
            },
          ],
        };
      }
      throw new Error("post side db down");
    },
  } as never);
  const hit = await resourceHitDefaultMethods(URL);
  assert.equal(hit?.ref.observatory_id, "obs-g");
  assert.deepEqual(preferGetResourceHit(getRef, null), getRef);
  void postId;
});

test("resourceHitDefaultMethods と preferGetResourceHit: GET 優先は変わらない", () => {
  const g = {
    ref: {
      endpoint_id: "g",
      resource_id: null,
      observatory_id: "g",
      canonical_url: "https://example/x",
      method: "GET",
      payee_id: null,
      catalog_status: "listed" as const,
      first_seen: null,
      last_seen: null,
    },
    network: "eip155:8453",
  };
  const p = { ...g, ref: { ...g.ref, observatory_id: "p", method: "POST" } };
  assert.equal(preferGetResourceHit(g, p)?.ref.observatory_id, "g");
  assert.equal(preferGetResourceHit(null, p)?.ref.observatory_id, "p");
});