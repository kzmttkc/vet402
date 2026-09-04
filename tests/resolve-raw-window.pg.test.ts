// ============================================================
// 2026-09-04 W15: 生行を 7 日で畳むので、/resolve?q={tx} は 7 日より古い
// 取引を引けなくなる。「そんな決済は索引していない」と「持っていたが
// 窓の外に出た」は別のことなので、空の応答で同じに見せない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("resolve raw window (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("resolve: tx が引けないとき、生行の窓を理由として返す", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { resolve } = await import("@/lib/resolve/lookup");
    const { RAW_RETENTION_DAYS } = await import("@/lib/settlements/rollup");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE settlements, settlement_daily`);

    const known = `0x${"a".repeat(64)}`;
    const gone = `0x${"b".repeat(64)}`;
    await db.execute(sql`
      INSERT INTO settlements (chain, tx_hash, purchase_id, asset, amount, payer, payee, payer_id, payee_id,
                               observed_at, block_time, attribution, wash_flag, source)
      VALUES ('eip155:8453', ${known}, ${`eip155:8453:${known}`}, '0xasset', '1000', '0xp', '0xq',
              'payer1', 'payee1', now(), now(), 'confirmed', 'none', 'chain_index')
    `);

    await t.test("索引にある tx は今まで通り settlement を返し、理由は付かない", async () => {
      const r = await resolve(known);
      assert.equal(r.query.kind, "tx");
      assert.equal(r.settlement?.tx_hash, known);
      assert.equal(r.settlement_not_found, undefined);
    });

    await t.test("引けない tx には、7 日の生行窓の外である可能性を明示して返す", async () => {
      const r = await resolve(gone);
      assert.equal(r.query.kind, "tx");
      assert.equal(r.settlement, undefined);
      assert.equal(r.settlement_not_found?.reason, "not_in_raw_window");
      assert.equal(r.settlement_not_found?.raw_window_days, RAW_RETENTION_DAYS);
      assert.match(
        r.settlement_not_found?.note ?? "",
        /older than the .*-day raw window/,
        "「窓の外」だと機械にも人にも読める文であること",
      );
    });

    await db.execute(sql`TRUNCATE settlements, settlement_daily`);
  });
}
