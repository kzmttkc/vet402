// Circle x402 discovery. The live page shape (2026-10-26, offset 1000, limit 200)
// has no extensions.bazaar. Method and description are on metadata. The Arc
// Gateway accept is not accepts[0]. A failed later page must keep the pages
// already read, and the client must not ask for limit above 200.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCatalogItem } from "@/lib/observatory/catalog-source";
import {
  CIRCLE_DISCOVERY_PAGE_LIMIT,
  CIRCLE_FETCH_DEADLINE_MS,
  fetchCircleDiscovery,
} from "@/lib/observatory/circle-discovery";

const ROOT = process.cwd();
const FIXTURE = join(ROOT, "tests/fixtures/circle-x402-discovery-page.json");
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const ARC_GATEWAY_WALLET = "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee";
const METHODS = new Set(["GET", "POST", "HEAD", "DELETE"]);

test("Circle の実物 1 ページは Arc の Gateway accept を落とさない", () => {
  const page = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    pagination: { limit: number; total: number };
    items: Record<string, unknown>[];
  };
  assert.equal(page.pagination.limit, 200);
  assert.equal(page.items.length, 200);
  for (const item of page.items) {
    const parsed = parseCatalogItem(item);
    const metadata = (item.metadata ?? {}) as { method?: unknown; description?: unknown };
    const rawMethod = typeof metadata.method === "string" ? metadata.method.toUpperCase() : null;
    const expectedMethod = rawMethod && METHODS.has(rawMethod) ? rawMethod : null;
    assert.equal(parsed.method, expectedMethod);
    const top = typeof item.description === "string" && item.description !== "" ? item.description : null;
    const metaDesc = typeof metadata.description === "string" && metadata.description !== "" ? metadata.description : null;
    assert.equal(parsed.description, top ?? metaDesc);
    const accepts = parsed.rawAccepts as { network?: string; asset?: string; extra?: { name?: string; version?: string; verifyingContract?: string } }[];
    const arc = accepts.filter((a) => a.network === "eip155:5042" && a.extra?.name === "GatewayWalletBatched");
    assert.equal(arc.length, 1);
    assert.equal(arc[0]?.extra?.version, "1");
    assert.equal(arc[0]?.extra?.verifyingContract?.toLowerCase(), ARC_GATEWAY_WALLET);
    assert.equal(arc[0]?.asset?.toLowerCase(), ARC_USDC);
    assert.equal(parsed.declaredInput?.body, "empty");
  }
});

test("bazaar の method は metadata より優先し、bazaar が無いときだけ metadata を読む", () => {
  const both = parseCatalogItem({
    resource: "https://x.example/a",
    description: "from top",
    metadata: { method: "POST", description: "from meta", input: { body: { type: "object" } } },
    extensions: { bazaar: { info: { input: { method: "GET" } } } },
    accepts: [],
  });
  assert.equal(both.method, "GET");
  assert.equal(both.description, "from top");
  const bazaarOnly = parseCatalogItem({
    resource: "https://x.example/a",
    metadata: { method: "POST", description: "from meta" },
    extensions: { bazaar: { info: { input: {} } } },
  });
  assert.equal(bazaarOnly.method, null);
  assert.equal(bazaarOnly.description, null);
  const circle = parseCatalogItem({
    resource: "https://x.example/a",
    metadata: { method: "post", description: "from meta", input: { body: { type: "object" } } },
    accepts: [{ scheme: "exact", network: "eip155:5042", payTo: "0xabc", amount: "1", asset: ARC_USDC }],
  });
  assert.equal(circle.method, "POST");
  assert.equal(circle.description, "from meta");
  assert.equal(circle.declaredInput?.body, "empty");
});

test("Circle の取得は limit 200 を守り、途中で失敗しても読めたページは残る", async () => {
  const page = JSON.parse(readFileSync(FIXTURE, "utf8")) as { items: unknown[] };
  const one = page.items[0];
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const limit = Number(u.searchParams.get("limit"));
    assert.ok(limit <= 200, url);
    const offset = Number(u.searchParams.get("offset"));
    if (offset === 0) {
      return new Response(JSON.stringify({ items: [one], pagination: { limit: 200, offset: 0, total: 400 } }), { status: 200 });
    }
    return new Response("no", { status: 500 });
  };
  const result = await fetchCircleDiscovery({
    fetchImpl,
    pageLimit: 500,
    maxRetriesPerPage: 0,
    sleepMs: 0,
    concurrency: 1,
    deadlineMs: 5_000,
  });
  assert.equal(result.complete, false);
  assert.equal(result.items.length, 1);
  assert.ok(calls.length >= 2);
  for (const url of calls) {
    const u = new URL(url);
    assert.equal(u.searchParams.get("limit"), "200");
    assert.equal(u.hostname, "api.circle.com");
  }
  const accepts = result.items[0]?.rawAccepts as { network?: string; extra?: { name?: string } }[];
  assert.equal(accepts.filter((a) => a.network === "eip155:5042" && a.extra?.name === "GatewayWalletBatched").length, 1);
});

test("Circle の取得締切は aux の maxDuration の中に収まる", () => {
  const route = readFileSync(join(ROOT, "src/app/api/cron/catalog-sync-aux/route.ts"), "utf8");
  assert.match(route, /export const maxDuration = 300/);
  assert.match(route, /await syncCircleDiscovery\(\)/);
  assert.equal(CIRCLE_DISCOVERY_PAGE_LIMIT, 200);
  assert.ok(CIRCLE_FETCH_DEADLINE_MS <= 60_000);
  assert.ok(CIRCLE_FETCH_DEADLINE_MS < 300_000);
});
