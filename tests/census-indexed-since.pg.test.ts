// ============================================================
// 2026-09-05: `indexed_since` を実 Postgres で確かめる。
//
// 固定するのは 3 点:
//   1. 最古の日は **生行 ∪ 日次集約** から出る（畳んだ日を見落とさない）
//   2. チェーンごとに別々に出る（本番は Base 2026-08-23 / Solana 2026-07-21 と
//      46 日の差がある。全体の最古日だけでは Base の 13 日を隠してしまう）
//   3. chain を絞った応答は、そのチェーンの索引だけで期間を名乗る
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("census indexed_since (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("census indexed_since", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { getCensusSummary } = await import("@/lib/settlements/census");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE settlements, settlement_daily`);

    const BASE = "eip155:8453";
    const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
    const day = (ago: number) => sql`((now() AT TIME ZONE 'UTC')::date - ${ago}::int)`;
    const at = (ago: number) =>
      sql`(((now() AT TIME ZONE 'UTC')::date - ${ago}::int)::timestamp + interval '12 hours') AT TIME ZONE 'UTC'`;
    async function dayText(ago: number): Promise<string> {
      const { rowsOf } = await import("@/lib/settlements/upsert");
      return rowsOf<{ d: string }>(await db.execute(sql`SELECT (${day(ago)})::text AS d`))[0].d;
    }

    let k = 0;
    async function seedRaw(chain: string, daysAgo: number) {
      k++;
      const tx = `0x${k.toString(16).padStart(64, "0")}`;
      await db.execute(sql`
        INSERT INTO settlements (chain, tx_hash, purchase_id, asset, amount, payer, payee, payer_id, payee_id,
                                 observed_at, block_time, attribution, wash_flag, source)
        VALUES (${chain}, ${tx}, ${`${chain}:${tx}`}, '0xasset', '1000', '0xp', '0xq', ${`payer${k}`}, ${`payee${k}`},
                ${at(daysAgo)}, ${at(daysAgo)}, 'confirmed', 'none', 'chain_index')
      `);
    }
    async function seedDaily(chain: string, daysAgo: number, n: number) {
      k++;
      await db.execute(sql`
        INSERT INTO settlement_daily (day, chain, payee_id, payer_id, wash_flag, source, attribution, n, amount_sum)
        VALUES (${day(daysAgo)}, ${chain}, ${`payee${k}`}, ${`payer${k}`}, 'none', 'chain_index', 'confirmed', ${n}, 0)
      `);
    }

    // 本番と同じ形: Base は生行だけ（12 日前から）、Solana は畳んだ日（40 日前）を持つ。
    await seedRaw(BASE, 12);
    await seedRaw(BASE, 1);
    await seedRaw(SOL, 3);
    await seedDaily(SOL, 40, 5);

    const [d40, d12] = [await dayText(40), await dayText(12)];

    await t.test("全チェーン: 最古は畳んだ日から出る。byChain がチェーンごとの差を見せる", async () => {
      const s = await getCensusSummary(null, "30d");
      assert.equal(s.indexed_since.all, d40, "生行だけを見て 12 日前と答えてはいけない");
      assert.deepEqual(s.indexed_since.byChain, { [BASE]: d12, [SOL]: d40 });
      assert.equal(s.indexed_since.all_chains_since, d12, "全チェーンが揃うのは遅い方の日");
      assert.equal(s.indexed_since.window_requested_days, 30);
      assert.equal(s.indexed_since.window_covered_days, 30);
      assert.equal(s.indexed_since.window_fully_covered, true);
      assert.ok(s.indexed_since.note.length > 0, "note が空");
    });

    await t.test("chain を絞ると、そのチェーンの索引だけで期間を名乗る", async () => {
      const s = await getCensusSummary(BASE, "30d");
      assert.equal(s.indexed_since.all, d12);
      assert.deepEqual(s.indexed_since.byChain, { [BASE]: d12 });
      assert.equal(s.indexed_since.all_chains_since, d12);
      assert.equal(s.indexed_since.window_covered_days, 13, "12 日前から今日までは 13 UTC 日");
      assert.equal(s.indexed_since.window_fully_covered, false, "30 日を満たしていないと明示する");
    });

    await t.test("7d 窓は要求どおり 7 日を上限に数える", async () => {
      const s = await getCensusSummary(null, "7d");
      assert.equal(s.indexed_since.window_requested_days, 7);
      assert.equal(s.indexed_since.window_covered_days, 7);
      assert.equal(s.indexed_since.window_fully_covered, true);
    });

    await t.test("索引が空なら 0 日・未充足・byChain も空（30 日を名乗らない）", async () => {
      await db.execute(sql`TRUNCATE settlements, settlement_daily`);
      const s = await getCensusSummary(null, "30d");
      assert.equal(s.indexed_since.all, null);
      assert.equal(s.indexed_since.all_chains_since, null);
      assert.deepEqual(s.indexed_since.byChain, {});
      assert.equal(s.indexed_since.window_covered_days, 0);
      assert.equal(s.indexed_since.window_fully_covered, false);
    });

    await db.execute(sql`TRUNCATE settlements, settlement_daily`);
  });
}
