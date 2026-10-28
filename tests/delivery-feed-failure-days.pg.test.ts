// ============================================================
// 窓内行 + readSellerFailureDays が readRecordSidesBatch と同じ 3 件数を返す（2026-10-28 点検）。
//
// Run: TEST_DATABASE_URL=postgres://takeshi@localhost:5432/vet402_test_feed \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/delivery-feed-failure-days.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("delivery feed failure days (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("window sides + readSellerFailureDays matches readRecordSidesBatch counts", async () => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { fetchL1WindowPurchaseRows, purchaseInputFromL1WindowRow } = await import("@/lib/decision/l1-window-purchases");
    const { l1CountsOf } = await import("@/lib/decision/seller-facts");
    const { buildRecordSides } = await import("@/lib/sellers/board");
    const { readRecordSidesBatch, readSellerFailureDays, toRowFacts } = await import("@/lib/sellers/reader");
    const db = getDb()!;

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);

    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "failure-days.example/api",
        resourceUrl: "https://failure-days.example/api",
        canonicalUrl: "https://failure-days.example/api",
        network: "eip155:8453",
        method: "GET",
        payTo: "0x1111111111111111111111111111111111111111",
        payeeId: "eip155:8453:0x1111111111111111111111111111111111111111",
        status: "active",
      })
      .returning();

    let txSeq = 0;
    const tx = () => `0x${(++txSeq).toString(16).padStart(64, "0")}`;
    const day = (d: number) => new Date(Date.now() - d * 86_400_000);

    // 売り手の側（確定）候補: 窓内 2 日 + 窓外 1 日（readSellerFailureDays が拾う）。
    await db.insert(schema.x402L1Purchases).values([
      { endpointId: ep.id, attemptedAt: day(35), status: "settled", network: "eip155:8453", httpStatusPaid: 500, payloadNonEmpty: true, txHash: tx(), amountUnits: "1000", spentUnits: "1000" },
      { endpointId: ep.id, attemptedAt: day(10), status: "settled", network: "eip155:8453", httpStatusPaid: 500, payloadNonEmpty: true, txHash: tx(), amountUnits: "1000", spentUnits: "1000" },
      { endpointId: ep.id, attemptedAt: day(9), status: "settled", network: "eip155:8453", httpStatusPaid: 500, payloadNonEmpty: true, txHash: tx(), amountUnits: "1000", spentUnits: "1000" },
      { endpointId: ep.id, attemptedAt: day(2), status: "settled", network: "eip155:8453", httpStatusPaid: 200, payloadNonEmpty: true, txHash: tx(), amountUnits: "1000", spentUnits: "1000" },
    ]);

    const windowRows = await fetchL1WindowPurchaseRows(db, ep.id);
    const windowFacts = windowRows.map((r) => toRowFacts(r));
    const failureDays = await readSellerFailureDays(db, [ep.id]);
    const windowSides = buildRecordSides(windowFacts, Date.now(), failureDays);

    const batchSides = (await readRecordSidesBatch(db, [ep.id])).get(ep.id)!;

    const endpointMeta = { declaredSchema: ep.declaredSchema ?? null, method: ep.method, declaredInput: ep.declaredInput ?? null };
    const fromWindow = l1CountsOf(
      windowRows.map((r) => purchaseInputFromL1WindowRow(r, windowSides)),
      endpointMeta,
    );
    const fromBatch = l1CountsOf(
      windowRows.map((r) => purchaseInputFromL1WindowRow(r, batchSides)),
      endpointMeta,
    );
    assert.deepEqual(fromWindow, fromBatch);
    assert.equal(fromWindow.delivered, 1);
    assert.equal(fromWindow.paid_attempts, 3);
    assert.equal(fromWindow.settled_not_delivered, 2);
  });
}
