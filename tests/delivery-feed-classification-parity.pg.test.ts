// ============================================================
// フィード窓 SQL の分類表と readRecordSides の一致（2026-10-28 点検 3 回目・(d)）。
//
// Run: TEST_DATABASE_URL=postgres://takeshi@localhost:5432/vet402_test_feed \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/delivery-feed-classification-parity.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";
import { recordRowKey } from "@/lib/sellers/board";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("delivery feed classification parity (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("feed window sides match readRecordSides for every window key", async () => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { deliveryFeedWindowRecordSides } = await import("@/lib/delivery/sellers-feed");
    const { fetchL1WindowPurchaseRows } = await import("@/lib/decision/l1-window-purchases");
    const { readRecordSides } = await import("@/lib/sellers/reader");
    const db = getDb()!;

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "classify-parity.example/api",
        resourceUrl: "https://classify-parity.example/api",
        canonicalUrl: "https://classify-parity.example/api",
        network: "eip155:8453",
        method: "POST",
        payTo: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        payeeId: "eip155:8453:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "active",
        declaredSchema: { properties: { input: { properties: { body: { type: "object" } } } } },
      })
      .returning();

    const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
    await db.insert(schema.x402L1Purchases).values([
      {
        endpointId: ep.id,
        attemptedAt: new Date(Date.now() - 86_400_000),
        status: "settled",
        network: "eip155:8453",
        httpStatusPaid: 401,
        payloadNonEmpty: false,
        txHash: tx(1),
        amountUnits: "7000",
        spentUnits: "7000",
        payer: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        payTo: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        rawResponseMeta: { requestBody: "declared", requestQuery: "a=1", status: "401" },
        rawSettlement: { success: true, errorReason: null },
        settlementVerifyReason: "matched",
      },
      {
        endpointId: ep.id,
        attemptedAt: new Date(Date.now() - 2 * 86_400_000),
        status: "settled",
        network: "eip155:8453",
        httpStatusPaid: 200,
        payloadNonEmpty: true,
        txHash: tx(2),
        amountUnits: "7000",
        spentUnits: "7000",
        payer: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        payTo: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    ]);

    const windowRows = await fetchL1WindowPurchaseRows(db, ep.id);
    const feedSides = await deliveryFeedWindowRecordSides(db, ep.id);
    const recordSides = await readRecordSides(db, ep.id);

    for (const r of windowRows) {
      const key = recordRowKey(
        String(r.attempted_at_utc),
        String(r.status),
        r.tx_hash === null || r.tx_hash === undefined ? null : String(r.tx_hash),
      );
      const fromFeed = feedSides.rows.get(key);
      const fromRecord = recordSides.rows.get(key);
      assert.ok(fromFeed, `feed missing key ${key}`);
      assert.ok(fromRecord, `readRecordSides missing key ${key}`);
      assert.equal(fromFeed!.bucket, fromRecord!.bucket, `bucket ${key}`);
      assert.equal(fromFeed!.held, fromRecord!.held, `held ${key}`);
      assert.equal(fromFeed!.money, fromRecord!.money, `money ${key}`);
      assert.equal(fromFeed!.bucket === "delivered", fromRecord!.bucket === "delivered", `delivered ${key}`);
    }
  });
}
