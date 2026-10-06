// ============================================================
// vet402 Observatory L0 — catalog ingestion (design §3).
//
// The property that matters most: resourceKey normalization must be STABLE.
// A key that flaps (query-string noise, host casing, trailing slash) makes
// the daily diff report phantom delistings — the exact false-alarm class the
// observatory exists to kill. Second property: the fetcher must report
// partial fetches honestly (fetchedCount < total), because an incomplete day
// must WITHHOLD delisting judgement, never manufacture it.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeResourceKey,
  parseCatalogItem,
  fetchFullCatalog,
} from "@/lib/observatory/catalog-source";

// ---- normalizeResourceKey --------------------------------------------------

test("resourceKey strips query string and fragment", () => {
  assert.equal(
    normalizeResourceKey("https://api.example.com/v1/data?user=abc&x=1#frag"),
    "api.example.com/v1/data",
  );
});

test("resourceKey lowercases host but preserves path case", () => {
  assert.equal(
    normalizeResourceKey("https://API.Example.COM/CaseSensitive/Path"),
    "api.example.com/CaseSensitive/Path",
  );
});

test("resourceKey treats trailing slash and bare root as the same endpoint", () => {
  assert.equal(normalizeResourceKey("https://api.example.com/"), "api.example.com");
  assert.equal(normalizeResourceKey("https://api.example.com"), "api.example.com");
  assert.equal(
    normalizeResourceKey("https://api.example.com/v1/"),
    normalizeResourceKey("https://api.example.com/v1"),
  );
});

test("resourceKey keeps route-template variables verbatim", () => {
  assert.equal(
    normalizeResourceKey("https://api.example.com/users/:id/balance"),
    "api.example.com/users/:id/balance",
  );
});

test("resourceKey falls back to trimmed raw string for unparseable URLs", () => {
  assert.equal(normalizeResourceKey("  not a url  "), "not a url");
});

// ---- parseCatalogItem ------------------------------------------------------

const SAMPLE_ITEM = {
  resource: "https://api.onesource.example/balance?account=0xd8da",
  type: "http",
  x402Version: 2,
  lastUpdated: "2026-08-13T00:00:00Z",
  description: "ERC20 token balance",
  accepts: [
    {
      amount: "3000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      network: "eip155:8453",
      payTo: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
      recipient: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
      scheme: "exact",
      maxTimeoutSeconds: 3600,
    },
  ],
  extensions: {
    bazaar: {
      info: {
        input: { method: "GET", type: "http" },
        output: { example: { balance: "1" }, type: "json" },
      },
      schema: { $schema: "https://json-schema.org/draft/2020-12/schema" },
    },
  },
  quality: { l30DaysTotalCalls: 732, l30DaysUniquePayers: 41, lastCalledAt: "2026-08-13T12:00:00Z" },
};

test("parseCatalogItem extracts the declared method, uppercased", () => {
  const parsed = parseCatalogItem(SAMPLE_ITEM);
  assert.equal(parsed.method, "GET");
  const lower = parseCatalogItem({
    ...SAMPLE_ITEM,
    extensions: { bazaar: { info: { input: { method: "post" } } } },
  });
  assert.equal(lower.method, "POST");
});

test("parseCatalogItem records undeclared or unknown methods as null — never guesses", () => {
  const noExt = parseCatalogItem({ ...SAMPLE_ITEM, extensions: undefined });
  assert.equal(noExt.method, null);
  const garbage = parseCatalogItem({
    ...SAMPLE_ITEM,
    extensions: { bazaar: { info: { input: { method: "TRACE_OR_JUNK" } } } },
  });
  assert.equal(garbage.method, null);
});

