// ============================================================
// S1-1: seller_fixable_input — Postgres で購入行を挿し、reader が読む meta から分類が一致すること。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/s1-1-seller-fixable-input.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
const PYDANTIC = `{"detail":[{"type":"missing","loc":["body","query"],"msg":"Field required","input":{}}]}`;

if (!TEST_DB) {
  test("s1-1 seller fixable input (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("seller_fixable_input: insert → readRecordSides → seller_fixable_input", async () => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { heldReasonOf } = await import("@/lib/observatory/delivery");
    const { readRecordSides } = await import("@/lib/sellers/reader");
    const { recordRowKey } = await import("@/lib/sellers/board");
    const db = getDb()!;

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);

    const BODY_SCHEMA = { properties: { input: { properties: { body: { type: "object" } } } } };
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "s1-1.fix/a",
        resourceUrl: "https://s1-1.fix/a",
        network: "eip155:8453",
        method: "POST",
        status: "active",
        declaredSchema: BODY_SCHEMA,
        declaredInput: { query: "empty", body: "declared" },
        priceAmount: "1000",
      })
      .returning();

    const at = "2026-09-20T12:00:00Z";
    const tx = `0x${"cd".repeat(32)}`;
    await db.insert(schema.x402L1Purchases).values({
      endpointId: ep.id,
      status: "settled",
      httpStatusPaid: 400,
      txHash: tx,
      attemptedAt: new Date(at),
      network: "eip155:8453",
      rawResponseMeta: {
        requestBody: "declared",
        requestBodySha256: "d".repeat(64),
        requestQuery: "empty",
        bodyHead: PYDANTIC,
      },
      spentUnits: "10000",
      amountUnits: "10000",
      payTo: `0x${"22".repeat(20)}`,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payer: "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670",
    });

    const held = heldReasonOf({
      status: "settled",
      httpStatusPaid: 400,
      txHash: tx,
      attemptedAt: at,
      network: "eip155:8453",
    });
    assert.equal(held, "settled_4xx");

    const sides = await readRecordSides(db, ep.id);
    const key = recordRowKey(at, "settled", tx);
    const shown = sides.rows.get(key);
    assert.ok(shown, "reader must return the purchase row");
    assert.equal(shown.mode?.key, "seller_fixable_input");
    assert.equal(shown.bucket, "seller");
    assert.equal(shown.held, "settled_4xx");
  });
}
