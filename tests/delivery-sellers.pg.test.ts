// ============================================================
// GET /api/v1/delivery/sellers.json（2026-10-28・合格の表 #1–#7）。
//
// Run: TEST_DATABASE_URL=postgres://takeshi@localhost:5432/vet402_test_feed \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/delivery-sellers.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
const FEED_SCALE_ENDPOINTS = 7_000;
const FEED_SCALE_PURCHASES_EACH = 3;

if (!TEST_DB) {
  test("delivery sellers feed (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;
  process.env.PROXY_HEADER_SOURCE = "generic";

  test("delivery feed: fixture counts, filters, secrets, scale", async () => {
    const schema = await import("@/lib/db/schema");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { canonicalUrl, endpointHash, resourceId } = await import("@/lib/ids/canonical");
    const { readDeliverySellersFeed } = await import("@/lib/delivery/sellers-feed");
    const { PAID_ATTEMPT_STATUSES } = await import("@/lib/observatory/reader");
    const { CIRCLE_DISCOVERY_SOURCE } = await import("@/lib/observatory/listing-sources");
    const { CATALOG_SOURCE } = await import("@/lib/observatory/catalog-source");
    const db = getDb()!;

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);

    const SECRETS = {
      nonce: "0xNONCEFEED000000000000000000000000000000000000000000000000beef",
      payer: "0x8888888888888888888888888888888888888888",
      pay_to: "0x7777777777777777777777777777777777777777",
      tx_hash: "0xTXFEED00000000000000000000000000000000000000000000000000000001",
    };
    const now = Date.now();
    const daysAgo = (d: number) => new Date(now - d * 86_400_000);

    const mkEp = async (url: string, o: { source: string; network: string; status?: string; quality?: number }) => {
      const c = canonicalUrl(url)!;
      const u = new URL(c.url);
      const method = "GET";
      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: `${u.host}${u.pathname}`.toLowerCase(),
          resourceUrl: url,
          canonicalUrl: c.url,
          resourceId: resourceId(method, c.url),
          endpointHash: endpointHash(c.url),
          source: o.source,
          method,
          network: o.network,
          payTo: SECRETS.pay_to,
          priceAmount: "7000",
          status: o.status ?? "active",
          qualityPayers30d: o.quality ?? null,
          payeeId: `${o.network}:${SECRETS.pay_to}`,
          lastSeenAt: daysAgo(0),
        })
        .returning();
      return ep.id;
    };

    let txSeq = 0;
    const mkPurchase = async (
      endpointId: string,
      o: { status: string; http?: number | null; payload?: boolean | null; at: Date; tx?: boolean },
    ) => {
      const tx = o.tx === false ? null : `0x${(++txSeq).toString(16).padStart(64, "0")}`;
      await db.insert(schema.x402L1Purchases).values({
        endpointId,
        attemptedAt: o.at,
        status: o.status,
        network: "eip155:8453",
        httpStatusPaid: o.http ?? null,
        payloadNonEmpty: o.payload ?? null,
        authNonce: SECRETS.nonce,
        payer: SECRETS.payer,
        payTo: SECRETS.pay_to,
        txHash: tx,
        amountUnits: "7000",
        spentUnits: "7000",
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      });
    };

    const mixedUrl = "https://feed-mixed.example/api";
    const mixedId = await mkEp(mixedUrl, { source: CATALOG_SOURCE, network: "eip155:8453" });
    await mkPurchase(mixedId, { status: "settled", http: 200, payload: true, at: daysAgo(2) });
    await mkPurchase(mixedId, { status: "settled", http: 500, payload: true, at: daysAgo(1), tx: true });
    await mkPurchase(mixedId, { status: "settle_failed", http: null, payload: null, at: daysAgo(1), tx: false });

    const oldUrl = "https://feed-old.example/api";
    const oldId = await mkEp(oldUrl, { source: CATALOG_SOURCE, network: "eip155:8453" });
    await mkPurchase(oldId, { status: "settled", http: 200, payload: true, at: daysAgo(40) });

    const inactiveUrl = "https://feed-inactive.example/api";
    const inactiveId = await mkEp(inactiveUrl, { source: CATALOG_SOURCE, network: "eip155:8453", status: "delisted" });
    await mkPurchase(inactiveId, { status: "settled", http: 200, payload: true, at: daysAgo(2) });

    const noPayUrl = "https://feed-nopay.example/api";
    await mkEp(noPayUrl, { source: CATALOG_SOURCE, network: "eip155:8453" });

    const arcUrl = "https://feed-arc.example/api";
    const arcId = await mkEp(arcUrl, { source: CIRCLE_DISCOVERY_SOURCE, network: "eip155:5042", quality: 5 });
    await mkPurchase(arcId, { status: "settled", http: 200, payload: true, at: daysAgo(3) });

    const baseCircleUrl = "https://feed-base-circle.example/api";
    const baseCircleId = await mkEp(baseCircleUrl, { source: CIRCLE_DISCOVERY_SOURCE, network: "eip155:8453" });
    await mkPurchase(baseCircleId, { status: "settled", http: 200, payload: true, at: daysAgo(2) });

    let body = await readDeliverySellersFeed(db, { network: null, minDelivered: null, listedIn: null });
    const mixed = body.rows.find((r) => r.url === mixedUrl);
    assert.ok(mixed, "mixed row");
    assert.equal(mixed.delivered_30d, 1);
    assert.equal(mixed.settled_not_delivered_30d, 1);
    assert.equal(mixed.paid_attempts_30d, 3);

    assert.ok(!body.rows.some((r) => r.url === oldUrl));
    assert.ok(!body.rows.some((r) => r.url === inactiveUrl));
    assert.ok(!body.rows.some((r) => r.url === noPayUrl));

    const blob = JSON.stringify(body);
    for (const k of ["nonce", "payer", "pay_to"] as const) {
      assert.equal(blob.includes(SECRETS[k]), false, k);
    }
    assert.equal(blob.includes(SECRETS.tx_hash), false, "tx_hash");

    body = await readDeliverySellersFeed(db, { network: "eip155:5042", minDelivered: null, listedIn: "circle" });
    assert.deepEqual(
      body.rows.map((r) => r.url),
      [arcUrl],
    );

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);
    const t0 = performance.now();
    await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, source, method, network, pay_to, price_amount, status, canonical_url, last_seen_at)
      SELECT 'host' || n || '.example/r' || n,
             'https://host' || n || '.example/r' || n,
             CASE WHEN n % 3 = 0 THEN ${CIRCLE_DISCOVERY_SOURCE} WHEN n % 3 = 1 THEN 'mpp_directory' ELSE ${CATALOG_SOURCE} END,
             'GET',
             CASE WHEN n % 2 = 0 THEN 'eip155:5042' ELSE 'eip155:8453' END,
             ${SECRETS.pay_to},
             (1000 * (1 + n % 50))::text,
             'active',
             'https://host' || n || '.example/r' || n,
             now()
      FROM generate_series(1, ${FEED_SCALE_ENDPOINTS}) n`);
    await db.execute(sql`
      WITH ids AS (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM x402_endpoints)
      INSERT INTO x402_l1_purchases (endpoint_id, attempted_at, status, network, http_status_paid, payload_non_empty, spent_units, amount_units)
      SELECT ids.id,
             now() - (g.n % 28) * interval '1 day',
             CASE WHEN g.n % 3 = 0 THEN 'settled' WHEN g.n % 3 = 1 THEN 'settle_failed' ELSE 'no_402' END,
             'eip155:8453',
             CASE WHEN g.n % 3 = 0 THEN 200 ELSE 500 END,
             CASE WHEN g.n % 3 = 0 THEN true ELSE false END,
             '1000', '1000'
      FROM generate_series(1, ${FEED_SCALE_ENDPOINTS * FEED_SCALE_PURCHASES_EACH}) g(n)
      JOIN ids ON ids.rn = 1 + ((g.n - 1) / ${FEED_SCALE_PURCHASES_EACH})`);
    await db.execute(sql`ANALYZE x402_endpoints`);
    await db.execute(sql`ANALYZE x402_l1_purchases`);
    const seedMs = performance.now() - t0;

    const q0 = performance.now();
    const scale = await readDeliverySellersFeed(db, { network: null, minDelivered: null, listedIn: null });
    const queryMs = performance.now() - q0;
    const bytes = Buffer.byteLength(JSON.stringify(scale), "utf8");

    console.log("scale_seed_ms", seedMs);
    console.log("scale_query_ms", queryMs);
    console.log("scale_bytes", bytes);
    console.log("scale_row_count", scale.row_count);

    assert.ok(queryMs < 30_000, `query took ${queryMs}ms`);
    assert.ok(bytes <= 4.5 * 1024 * 1024, `response ${bytes} bytes`);
    assert.equal(scale.row_count, FEED_SCALE_ENDPOINTS);
    assert.ok(PAID_ATTEMPT_STATUSES.length >= 1);
  });
}