test("parseCatalogItem extracts representative accepts[0] fields", () => {
  const parsed = parseCatalogItem(SAMPLE_ITEM);
  assert.equal(parsed.network, "eip155:8453");
  assert.equal(parsed.payTo, "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea");
  assert.equal(parsed.priceAmount, "3000");
  assert.equal(parsed.priceAsset, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
});

test("parseCatalogItem lowercases payTo so the claim-join to verifiedPayees cannot miss on casing", () => {
  const mixed = parseCatalogItem({
    ...SAMPLE_ITEM,
    accepts: [{ ...SAMPLE_ITEM.accepts[0], payTo: "0xABCdef0000000000000000000000000000000001" }],
  });
  assert.equal(mixed.payTo, "0xabcdef0000000000000000000000000000000001");
});

test("parseCatalogItem tolerates missing accepts and quality", () => {
  const bare = parseCatalogItem({ resource: "https://x.example/a" });
  assert.equal(bare.resourceKey, "x.example/a");
  assert.equal(bare.payTo, null);
  assert.equal(bare.network, null);
  assert.equal(bare.qualityCalls30d, null);
  assert.equal(bare.declaredSchema, null);
});

test("parseCatalogItem falls back to recipient when payTo is absent", () => {
  const parsed = parseCatalogItem({
    ...SAMPLE_ITEM,
    accepts: [{ ...SAMPLE_ITEM.accepts[0], payTo: undefined }],
  });
  assert.equal(parsed.payTo, "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea");
});

test("parseCatalogItem reads the declared schema from extensions.bazaar.schema", () => {
  const parsed = parseCatalogItem(SAMPLE_ITEM);
  assert.ok(parsed.declaredSchema);
});

// ---- fetchFullCatalog (paging, backoff, honest partial reporting) ----------

function makePagedFetch(pages: Record<number, unknown>, opts?: { failOffsets?: number[] }) {
  const calls: string[] = [];
  const failed = new Set(opts?.failOffsets ?? []);
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const offset = Number(new URL(url).searchParams.get("offset") ?? "0");
    if (failed.has(offset)) {
      failed.delete(offset); // fail once, succeed on retry
      return { ok: false, status: 429, json: async () => ({}) } as Response;
    }
    const body = pages[offset];
    if (!body) return { ok: false, status: 500, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  };
  return { fetchImpl, calls };
}

function page(items: unknown[], total: number) {
  return { items, pagination: { limit: 100, total }, x402Version: 2 };
}

function fakeItem(n: number) {
  return { resource: `https://svc${n}.example/api`, accepts: [], extensions: {} };
}

test("fetchFullCatalog pages through until total and reports a complete fetch", async () => {
  const { fetchImpl } = makePagedFetch({
    0: page([fakeItem(1), fakeItem(2)], 3),
    2: page([fakeItem(3)], 3),
  });
  const result = await fetchFullCatalog({ fetchImpl, pageLimit: 2, sleepMs: 0 });
  assert.equal(result.totalCount, 3);
  assert.equal(result.items.length, 3);
  assert.equal(result.fetchedCount, 3);
  assert.equal(result.complete, true);
});

test("fetchFullCatalog retries a 429 page with backoff and still completes", async () => {
  const { fetchImpl, calls } = makePagedFetch(
    { 0: page([fakeItem(1), fakeItem(2)], 3), 2: page([fakeItem(3)], 3) },
    { failOffsets: [2] },
  );
  const result = await fetchFullCatalog({ fetchImpl, pageLimit: 2, sleepMs: 0 });
  assert.equal(result.complete, true);
  assert.equal(result.fetchedCount, 3);
  // offset=2 was requested twice: once 429, once OK
  assert.equal(calls.filter((u) => u.includes("offset=2")).length, 2);
});

test("fetchFullCatalog reports an INCOMPLETE fetch instead of pretending", async () => {
  const { fetchImpl } = makePagedFetch({
    0: page([fakeItem(1), fakeItem(2)], 4),
    // offset=2 permanently 500s
  });
  const result = await fetchFullCatalog({
    fetchImpl,
    pageLimit: 2,
    sleepMs: 0,
    maxRetriesPerPage: 1,
  });
  assert.equal(result.complete, false);
  assert.equal(result.fetchedCount, 2);
  assert.equal(result.totalCount, 4);
});

// ---- concurrent paging (2026-10-06: the sequential fetch passed the 300s cron at 35k rows) ----

/** `n` one-item pages (pageLimit 1) so offset = page index; each response is delayed `delayMs`, optionally per offset. */
function makeSlowPages(n: number, delayMs: (offset: number) => number, failForever: number[] = []) {
  let inFlight = 0;
  let maxInFlight = 0;
  const offsets: number[] = [];
  const fetchImpl = async (url: string) => {
    const offset = Number(new URL(url).searchParams.get("offset") ?? "0");
    offsets.push(offset);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, delayMs(offset)));
    } finally {
      inFlight--;
    }
    if (failForever.includes(offset) || offset >= n) return { ok: false, status: 500, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => page([fakeItem(offset)], n) } as unknown as Response;
  };
  return { fetchImpl, offsets, maxInFlight: () => maxInFlight };
}

