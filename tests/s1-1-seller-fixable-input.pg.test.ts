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

  async function seedFixableRow(at: string, tx: string, bodyHead: string = PYDANTIC) {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    // 再実行できるように、各テストの最初に台帳を空にする（ガードはこのファイルの先頭で通っている）。
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);

    const BODY_SCHEMA = { properties: { input: { properties: { body: { type: "object" } } } } };
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: `s1-1.fix/${tx.slice(2, 6)}`,
        resourceUrl: `https://s1-1.fix/${tx.slice(2, 6)}`,
        network: "eip155:8453",
        method: "POST",
        status: "active",
        declaredSchema: BODY_SCHEMA,
        declaredInput: { query: "empty", body: "declared" },
        priceAmount: "1000",
      })
      .returning();

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
        bodyHead,
      },
      spentUnits: "10000",
      amountUnits: "10000",
      payTo: `0x${"22".repeat(20)}`,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payer: "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670",
    });

    return { db, epId: ep.id };
  }

  test("seller_fixable_input: one UTC day → seller_fixable_input_once on unsorted", async () => {
    const { heldReasonOf } = await import("@/lib/observatory/delivery");
    const { readRecordSides } = await import("@/lib/sellers/reader");
    const { recordRowKey } = await import("@/lib/sellers/board");

    const at = "2026-09-20T12:00:00Z";
    const tx = `0x${"cd".repeat(32)}`;
    const { db, epId } = await seedFixableRow(at, tx);

    const held = heldReasonOf({
      status: "settled",
      httpStatusPaid: 400,
      txHash: tx,
      attemptedAt: at,
      network: "eip155:8453",
    });
    assert.equal(held, "settled_4xx");

    const sides = await readRecordSides(db, epId);
    const key = recordRowKey(at, "settled", tx);
    const shown = sides.rows.get(key);
    assert.ok(shown, "reader must return the purchase row");
    assert.equal(shown.mode?.key, "seller_fixable_input_once");
    assert.equal(shown.bucket, "unsorted");
    assert.equal(shown.confirmedSeller, false);
    assert.equal(shown.held, "settled_4xx");
  });

  test("seller_fixable_input: two UTC days on one listing → seller_fixable_input on seller", async () => {
    const { readRecordSides } = await import("@/lib/sellers/reader");
    const { recordRowKey } = await import("@/lib/sellers/board");

    const tx1 = `0x${"e1".repeat(32)}`;
    const tx2 = `0x${"e2".repeat(32)}`;
    const { db, epId } = await seedFixableRow("2026-09-20T12:00:00Z", tx1);
    const schema = await import("@/lib/db/schema");
    await db.insert(schema.x402L1Purchases).values({
      endpointId: epId,
      status: "settled",
      httpStatusPaid: 422,
      txHash: tx2,
      attemptedAt: new Date("2026-09-21T15:00:00Z"),
      network: "eip155:8453",
      rawResponseMeta: {
        requestBody: "declared",
        requestBodySha256: "e".repeat(64),
        requestQuery: "empty",
        bodyHead: PYDANTIC,
      },
      spentUnits: "10000",
      amountUnits: "10000",
      payTo: `0x${"22".repeat(20)}`,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payer: "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670",
    });

    const sides = await readRecordSides(db, epId);
    const row2 = sides.rows.get(recordRowKey("2026-09-21T15:00:00Z", "settled", tx2));
    assert.ok(row2, "second-day row must appear");
    assert.equal(row2.mode?.key, "seller_fixable_input");
    assert.equal(row2.bucket, "seller");
    assert.equal(row2.confirmedSeller, true);
  });

  test("seller_fixable_input: the reader cuts bodyHead at 500 characters, so a longer stored answer stays held", async () => {
    const { readRecordSides } = await import("@/lib/sellers/reader");
    const { recordRowKey } = await import("@/lib/sellers/board");

    const items = Array.from({ length: 12 }, (_, i) => `{"type":"missing","loc":["body","field_${i}"],"msg":"Field required","input":{}}`);
    const long = `{"detail":[${items.join(",")}]}`;
    assert.ok(long.length > 500);
    JSON.parse(long);
    const at = "2026-09-22T12:00:00Z";
    const tx = `0x${"f3".repeat(32)}`;
    const { db, epId } = await seedFixableRow(at, tx, long);

    const sides = await readRecordSides(db, epId);
    const shown = sides.rows.get(recordRowKey(at, "settled", tx));
    assert.ok(shown, "reader must return the purchase row");
    assert.equal(shown.mode?.key, "settled_then_rejected");
    assert.notEqual(shown.bucket, "seller");
    assert.equal(shown.held, "settled_4xx");
  });
}
