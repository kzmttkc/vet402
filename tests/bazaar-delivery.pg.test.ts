// ============================================================
// Bazaar delivery API（DB）。sellers.json 行と by-resource / annotate の一致。
// Run: TEST_DATABASE_URL=postgres://… npx tsx --test --test-force-exit --test-concurrency=1 tests/bazaar-delivery.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("bazaar delivery (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;
  process.env.PROXY_HEADER_SOURCE = "generic";

  test("sellers.json の行と by-resource の delivery が全欄一致（201 件超の署名済み試行）", async () => {
    const schema = await import("@/lib/db/schema");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { canonicalUrl, endpointHash, resourceId } = await import("@/lib/ids/canonical");
    const { resetDeliveryFeedCacheForTest } = await import("@/lib/delivery/sellers-feed-cache");
    const { GET: sellersGet } = await import("@/app/api/v1/delivery/sellers.json/route");
    const { GET: byResourceGet } = await import("@/app/api/v1/delivery/by-resource/route");
    const db = getDb()!;

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);
    resetDeliveryFeedCacheForTest();

    const listed = "https://bazaar-window-count.example/api/bulk";
    const canonical = canonicalUrl(listed)!.url;
    const method = "GET";
    const u = new URL(canonical);
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: `${u.host}${u.pathname}`.toLowerCase(),
        resourceUrl: listed,
        canonicalUrl: canonical,
        resourceId: resourceId(method, canonical),
        endpointHash: endpointHash(canonical),
        source: "cdp_bazaar",
        method,
        network: "eip155:8453",
        payTo: "0x1111111111111111111111111111111111111111",
        priceAmount: "1000",
        status: "active",
        payeeId: "eip155:8453:0x1111111111111111111111111111111111111111",
        lastSeenAt: new Date(),
      })
      .returning();

    const base = Date.now() - 2 * 86_400_000;
    const rows: (typeof schema.x402L1Purchases.$inferInsert)[] = [];
    for (let i = 0; i < 250; i++) {
      const at = new Date(base + i * 1000);
      if (i < 40) {
        rows.push({
          endpointId: ep.id,
          attemptedAt: at,
          status: "l0_probe_only",
          network: "eip155:8453",
          httpStatusPaid: 200,
        });
        continue;
      }
      const signedIndex = i - 40;
      const delivered = signedIndex < 150;
      const settled4xx = !delivered && signedIndex < 170;
      rows.push({
        endpointId: ep.id,
        attemptedAt: at,
        status: delivered || settled4xx ? "settled" : "settle_failed",
        network: "eip155:8453",
        httpStatusPaid: delivered ? 200 : settled4xx ? 404 : 500,
        payloadNonEmpty: delivered ? true : settled4xx ? true : null,
        authNonce: `0x${String(signedIndex).padStart(2, "0")}`,
        payer: "0x2222222222222222222222222222222222222222",
        payTo: "0x1111111111111111111111111111111111111111",
        txHash: delivered || settled4xx ? `0x${String(signedIndex).padStart(64, "c")}` : undefined,
        amountUnits: "1000",
        spentUnits: delivered || settled4xx ? "1000" : undefined,
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      });
    }
    await db.insert(schema.x402L1Purchases).values(rows);

    const ip = "203.0.113.210";
    const feedRes = await sellersGet(new NextRequest("http://localhost/api/v1/delivery/sellers.json", { headers: { "x-forwarded-for": ip } }));
    assert.equal(feedRes.status, 200);
    const feedJson = (await feedRes.json()) as { rows: Record<string, unknown>[]; as_of: string };
    const feedRow = feedJson.rows.find((r) => canonicalUrl(String(r.url))?.url === canonical);
    assert.ok(feedRow, "sellers.json should list the seeded endpoint");

    const byRes = await byResourceGet(
      new NextRequest(`http://localhost/api/v1/delivery/by-resource?url=${encodeURIComponent(listed)}`, {
        headers: { "x-forwarded-for": ip },
      }),
    );
    assert.equal(byRes.status, 200);
    const byJson = (await byRes.json()) as {
      url: string;
      delivery: Record<string, unknown> | null;
      as_of: string;
      rate_formula: string;
    };
    assert.equal(byJson.url, canonical);
    assert.equal(byJson.as_of, feedJson.as_of);
    assert.equal(byJson.rate_formula, "v1.0-wilson95");
    assert.ok(byJson.delivery);

    // Compare with the sellers.json response row itself, field by field (no rebuilding).
    const pairs: [string, string][] = [
      ["paidAttempts30d", "paid_attempts_30d"],
      ["delivered30d", "delivered_30d"],
      ["settledNotDelivered30d", "settled_not_delivered_30d"],
      ["deliveryRateLowerBps30d", "delivery_rate_lower_bps_30d"],
      ["deliveryRateBand30d", "delivery_rate_band_30d"],
      ["lastAttemptAt30d", "last_attempt_at_30d"],
      ["lastDeliveredAt30d", "last_delivered_at_30d"],
      ["recordUrl", "record_url"],
      ["network", "network"],
    ];
    for (const [mine, theirs] of pairs) {
      assert.deepEqual(byJson.delivery![mine], feedRow![theirs], `${mine} vs sellers.json ${theirs}`);
    }
    assert.equal(Object.keys(byJson.delivery!).length, pairs.length);
    assert.ok(Number(feedRow!.paid_attempts_30d) >= 200, "fixture includes more than 200 signed attempts in the window");
  });

  test("by-resource と annotate が同じ delivery を返す・canonical・記録なしは null", async () => {
    const schema = await import("@/lib/db/schema");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { canonicalUrl, endpointHash, resourceId } = await import("@/lib/ids/canonical");
    const { resetDeliveryFeedCacheForTest } = await import("@/lib/delivery/sellers-feed-cache");
    const { GET } = await import("@/app/api/v1/delivery/by-resource/route");
    const { POST } = await import("@/app/api/v1/delivery/annotate/route");
    const db = getDb()!;

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);
    resetDeliveryFeedCacheForTest();

    const listed = "https://Bazaar-Delivery.EXAMPLE/api/echo/";
    const canonical = canonicalUrl(listed)!.url;
    const method = "GET";
    const u = new URL(canonical);
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: `${u.host}${u.pathname}`.toLowerCase(),
        resourceUrl: listed,
        canonicalUrl: canonical,
        resourceId: resourceId(method, canonical),
        endpointHash: endpointHash(canonical),
        source: "cdp_bazaar",
        method,
        network: "eip155:8453",
        payTo: "0x1111111111111111111111111111111111111111",
        priceAmount: "1000",
        status: "active",
        payeeId: "eip155:8453:0x1111111111111111111111111111111111111111",
        lastSeenAt: new Date(),
      })
      .returning();

    const at = new Date(Date.now() - 2 * 86_400_000);
    await db.insert(schema.x402L1Purchases).values([
      {
        endpointId: ep.id,
        attemptedAt: at,
        status: "settled",
        network: "eip155:8453",
        httpStatusPaid: 200,
        payloadNonEmpty: true,
        authNonce: "0x01",
        payer: "0x2222222222222222222222222222222222222222",
        payTo: "0x1111111111111111111111111111111111111111",
        txHash: "0x" + "a".repeat(64),
        amountUnits: "1000",
        spentUnits: "1000",
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      },
      {
        endpointId: ep.id,
        attemptedAt: new Date(at.getTime() + 1000),
        status: "settled",
        network: "eip155:8453",
        httpStatusPaid: 404,
        payloadNonEmpty: true,
        authNonce: "0x02",
        payer: "0x2222222222222222222222222222222222222222",
        payTo: "0x1111111111111111111111111111111111111111",
        txHash: "0x" + "b".repeat(64),
        amountUnits: "1000",
        spentUnits: "1000",
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      },
    ]);

    const ip = "203.0.113.201";
    const byRes = await GET(
      new NextRequest(`http://localhost/api/v1/delivery/by-resource?url=${encodeURIComponent(listed)}`, {
        headers: { "x-forwarded-for": ip },
      }),
    );
    assert.equal(byRes.status, 200);
    const byJson = (await byRes.json()) as { url: string; delivery: Record<string, unknown> | null; rate_formula: string };
    assert.equal(byJson.url, canonical);
    assert.ok(byJson.delivery);
    assert.equal(byJson.rate_formula, "v1.0-wilson95");

    const annRes = await POST(
      new NextRequest("http://localhost/api/v1/delivery/annotate", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({
          items: [
            {
              resource: listed,
              accepts: [{ network: "eip155:8453" }],
              extensions: { bazaar: { info: { input: { method: "GET" } } } },
            },
          ],
        }),
      }),
    );
    assert.equal(annRes.status, 200);
    const annJson = (await annRes.json()) as { items: { delivery: Record<string, unknown> | null }[] };
    assert.deepEqual(annJson.items[0]?.delivery, byJson.delivery);

    const miss = await GET(
      new NextRequest(`http://localhost/api/v1/delivery/by-resource?url=${encodeURIComponent("https://missing.example/none")}`, {
        headers: { "x-forwarded-for": "203.0.113.202" },
      }),
    );
    assert.equal(miss.status, 200);
    const missJson = (await miss.json()) as { delivery: null };
    assert.equal(missJson.delivery, null);
  });
}