test("fetchFullCatalog with concurrency: every page once, complete, bounded in-flight, items in offset order", async () => {
  // later offsets answer FIRST — the merge must still follow offset order, not arrival order
  const { fetchImpl, offsets, maxInFlight } = makeSlowPages(12, (o) => (12 - o) * 3);
  const result = await fetchFullCatalog({ fetchImpl, pageLimit: 1, sleepMs: 0, concurrency: 4 });
  assert.equal(result.complete, true);
  assert.equal(result.fetchedCount, 12);
  assert.equal(result.totalCount, 12);
  assert.deepEqual([...offsets].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.ok(maxInFlight() > 1 && maxInFlight() <= 4, `in flight ${maxInFlight()}`);
  assert.deepEqual(result.items.map((i) => i.resourceUrl), Array.from({ length: 12 }, (_, i) => `https://svc${i}.example/api`));
});

test("fetchFullCatalog with concurrency: on a key collision the lowest offset wins, whichever page arrives first", async () => {
  // offset 0 is its own key (the first page is always read alone); offsets 1 and 2 collide and 2 answers FIRST
  const fetchImpl = async (url: string) => {
    const offset = Number(new URL(url).searchParams.get("offset") ?? "0");
    await new Promise((r) => setTimeout(r, offset === 1 ? 40 : 0));
    const resource = offset === 0 ? "https://first.example/api" : "https://same.example/api";
    return {
      ok: true,
      status: 200,
      json: async () => page([{ resource, description: `from-${offset}`, accepts: [], extensions: {} }], 3),
    } as unknown as Response;
  };
  const result = await fetchFullCatalog({ fetchImpl, pageLimit: 1, sleepMs: 0, concurrency: 2 });
  assert.equal(result.items.length, 2);
  assert.equal(result.items.find((i) => i.resourceUrl === "https://same.example/api")?.description, "from-1");
  assert.equal(result.fetchedCount, 3);
  assert.equal(result.complete, true);
});

/** Pages of `size` items numbered by position (so a gap is visible by number); `sizes[offset]` overrides a page's length. */
function makeNumberedPages(total: number, size: number, sizes: Record<number, number> = {}, totals: Record<number, number> = {}) {
  return async (url: string) => {
    const u = new URL(url);
    const offset = Number(u.searchParams.get("offset") ?? "0");
    const len = Math.max(0, Math.min(sizes[offset] ?? size, total - offset));
    const items = Array.from({ length: len }, (_, i) => fakeItem(offset + i));
    return { ok: true, status: 200, json: async () => page(items, totals[offset] ?? total) } as unknown as Response;
  };
}

test("fetchFullCatalog with concurrency: a short first page plus a short middle page cannot balance out into complete=true (reviewer BLOCK, 2026-10-06)", async () => {
  // 100 items, page size 10, first page returns 9 (step 9, so later pages overlap), the page at offset 18 returns 5 (a gap).
  // The overcount used to cancel the gap: fetched >= total while real keys 23..26 were never read -> false delisting.
  const result = await fetchFullCatalog({
    fetchImpl: makeNumberedPages(100, 10, { 0: 9, 18: 5 }),
    pageLimit: 10,
    sleepMs: 0,
    concurrency: 3,
  });
  assert.equal(result.complete, false);
});

test("fetchFullCatalog with concurrency: a short page in the middle is incomplete, a short last page is not", async () => {
  const mid = await fetchFullCatalog({ fetchImpl: makeNumberedPages(100, 10, { 30: 4 }), pageLimit: 10, sleepMs: 0, concurrency: 3 });
  assert.equal(mid.complete, false);
  const tail = await fetchFullCatalog({ fetchImpl: makeNumberedPages(95, 10), pageLimit: 10, sleepMs: 0, concurrency: 3 });
  assert.equal(tail.complete, true);
  assert.equal(tail.fetchedCount, 95);
  assert.equal(tail.items.length, 95);
});

test("fetchFullCatalog with concurrency: a total that wobbles down mid-fetch cannot end the day complete with pages unread", async () => {
  // page at offset 20 claims total 25, so workers stop claiming; later pages (30..90) were never read.
  const result = await fetchFullCatalog({
    fetchImpl: makeNumberedPages(100, 10, {}, { 20: 25 }),
    pageLimit: 10,
    sleepMs: 0,
    concurrency: 1,
  });
  assert.equal(result.complete, false);
});

test("fetchFullCatalog with concurrency: a page that never answers makes the day INCOMPLETE (no delisting judgement)", async () => {
  const { fetchImpl } = makeSlowPages(10, () => 1, [4]);
  const result = await fetchFullCatalog({ fetchImpl, pageLimit: 1, sleepMs: 0, concurrency: 3, maxRetriesPerPage: 1 });
  assert.equal(result.complete, false);
  assert.ok(result.fetchedCount < result.totalCount);
  assert.equal(result.totalCount, 10);
});

test("fetchFullCatalog stops at the deadline and reports INCOMPLETE with what it has, instead of running into the function timeout", async () => {
  const { fetchImpl, offsets } = makeSlowPages(200, () => 10);
  const started = Date.now();
  const result = await fetchFullCatalog({ fetchImpl, pageLimit: 1, sleepMs: 0, concurrency: 2, deadlineMs: 60 });
  assert.ok(Date.now() - started < 1500, "returned promptly after the deadline");
  assert.equal(result.complete, false);
  assert.ok(result.fetchedCount > 0 && result.fetchedCount < 200);
  assert.equal(result.items.length, result.fetchedCount);
  assert.ok(offsets.length < 200);
});

test("fetchFullCatalog default (concurrency 1) stays sequential", async () => {
  const { fetchImpl, maxInFlight } = makeSlowPages(5, () => 2);
  const result = await fetchFullCatalog({ fetchImpl, pageLimit: 1, sleepMs: 0 });
  assert.equal(result.complete, true);
  assert.equal(maxInFlight(), 1);
});

// ---- NUL sanitation (live-catalog poison, found 2026-08-14) ----------------
// One real catalog item carried a NUL (U+0000) inside its declared schema;
// Postgres rejects NUL in text/jsonb ("invalid byte sequence for encoding
// UTF8"), and that single row failed its whole 500-row chunk in production.
// Sanitize at parse time so one seller's bytes can never take down the sync.

test("parseCatalogItem strips NUL characters from every string, however nested", () => {
  const NUL = String.fromCharCode(0);
  const parsed = parseCatalogItem({
    resource: `https://nul.example/api${NUL}`,
    description: `desc${NUL}ription`,
    accepts: [
      {
        amount: `10${NUL}00`,
        asset: "0xUSDC",
        network: "eip155:8453",
        payTo: `0xPAY${NUL}1`,
        extra: { nested: `a${NUL}b`, list: [`x${NUL}y`] },
      },
    ],
    extensions: {
      bazaar: {
        info: { input: { method: "GET" } },
        schema: { title: `s${NUL}chema`, properties: { deep: { const: `v${NUL}0` } } },
      },
    },
  });
  const flat = JSON.stringify(parsed);
  assert.ok(!flat.includes("\\u0000"), "no NUL may survive anywhere in the parsed item");
  assert.equal(parsed.description, "description");
  assert.equal(parsed.payTo, "0xpay1");
  assert.equal(parsed.resourceKey, "nul.example/api");
});

test("fetchFullCatalog dedupes items whose normalized key collides (keeps first)", async () => {
  const { fetchImpl } = makePagedFetch({
    0: page(
      [
        { resource: "https://dup.example/api?a=1", accepts: [] },
        { resource: "https://dup.example/api?a=2", accepts: [] },
      ],
      2,
    ),
  });
  const result = await fetchFullCatalog({ fetchImpl, pageLimit: 100, sleepMs: 0 });
  assert.equal(result.items.length, 1);
  assert.equal(result.fetchedCount, 2, "fetchedCount counts raw items, dedup is separate");
});

test("parseCatalogItem preserves base58 case for non-EVM payTo (Solana) — lowercasing destroys the address", () => {
  const sol = parseCatalogItem({
    ...SAMPLE_ITEM,
    accepts: [
      {
        ...SAMPLE_ITEM.accepts[0],
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        payTo: "GqSs5L9aPWGJwyRQe35YKQaWMDPh3R1dMqfSEPhSgkM",
      },
    ],
  });
  assert.equal(sol.payTo, "GqSs5L9aPWGJwyRQe35YKQaWMDPh3R1dMqfSEPhSgkM");
});
