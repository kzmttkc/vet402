// ============================================================
// 配達フィードと check_x402_seller の delivery 件数（2026-10-28 点検残り 1）。
//
// Run: TEST_DATABASE_URL=postgres://takeshi@localhost:5432/vet402_test_feed \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/delivery-feed-mcp-parity.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

type Counts = { delivered: number; paid: number; undelivered: number };

if (!TEST_DB) {
  test("delivery feed vs check_x402_seller (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;
  process.env.PROXY_HEADER_SOURCE = "generic";

  test("feed delivery counts match checkSeller for five fixtures", async (t) => {
    const schema = await import("@/lib/db/schema");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { canonicalUrl, endpointHash, resourceId } = await import("@/lib/ids/canonical");
    const { decide } = await import("@/lib/decision/decide");
    const { resolve } = await import("@/lib/resolve/lookup");
    const { decisionCache } = await import("@/lib/decision/cache");
    const { readL1Purchases } = await import("@/lib/mcp/reads");
    const { checkSeller } = await import("@/lib/mcp/tools");
    type McpDeps = import("@/lib/mcp/tools").McpDeps;
    const { buildDeliveryFeedPayload, readDeliverySellersFeedSnapshot } = await import("@/lib/delivery/sellers-feed");
    const { resetDeliveryFeedCacheForTest } = await import("@/lib/delivery/sellers-feed-cache");
    const { CATALOG_SOURCE } = await import("@/lib/observatory/catalog-source");
    const db = getDb()!;

    const PAY_TO = "0x7777777777777777777777777777777777777777";
    const PAYER = "0x8888888888888888888888888888888888888888";
    const ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

    const stubPage = {
      board: async () => null,
      detail: async () => null,
      purchasedHosts: async () => [] as string[],
      otherChains: async () => null,
    };
    const stubExtras = async () =>
      ({ fetchedAt: new Date().toISOString(), listings: [], purchases: [] }) as Awaited<ReturnType<McpDeps["hostExtras"]>>;
    const stubFind = async () => ({ fetchedAt: new Date().toISOString(), sellers: [], untested: [] });

    function deps(now?: Date): McpDeps {
      return {
        resolve,
        decide,
        l1Purchases: (id) => readL1Purchases(db, id),
        sellerPage: stubPage as unknown as McpDeps["sellerPage"],
        hostExtras: stubExtras as McpDeps["hostExtras"],
        findSellers: stubFind as McpDeps["findSellers"],
        now: now ? () => now : undefined,
      };
    }

    async function mkEp(url: string) {
      const c = canonicalUrl(url)!;
      const method = "GET";
      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: `${new URL(c.url).host}${new URL(c.url).pathname}`.toLowerCase(),
          resourceUrl: url,
          canonicalUrl: c.url,
          resourceId: resourceId(method, c.url),
          endpointHash: endpointHash(c.url),
          source: CATALOG_SOURCE,
          method,
          network: "eip155:8453",
          payTo: PAY_TO,
          priceAmount: "7000",
          priceAsset: ASSET,
          status: "active",
          payeeId: `eip155:8453:${PAY_TO}`,
          lastSeenAt: new Date(),
        })
        .returning();
      return ep;
    }

    let txSeq = 0;
    const nextTx = () => `0x${(++txSeq).toString(16).padStart(64, "0")}`;

    async function compare(url: string, now?: Date): Promise<{ feed: Counts; mcp: Counts }> {
      decisionCache.clear();
      resetDeliveryFeedCacheForTest();
      const snap = await readDeliverySellersFeedSnapshot(db);
      const payload = buildDeliveryFeedPayload(snap, {
        network: null,
        minDelivered: null,
        listedIn: null,
        cursor: null,
      });
      const row = payload.rows.find((r) => r.url === url);
      assert.ok(row, `feed row ${url}`);
      const out = await checkSeller(deps(now), { url });
      assert.equal(out.not_in_catalog, false, url);
      assert.ok(out.delivery, url);
      const feed: Counts = {
        delivered: row.delivered_30d,
        paid: row.paid_attempts_30d,
        undelivered: row.settled_not_delivered_30d,
      };
      const mcp: Counts = {
        delivered: out.delivery!.delivered,
        paid: out.delivery!.paid_attempts,
        undelivered: out.delivery!.settled_not_delivered,
      };
      assert.deepEqual(feed, mcp, url);
      console.log("parity", url, "feed", feed, "mcp", mcp);
      return { feed, mcp };
    }

    await t.test("(a) 205 rows in window with unsigned mixed (200 cap)", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);
      const url = "https://parity-205.example/api";
      const ep = await mkEp(url);
      const base = Date.now();
      const rows: { at: Date; status: string; http: number | null; payload: boolean | null; tx: string | null }[] = [];
      for (let i = 0; i < 205; i++) {
        const at = new Date(base - i * 60_000);
        if (i < 3) rows.push({ at, status: "settled", http: 200, payload: true, tx: nextTx() });
        else if (i >= 200) rows.push({ at, status: "settled", http: 404, payload: false, tx: nextTx() });
        else rows.push({ at, status: "no_402", http: null, payload: null, tx: null });
      }
      for (const r of rows) {
        await db.insert(schema.x402L1Purchases).values({
          endpointId: ep.id,
          attemptedAt: r.at,
          status: r.status,
          network: "eip155:8453",
          httpStatusPaid: r.http,
          payloadNonEmpty: r.payload,
          payer: PAYER,
          payTo: PAY_TO,
          txHash: r.tx,
          amountUnits: "7000",
          spentUnits: r.status === "no_402" ? "0" : "7000",
          asset: ASSET,
        });
      }
      const { feed, mcp } = await compare(url);
      assert.equal(feed.paid, 3);
      assert.equal(feed.delivered, 3);
      assert.equal(mcp.undelivered, 0);
    });

    await t.test("(b) 29.99d inside and 30.01d outside window", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);
      const url = "https://parity-window-edge.example/api";
      const ep = await mkEp(url);
      const now = Date.now();
      const inside = new Date(now - 29.99 * 86_400_000);
      const outside = new Date(now - 30.01 * 86_400_000);
      for (const [at] of [
        [inside, "in"],
        [outside, "out"],
      ] as const) {
        await db.insert(schema.x402L1Purchases).values({
          endpointId: ep.id,
          attemptedAt: at,
          status: "settled",
          network: "eip155:8453",
          httpStatusPaid: 200,
          payloadNonEmpty: true,
          payer: PAYER,
          payTo: PAY_TO,
          txHash: nextTx(),
          amountUnits: "7000",
          spentUnits: "7000",
          asset: ASSET,
        });
      }
      const { feed } = await compare(url);
      assert.equal(feed.paid, 1);
      assert.equal(feed.delivered, 1);
    });

    await t.test("(c) meta request_meta receipt verify_reason", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);
      const url = "https://parity-meta.example/api";
      const ep = await mkEp(url);
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id,
        attemptedAt: new Date(Date.now() - 86_400_000),
        status: "settled",
        network: "eip155:8453",
        httpStatusPaid: 401,
        payloadNonEmpty: false,
        payer: PAYER,
        payTo: PAY_TO,
        txHash: nextTx(),
        amountUnits: "7000",
        spentUnits: "7000",
        asset: ASSET,
        rawResponseMeta: { requestBody: "declared", requestQuery: "a=1", status: "401" },
        rawSettlement: { success: true, errorReason: null },
        settlementVerifyReason: "matched",
      });
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id,
        attemptedAt: new Date(Date.now() - 2 * 86_400_000),
        status: "settled",
        network: "eip155:8453",
        httpStatusPaid: 200,
        payloadNonEmpty: true,
        payer: PAYER,
        payTo: PAY_TO,
        txHash: nextTx(),
        amountUnits: "7000",
        spentUnits: "7000",
        asset: ASSET,
      });
      await compare(url);
    });

    await t.test("(d) meta fixture: readRecordSidesBatch rows match readRecordSides and feed vs checkSeller", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);
      const url = "https://parity-meta.example/api";
      const ep = await mkEp(url);
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id,
        attemptedAt: new Date(Date.now() - 86_400_000),
        status: "settled",
        network: "eip155:8453",
        httpStatusPaid: 401,
        payloadNonEmpty: false,
        payer: PAYER,
        payTo: PAY_TO,
        txHash: nextTx(),
        amountUnits: "7000",
        spentUnits: "7000",
        asset: ASSET,
        rawResponseMeta: { requestBody: "declared", requestQuery: "a=1", status: "401" },
        rawSettlement: { success: true, errorReason: null },
        settlementVerifyReason: "matched",
      });
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id,
        attemptedAt: new Date(Date.now() - 2 * 86_400_000),
        status: "settled",
        network: "eip155:8453",
        httpStatusPaid: 200,
        payloadNonEmpty: true,
        payer: PAYER,
        payTo: PAY_TO,
        txHash: nextTx(),
        amountUnits: "7000",
        spentUnits: "7000",
        asset: ASSET,
      });
      const { readRecordSides, readRecordSidesBatch } = await import("@/lib/sellers/reader");
      const batch = (await readRecordSidesBatch(db, [ep.id])).get(ep.id)!;
      const single = await readRecordSides(db, ep.id);
      assert.equal(batch.rows.size, single.rows.size);
      for (const [k, v] of batch.rows) {
        assert.deepEqual(v, single.rows.get(k), k);
      }
      await compare(url);
    });

    await t.test("(e) unsigned settled 4xx held and tx settle_failed mixed", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);
      const url = "https://parity-mix.example/api";
      const ep = await mkEp(url);
      const day = (d: number) => new Date(Date.now() - d * 86_400_000);
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id,
        attemptedAt: day(5),
        status: "no_402",
        network: "eip155:8453",
        payer: PAYER,
        payTo: PAY_TO,
        amountUnits: "7000",
        spentUnits: "0",
        asset: ASSET,
      });
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id,
        attemptedAt: day(4),
        status: "settled",
        network: "eip155:8453",
        httpStatusPaid: 404,
        payloadNonEmpty: false,
        payer: PAYER,
        payTo: PAY_TO,
        txHash: nextTx(),
        amountUnits: "7000",
        spentUnits: "7000",
        asset: ASSET,
      });
      const failTx = nextTx();
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id,
        attemptedAt: day(3),
        status: "settle_failed",
        network: "eip155:8453",
        httpStatusPaid: 502,
        payloadNonEmpty: false,
        payer: PAYER,
        payTo: PAY_TO,
        txHash: failTx,
        amountUnits: "7000",
        spentUnits: "7000",
        asset: ASSET,
        settlementVerified: true,
      });
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id,
        attemptedAt: day(1),
        status: "settled",
        network: "eip155:8453",
        httpStatusPaid: 200,
        payloadNonEmpty: true,
        payer: PAYER,
        payTo: PAY_TO,
        txHash: nextTx(),
        amountUnits: "7000",
        spentUnits: "7000",
        asset: ASSET,
      });
      await compare(url);
    });
  });
}
