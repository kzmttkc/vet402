// 公開一覧の backfill 後、settlement_30d の real が減り measurement が増える。
// TEST_DATABASE_URL が無いときは skip。settlements と settlement_daily を TRUNCATE する。
// 本番（Neon）は assertTestDatabaseIsNotProduction が拒否する。このセッションでは実行しない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("measurement payer backfill (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("measurement payer backfill", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { getSettlementCounts } = await import("@/lib/settlements/census");
    const { reclassifyMeasurementPayers } = await import("@/lib/settlements/reclassify-measurement");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE settlements, settlement_daily`);

    const cross = "eip155:8453:0x8d2a47cbd262e1bc5ee0645c81899f9896957d37";
    const mizan = "eip155:8453:0xe3badbd4f38214b9eae528a1a5398f6678f63fb3";
    const nodePayer = "eip155:8453:0x7dd81398fac7de0bf843bfd874cbea68face17d2";
    const vet = "eip155:8453:0x0000000000000000000000000000000000000abc";
    const payee = "eip155:8453:0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";
    const day = sql`(now() at time zone 'utc')::date`;

    await db.execute(sql`
      INSERT INTO settlements (chain, tx_hash, purchase_id, payer_id, payee_id, block_time, attribution, wash_flag, source)
      VALUES
        ('eip155:8453', '0xmeasnone', 'meas:cross-none', ${cross}, ${payee}, now(), 'unmatched', 'none', 'chain_index'),
        ('eip155:8453', '0xmeascirc', 'meas:mizan-circ', ${mizan}, ${payee}, now(), 'unmatched', 'circular', 'chain_index'),
        ('eip155:8453', '0xmeasnode', 'meas:node-none', ${nodePayer}, ${payee}, now(), 'unmatched', 'none', 'chain_index'),
        ('eip155:8453', '0xmeasvet', 'meas:vet-test', ${vet}, ${payee}, now(), 'confirmed', 'test', 'l1_purchase')
    `);
    await db.execute(sql`
      INSERT INTO settlement_daily (day, chain, payee_id, payer_id, wash_flag, source, attribution, n, amount_sum)
      VALUES
        (${day}, 'eip155:8453', ${payee}, ${cross}, 'none', 'chain_index', 'unmatched', 4, 40),
        (${day}, 'eip155:8453', ${payee}, ${cross}, 'measurement', 'chain_index', 'unmatched', 1, 10),
        (${day}, 'eip155:8453', ${payee}, ${cross}, 'test', 'chain_index', 'confirmed', 3, 30),
        (${day}, 'eip155:8453', ${payee}, ${nodePayer}, 'none', 'chain_index', 'unmatched', 2, 20)
    `);

    const before = await getSettlementCounts({ payeeId: payee }, 30);
    assert.deepEqual(before, { raw: 14, real: 8, test: 4, measurement: 1, uniquePayersReal: 2 });

    const dry = await reclassifyMeasurementPayers(db, { apply: false });
    assert.equal(dry.settlementsToMove, 2);
    assert.equal(dry.dailyRowsToMove, 1);
    assert.equal(dry.dailyPaymentsToMove, 4);
    assert.equal(dry.settlementsMoved, 0);
    assert.deepEqual(await getSettlementCounts({ payeeId: payee }, 30), before);

    const applied = await reclassifyMeasurementPayers(db, { apply: true });
    assert.equal(applied.settlementsMoved, 2);
    assert.equal(applied.dailyRowsMoved, 1);
    assert.deepEqual(await getSettlementCounts({ payeeId: payee }, 30), {
      raw: 14,
      real: 3,
      test: 4,
      measurement: 7,
      uniquePayersReal: 1,
    });

    const flags = (await db.execute(sql`
      SELECT payer_id, wash_flag FROM settlements ORDER BY payer_id, wash_flag
    `)) as unknown;
    const rows = (Array.isArray(flags) ? flags : (flags as { rows?: { payer_id: string; wash_flag: string }[] }).rows) ?? [];
    const byPayer = new Map(rows.map((r) => [r.payer_id, r.wash_flag]));
    assert.equal(byPayer.get(cross), "measurement");
    assert.equal(byPayer.get(mizan), "measurement");
    assert.equal(byPayer.get(nodePayer), "none");
    assert.equal(byPayer.get(vet), "test");

    const daily = (await db.execute(sql`
      SELECT payer_id, wash_flag, n::int AS n, amount_sum::int AS amount
      FROM settlement_daily
      WHERE payer_id = ${cross} AND wash_flag = 'measurement'
    `)) as unknown;
    const dailyRows = (Array.isArray(daily) ? daily : (daily as { rows?: { n: number; amount: number }[] }).rows) ?? [];
    assert.equal(dailyRows.length, 1);
    assert.equal(Number(dailyRows[0].n), 5);
    assert.equal(Number(dailyRows[0].amount), 50);

    const again = await reclassifyMeasurementPayers(db, { apply: true });
    assert.equal(again.settlementsToMove, 0);
    assert.equal(again.settlementsMoved, 0);
    assert.equal(again.dailyRowsToMove, 0);
    assert.deepEqual(await getSettlementCounts({ payeeId: payee }, 30), {
      raw: 14,
      real: 3,
      test: 4,
      measurement: 7,
      uniquePayersReal: 1,
    });
  });
}
