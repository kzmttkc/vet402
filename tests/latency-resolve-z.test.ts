// 依頼 Z: 初めての売り手の coalesced 誤表示・resolve の二重読み・GET/POST 合流。
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { __setDbForTests } from "@/lib/db/client";
import {
  __resetCheckSellerLatencyHelpersForTests,
  __setCheckSellerCacheForTests,
  isCheckSellerCachedReadFresh,
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

// 差分: 直す前（#170 の GET/POST 並列読み）と後で resolve の resource が一致すること。
// 直す前の形は、変えていない getResourceWithNetwork（resourceRow: 完全一致 → 別名）を GET と POST で読み、GET を優先する。
type FakeRow = { resource_id: string; status: string; observatory_id: string; method: string; last_seen: string | null };
type FakeWorld = { rows: FakeRow[]; aliases: Record<string, string> };

async function fakeDbFor(world: FakeWorld, url: string) {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const asRow = (r: FakeRow) => ({
    observatory_id: r.observatory_id,
    endpoint_hash: endpointHash(url),
    resource_id: r.resource_id,
    canonical_url: url,
    method: r.method,
    payee_id: null,
    status: r.status,
    first_seen: null,
    last_seen: r.last_seen,
    network: "eip155:8453",
  });
  let executes = 0;
  const db = {
    get executes() {
      return executes;
    },
    execute: async (q: Parameters<typeof dialect.sqlToQuery>[0]) => {
      executes++;
      const { sql: text, params } = dialect.sqlToQuery(q);
      const flat = text.replace(/\s+/g, " ");
      if (/FROM x402_resource_aliases/.test(flat)) {
        const to = world.aliases[String(params[0])];
        return { rows: to ? [{ resource_id: to }] : [] };
      }
      if (/FROM x402_endpoints WHERE resource_id IN/.test(flat)) {
        return { rows: world.rows.filter((r) => params.includes(r.resource_id)).map(asRow) };
      }
      if (/FROM x402_endpoints WHERE resource_id = /.test(flat)) {
        const hit = world.rows
          .filter((r) => r.resource_id === params[0])
          .sort((a, b) => (b.status === "active" ? 1 : 0) - (a.status === "active" ? 1 : 0))[0];
        return { rows: hit ? [asRow(hit)] : [] };
      }
      return { rows: [] };
    },
  };
  return db;
}

test("resourceHitDefaultMethods: 直す前（GET/POST 並列＋GET 優先）と同じ resource を返す", async () => {
  const { getResourceWithNetwork } = await import("@/lib/resolve/lookup");
  const URL = "https://resolve-diff.example/api";
  const getId = toResourceId("GET", URL);
  const postId = toResourceId("POST", URL);
  const canonGet = toResourceId("GET", "https://resolve-diff.example/canonical-get");
  const canonPost = toResourceId("POST", "https://resolve-diff.example/canonical-post");
  const row = (resource_id: string, observatory_id: string, method: string, status = "active"): FakeRow => ({
    resource_id,
    observatory_id,
    method,
    status,
    last_seen: null,
  });
  const worlds: Record<string, FakeWorld> = {
    get_only: { rows: [row(getId, "g", "GET")], aliases: {} },
    post_only: { rows: [row(postId, "p", "POST")], aliases: {} },
    both: { rows: [row(getId, "g", "GET"), row(postId, "p", "POST")], aliases: {} },
    neither: { rows: [], aliases: {} },
    get_inactive_only: { rows: [row(getId, "g-off", "GET", "delisted")], aliases: {} },
    get_active_beats_inactive: {
      rows: [row(getId, "g-off", "GET", "delisted"), row(getId, "g-on", "GET")],
      aliases: {},
    },
    get_via_alias: { rows: [row(canonGet, "g-alias", "GET")], aliases: { [getId]: canonGet } },
    post_via_alias: { rows: [row(canonPost, "p-alias", "POST")], aliases: { [postId]: canonPost } },
    get_alias_beats_post_exact: {
      rows: [row(canonGet, "g-alias", "GET"), row(postId, "p", "POST")],
      aliases: { [getId]: canonGet },
    },
  };
  for (const [name, world] of Object.entries(worlds)) {
    __setDbForTests(await fakeDbFor(world, URL));
    const [before, beforePost] = await Promise.all([getResourceWithNetwork(getId), getResourceWithNetwork(postId)]);
    const expected = preferGetResourceHit(before, beforePost);
    const fakeAfter = await fakeDbFor(world, URL);
    __setDbForTests(fakeAfter);
    const after = await resourceHitDefaultMethods(URL);
    assert.deepEqual(after, expected, `world ${name}: resolve の resource が直す前と違う`);
    if (name === "get_only" || name === "both") {
      assert.equal(fakeAfter.executes, 1, `world ${name}: GET が完全一致で当たれば問い合わせは 1 本`);
    }
  }
});

// 点検の指摘（2026-11-28）: 走っている読みに合流した callback が「合流した時刻」を cacheReadAt に付けると、
// 読み始めから 60 秒を超えた値が fresh に見える。合流した側も先に始めた読みの時刻で数える。
test("callback joining an in-flight read keeps the read start as cacheReadAt (no 60 s overrun)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let firstReadStartedMs = 0;
  let reads = 0;
  const deps = {
    ...countingDeps("2026-11-28T12:00:00.000Z"),
    resolve: (async () => {
      reads++;
      if (!firstReadStartedMs) firstReadStartedMs = Date.now();
      await gate;
      return { resource: null, endpoints: [] };
    }) as unknown as McpDeps["resolve"],
  } as unknown as McpDeps;
  let calls = 0;
  const box: { stored: { cacheReadAt: string } | null } = { stored: null };
  const cache = ((fn: () => Promise<{ cacheReadAt: string }>) => async () => {
    calls++;
    if (calls === 1) return { out: {}, cacheReadAt: "2026-01-01T00:00:00.000Z" };
    box.stored = await fn();
    return box.stored;
  }) as unknown as Parameters<typeof makeGetCheckSellerCached>[0];
  const read = makeGetCheckSellerCached(cache);
  const a = read(deps, { url: URL_A });
  await new Promise((r) => setTimeout(r, 300));
  const b = read(deps, { url: URL_A });
  await new Promise((r) => setTimeout(r, 10));
  release();
  await Promise.all([a, b]);
  assert.equal(reads, 1, "the second request joins the first read");
  const stored = box.stored;
  assert.ok(stored, "the callback stored a payload");
  const skew = Date.parse(stored.cacheReadAt) - firstReadStartedMs;
  assert.ok(skew <= 5, `stored cacheReadAt must not be later than the read start (skew ${skew} ms)`);
  assert.equal(isCheckSellerCachedReadFresh(stored.cacheReadAt, firstReadStartedMs + 60_100), false);
});
