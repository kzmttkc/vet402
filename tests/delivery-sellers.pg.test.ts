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
const FEED_SCALE_EPS = 6_700;
const FEED_SCALE_PURCHASES = 134_000;
const PURCHASES_PER_EP = 20;

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
    const { readDeliverySellersFeed, readDeliverySellersFeedSnapshot } = await import("@/lib/delivery/sellers-feed");
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

    const mcpAlignUrl = "https://feed-mcp-align.example/api";
    const mcpAlignId = await mkEp(mcpAlignUrl, { source: CATALOG_SOURCE, network: "eip155:8453" });
    const alignTx = SECRETS.tx_hash;
    await mkPurchase(mcpAlignId, { status: "settled", http: 200, payload: true, at: daysAgo(5) });
    await mkPurchase(mcpAlignId, { status: "settled", http: 500, payload: true, at: daysAgo(4), tx: true });
    await mkPurchase(mcpAlignId, { status: "settled", http: 404, payload: false, at: daysAgo(3), tx: true });
    await db.insert(schema.x402L1Purchases).values({
      endpointId: mcpAlignId,
      attemptedAt: daysAgo(2),
      status: "settle_failed",
      network: "eip155:8453",
      httpStatusPaid: 502,
      payloadNonEmpty: false,
      authNonce: SECRETS.nonce,
      payer: SECRETS.payer,
      payTo: SECRETS.pay_to,
      txHash: alignTx,
      amountUnits: "7000",
      spentUnits: "7000",
      asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      settlementVerified: true,
    });
    await mkPurchase(mcpAlignId, { status: "settled", http: 202, payload: true, at: daysAgo(1), tx: true });

    let body = await readDeliverySellersFeed(db, { network: null, minDelivered: null, listedIn: null, cursor: null });
    const mixed = body.rows.find((r) => r.url === mixedUrl);
    assert.ok(mixed, "mixed row");
    assert.equal(mixed.delivered_30d, 1);
    assert.equal(mixed.settled_not_delivered_30d, 1);
    assert.equal(mixed.paid_attempts_30d, 3);

    const align = body.rows.find((r) => r.url === mcpAlignUrl);
    assert.ok(align, "mcp align row");
    const { decide } = await import("@/lib/decision/decide");
    const { resolve } = await import("@/lib/resolve/lookup");
    const { decisionCache } = await import("@/lib/decision/cache");
    const { readL1Purchases } = await import("@/lib/mcp/reads");
    const { checkSeller } = await import("@/lib/mcp/tools");
    type McpDeps = import("@/lib/mcp/tools").McpDeps;
    const stubPage = {
      board: async () => null,
      detail: async () => null,
      purchasedHosts: async () => [] as string[],
      otherChains: async () => null,
    };
    const mcpDeps: McpDeps = {
      resolve,
      decide,
      l1Purchases: (id) => readL1Purchases(db, id),
      sellerPage: stubPage as unknown as McpDeps["sellerPage"],
      hostExtras: async () =>
        ({ fetchedAt: new Date().toISOString(), listings: [], purchases: [] }) as Awaited<ReturnType<McpDeps["hostExtras"]>>,
      findSellers: async () =>
        ({ fetchedAt: new Date().toISOString(), sellers: [], untested: [] }) as Awaited<ReturnType<McpDeps["findSellers"]>>,
    };
    decisionCache.clear();
    const mcpOut = await checkSeller(mcpDeps, { url: mcpAlignUrl });
    assert.equal(mcpOut.not_in_catalog, false);
    assert.ok(mcpOut.delivery);
    assert.equal(align!.delivered_30d, mcpOut.delivery!.delivered, "delivered vs check_x402_seller");
    assert.equal(align!.paid_attempts_30d, mcpOut.delivery!.paid_attempts, "paid_attempts vs check_x402_seller");
    assert.equal(align!.settled_not_delivered_30d, mcpOut.delivery!.settled_not_delivered, "settled_not_delivered vs check_x402_seller");

    assert.ok(!body.rows.some((r) => r.url === oldUrl));
    assert.ok(!body.rows.some((r) => r.url === inactiveUrl));
    assert.ok(!body.rows.some((r) => r.url === noPayUrl));

    const { DELIVERY_FEED_PUBLIC_ROW_KEYS } = await import("@/lib/delivery/sellers-feed");
    for (const row of body.rows) {
      assert.deepEqual(Object.keys(row).sort(), [...DELIVERY_FEED_PUBLIC_ROW_KEYS].sort(), "public row keys");
    }

    const blob = JSON.stringify(body);
    for (const k of ["nonce", "payer", "pay_to", "tx_hash"] as const) {
      assert.equal(blob.includes(SECRETS[k]), false, k);
    }

    body = await readDeliverySellersFeed(db, { network: "eip155:5042", minDelivered: null, listedIn: "circle", cursor: null });
    assert.deepEqual(
      body.rows.map((r) => r.url),
      [arcUrl],
    );

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);
    const t0 = performance.now();
    await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, source, method, network, pay_to, price_amount, price_asset, status, canonical_url, last_seen_at, declared_schema)
      SELECT 'host' || n || '.example/r' || n,
             'https://scale-host' || n || '.example/' || repeat('p', 60 + (n % 61)),
             CASE WHEN n % 3 = 0 THEN ${CIRCLE_DISCOVERY_SOURCE} WHEN n % 3 = 1 THEN 'mpp_directory' ELSE ${CATALOG_SOURCE} END,
             CASE WHEN n % 2 = 0 THEN 'POST' ELSE 'GET' END,
             'eip155:8453',
             ${SECRETS.pay_to},
             (1000 * (1 + n % 50))::text,
             '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
             'active',
             'https://scale-host' || n || '.example/' || repeat('p', 60 + (n % 61)),
             now(),
             '{"properties":{"input":{"type":"object"}}}'::jsonb
      FROM generate_series(1, ${FEED_SCALE_EPS}) n`);
    await db.execute(sql`
      WITH ids AS (
        SELECT id, row_number() OVER (ORDER BY id) AS rn FROM x402_endpoints ORDER BY id LIMIT ${FEED_SCALE_EPS}
      )
      INSERT INTO x402_l1_purchases (endpoint_id, attempted_at, status, network, http_status_paid, payload_non_empty, spent_units, amount_units, payer, pay_to, tx_hash, raw_response_meta, raw_settlement)
      SELECT ids.id,
             CASE WHEN p.i < 10
               THEN now() - (p.i + 1) * interval '1 day'
               ELSE now() - (31 + (p.i - 10)) * interval '1 day'
             END,
             'settled',
             'eip155:8453',
             200,
             true,
             '1000', '1000',
             ${SECRETS.payer},
             ${SECRETS.pay_to},
             ('0x' || lpad(to_hex((ids.rn - 1) * ${PURCHASES_PER_EP} + p.i + 1), 64, '0'))::text,
             jsonb_build_object('status', '200', 'contentType', 'application/json', 'requestBody', 'declared'),
             '{"success": true}'::jsonb
      FROM ids
      CROSS JOIN generate_series(0, ${PURCHASES_PER_EP - 1}) AS p(i)`);
    // 本番の表は autovacuum 済み。seed 直後の hint bit 書き込みで1回目が膨らまないよう、同じ状態にしてから測る。
    await db.execute(sql`VACUUM ANALYZE x402_endpoints`);
    await db.execute(sql`VACUUM ANALYZE x402_l1_purchases`);
    const seedMs = performance.now() - t0;

    const explain = await db.execute(sql`
      EXPLAIN (FORMAT TEXT)
      WITH active AS (
        SELECT e.id FROM x402_endpoints e
        WHERE e.status = 'active'
          AND EXISTS (
            SELECT 1 FROM x402_l1_purchases pu
            WHERE pu.endpoint_id = e.id AND pu.attempted_at > now() - interval '30 days' AND pu.status IN ('settled','settle_failed')
          )
      )
      SELECT 1 FROM active LIMIT 1`);
    const explainText = JSON.stringify(explain);
    console.log("scale_explain_snip", explainText.slice(0, 400));

    const { buildDeliveryFeedPayload, deliveryFeedSnapshotTiming } = await import("@/lib/delivery/sellers-feed");
    // 1回目（キャッシュの外れ・Neon の休止明けに当たる経路）も測って止める。
    const c0 = performance.now();
    await readDeliverySellersFeedSnapshot(db);
    const coldMs = performance.now() - c0;
    console.log("scale_cold_snapshot_ms", coldMs);
    assert.ok(coldMs < 30_000, `cold snapshot took ${coldMs}ms`);

    const heapBefore = process.memoryUsage().heapUsed;
    const q0 = performance.now();
    const snap = await readDeliverySellersFeedSnapshot(db);
    const snapshotMs = performance.now() - q0;
    const timing = deliveryFeedSnapshotTiming();
    assert.ok(timing, "snapshot timing");
    console.log("scale_window_sql_ms", timing!.windowSqlMs);
    console.log("scale_assemble_ms", timing!.assembleMs);
    const scale = buildDeliveryFeedPayload(snap, { network: null, minDelivered: null, listedIn: null, cursor: null });
    const heapAfter = process.memoryUsage().heapUsed;
    const bytes = Buffer.byteLength(JSON.stringify(scale), "utf8");
    const { DELIVERY_FEED_PAGE_SIZE } = await import("@/lib/delivery/sellers-feed");

    console.log("scale_seed_ms", seedMs);
    console.log("scale_snapshot_ms", snapshotMs);
    console.log("scale_heap_used", heapAfter - heapBefore);
    console.log("scale_bytes", bytes);
    console.log("scale_total_rows", scale.total_rows);
    console.log("scale_row_count", scale.row_count);

    assert.ok(snapshotMs < 5_000, `snapshot took ${snapshotMs}ms (window ${timing!.windowSqlMs}ms assemble ${timing!.assembleMs}ms)`);
    assert.equal(scale.total_rows, FEED_SCALE_EPS);
    assert.equal(scale.row_count, DELIVERY_FEED_PAGE_SIZE);
    assert.ok(scale.next_cursor);
    assert.ok(explainText.includes("Semi Join") || explainText.includes("Exist"), "EXPLAIN should use semi join or exists");

    const { resetDeliveryFeedCacheForTest } = await import("@/lib/delivery/sellers-feed-cache");
    resetDeliveryFeedCacheForTest();
    const seen = new Set<string>();
    let cursor: string | null = null;
    let totalRows = 0;
    for (;;) {
      const page = await readDeliverySellersFeed(db, { network: null, minDelivered: null, listedIn: null, cursor });
      if (totalRows === 0) totalRows = page.total_rows;
      for (const r of page.rows) {
        const key = `${r.url}\0${r.method}\0${r.network ?? ""}`;
        assert.ok(!seen.has(key), `duplicate feed row ${r.url}`);
        seen.add(key);
      }
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    assert.equal(seen.size, totalRows, "cursor walk covers total_rows without gaps or duplicates");
    assert.equal(totalRows, FEED_SCALE_EPS);
  });

  test("cache and cursor pagination", async () => {
    const schema = await import("@/lib/db/schema");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { readDeliverySellersFeedSnapshot, buildDeliveryFeedPayload } = await import("@/lib/delivery/sellers-feed");
    const {
      getDeliveryFeedSnapshotCached,
      resetDeliveryFeedCacheForTest,
      deliveryFeedDbReadCount,
      deliveryFeedExportSlotAcquireCount,
    } = await import("@/lib/delivery/sellers-feed-cache");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);
    resetDeliveryFeedCacheForTest();
    for (let i = 1; i <= 5; i++) {
      const url = `https://cursor-${i}.example/` + "p".repeat(60);
      await db.insert(schema.x402Endpoints).values({
        resourceKey: `cursor-${i}`,
        resourceUrl: url,
        canonicalUrl: url,
        source: "cdp_bazaar",
        method: "GET",
        network: "eip155:8453",
        payTo: "0x7777777777777777777777777777777777777777",
        priceAmount: "1000",
        priceAsset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        status: "active",
        lastSeenAt: new Date(),
      });
    }
    const eps = await db.execute(sql`SELECT id, resource_url FROM x402_endpoints ORDER BY resource_url`);
    for (const r of (Array.isArray(eps) ? eps : eps.rows) as { id: string; resource_url: string }[]) {
      await db.insert(schema.x402L1Purchases).values({
        endpointId: r.id,
        attemptedAt: new Date(),
        status: "settled",
        network: "eip155:8453",
        httpStatusPaid: 200,
        payloadNonEmpty: true,
        spentUnits: "1000",
        amountUnits: "1000",
      });
    }
    await Promise.all([
      getDeliveryFeedSnapshotCached(db),
      getDeliveryFeedSnapshotCached(db),
      getDeliveryFeedSnapshotCached(db),
    ]);
    assert.equal(deliveryFeedDbReadCount(), 1);
    assert.equal(deliveryFeedExportSlotAcquireCount(), 1);

    const snap = await readDeliverySellersFeedSnapshot(db);
    assert.equal(snap.rows.length, 5);
    const p1 = buildDeliveryFeedPayload(snap, { network: null, minDelivered: null, listedIn: null, cursor: null });
    assert.equal(p1.row_count, 5);
    assert.equal(p1.total_rows, 5);
    assert.equal(p1.next_cursor, null);

    const { paginateDeliveryFeedRows } = await import("@/lib/delivery/sellers-feed");
    const { decodeFeedCursor } = await import("@/lib/delivery/sellers-feed-query");
    const page1 = paginateDeliveryFeedRows(snap.rows, null, 2);
    assert.equal(page1.page.length, 2);
    assert.ok(page1.next_cursor);
    const cur = decodeFeedCursor(page1.next_cursor!);
    assert.notEqual(cur, "invalid");
    const page2 = paginateDeliveryFeedRows(snap.rows, cur === "invalid" ? null : cur, 2);
    assert.equal(page2.page.length, 2);
    let walked = [...page1.page, ...page2.page];
    let cursor = page2.next_cursor;
    while (cursor) {
      const c = decodeFeedCursor(cursor);
      const next = paginateDeliveryFeedRows(snap.rows, c === "invalid" ? null : c, 2);
      walked = walked.concat(next.page);
      cursor = next.next_cursor;
    }
    assert.equal(walked.length, 5);
  });

  test("export busy returns stale snapshot with old as_of", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const schema = await import("@/lib/db/schema");
    const { acquireExportSlot } = await import("@/lib/api/export-guard");
    const {
      getDeliveryFeedSnapshotCached,
      resetDeliveryFeedCacheForTest,
      seedDeliveryFeedCacheForTest,
      DELIVERY_FEED_CACHE_MS,
    } = await import("@/lib/delivery/sellers-feed-cache");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, ip_rate_limits`);
    resetDeliveryFeedCacheForTest();
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "stale-feed.example/",
        resourceUrl: "https://stale-feed.example/",
        canonicalUrl: "https://stale-feed.example/",
        network: "eip155:8453",
        method: "GET",
        payTo: "0xcccccccccccccccccccccccccccccccccccccccc",
        status: "active",
      })
      .returning();
    await db.insert(schema.x402L1Purchases).values({
      endpointId: ep.id,
      attemptedAt: new Date(),
      status: "settled",
      network: "eip155:8453",
      httpStatusPaid: 200,
      payloadNonEmpty: true,
      spentUnits: "1000",
      amountUnits: "1000",
    });

    const first = await getDeliveryFeedSnapshotCached(db);
    seedDeliveryFeedCacheForTest(first, DELIVERY_FEED_CACHE_MS + 5_000);

    const slot = await acquireExportSlot();
    assert.ok(slot.ok);
    try {
      const second = await getDeliveryFeedSnapshotCached(db);
      assert.equal(second.as_of, first.as_of);
      assert.equal(second.rows.length, first.rows.length);
    } finally {
      await slot.release();
      resetDeliveryFeedCacheForTest();
    }
  });
}
