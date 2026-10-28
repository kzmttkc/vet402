// ============================================================
// フィード経路: 窓内の署名行は sellerView が null にならない（2026-10-28 点検 3 回目）。
//
// Run: TEST_DATABASE_URL=postgres://takeshi@localhost:5432/vet402_test_feed \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/delivery-feed-seller-view.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("delivery feed sellerView (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("feed window path: every signed row has non-null sellerView", async () => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { SIGNED_STATUSES } = await import("@/lib/decision/seller-facts");
    const { deliveryFeedWindowPurchaseInputs } = await import("@/lib/delivery/sellers-feed");
    const db = getDb()!;

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "sellerview.example/api",
        resourceUrl: "https://sellerview.example/api",
        canonicalUrl: "https://sellerview.example/api",
        network: "eip155:8453",
        method: "POST",
        payTo: "0x7777777777777777777777777777777777777777",
        payeeId: "eip155:8453:0x7777777777777777777777777777777777777777",
        status: "active",
        declaredSchema: { properties: { input: { properties: { body: { type: "object" } } } } },
      })
      .returning();

    await db.insert(schema.x402L1Purchases).values({
      endpointId: ep.id,
      attemptedAt: new Date(Date.now() - 86_400_000),
      status: "settled",
      network: "eip155:8453",
      httpStatusPaid: 200,
      payloadNonEmpty: true,
      txHash: "0x" + "ab".repeat(32),
      amountUnits: "7000",
      spentUnits: "7000",
      payer: "0x8888888888888888888888888888888888888888",
      payTo: "0x7777777777777777777777777777777777777777",
    });

    const byEp = await deliveryFeedWindowPurchaseInputs(db);
    const purchases = byEp.get(ep.id) ?? [];
    assert.ok(purchases.length >= 1);
    for (const p of purchases) {
      if (!SIGNED_STATUSES.has(p.status)) continue;
      assert.notEqual(p.sellerView, null, `sellerView null for ${p.status} at ${p.attemptedAt}`);
    }
  });
}
