// ============================================================
// 2026-09-04 W15: 30 日センサスを「正確なまま」保存量を有界にする。
// 生行は直近 7 日だけ持ち、それより古い UTC 日は (day, chain, payee, payer,
// wash, source, attribution, endpoint, resource) の日次集約へ畳んで消す。
//
// このテストが固定するのは 1 点だけ——**畳んでも答えが変わらない**こと。
// 生行のみで計算したセンサスと、畳んだ後（生行 ∪ 集約）のセンサスが
// 完全一致する。raw / real / wash 内訳 / attribution 内訳 / by_source /
// unique payers / unique payees / endpoints_with_real_settlement の全部。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("settlements rollup (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  test("settlements rollup", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { getCensusSummary, getSettlementCounts } = await import("@/lib/settlements/census");
    const { planRollup, runRollup, RAW_RETENTION_DAYS } = await import("@/lib/settlements/rollup");
    const { rowsOf } = await import("@/lib/settlements/upsert");
    const db = getDb()!;

    const EP = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
    const CHAINS = ["eip155:8453", "eip155:137"];
    const WASH = ["none", "none", "none", "test", "self_deal", "circular"];
    const SOURCES = ["chain_index", "chain_index", "l1_purchase", "payments_api"];
    const ATTR = ["confirmed", "probable", "unmatched"];

    /** 生行を撒く。d = UTC の何日前か。 */
    async function seed(startDay: number, endDay: number) {
      const values: string[] = [];
      let k = 0;
      for (let d = startDay; d <= endDay; d++) {
        // 1 日あたり 24 行。(payee, payer) は日をまたいで再出現するので
        // unique payers が「集約からも正確に出るか」が実際に効く。
        for (let i = 0; i < 24; i++) {
          k++;
          // 鍵は j（8 通り）だけで決まるので、1 日 24 行は 8 グループに畳まれる。
          const j = i % 8;
          const chain = CHAINS[j % 2];
          const payer = `payer${(j % 5) + 1}`;
          const payee = `payee${(j % 3) + 1}`;
          const wash = WASH[j % WASH.length];
          const source = SOURCES[j % SOURCES.length];
          const attr = ATTR[j % ATTR.length];
          const ep = j % 4 === 3 ? "NULL" : `'${EP[j % 2]}'::uuid`;
          const res = j % 4 === 3 ? "NULL" : `'res${j % 2}'`;
          const tx = `0x${k.toString(16).padStart(64, "0")}`;
          // 一部は block_time が NULL（observed_at で日が決まる経路）。
          const at = `(((now() AT TIME ZONE 'UTC')::date - ${d})::timestamp + interval '12 hours') AT TIME ZONE 'UTC'`;
          const bt = i % 7 === 0 ? "NULL" : at;
          // amount は数字でない値も混ぜる（畳む処理が落ちないこと）。
          const amount = i % 11 === 0 ? "'not-a-number'" : `'${1000 + i}'`;
          values.push(
            `('${chain}', '${tx}', '${chain}:${tx}', '0xasset', ${amount}, '0xpayer', '0xpayee', '${payer}', '${payee}', ${at}, ${bt}, '${attr}', ${res}, ${ep}, '${wash}', '${source}')`,
          );
        }
      }
      await db.execute(
        sql.raw(`INSERT INTO settlements
          (chain, tx_hash, purchase_id, asset, amount, payer, payee, payer_id, payee_id, observed_at, block_time, attribution, resource_id, endpoint_id, wash_flag, source)
          VALUES ${values.join(",")}`),
      );
    }

    async function snapshot() {
      const [all30, all7, base] = await Promise.all([
        getCensusSummary(null, "30d"),
        getCensusSummary(null, "7d"),
        getCensusSummary(CHAINS[0], "30d"),
      ]);
      // retrievedAt は呼ぶたびに変わるので比較から外す。
      const strip = ({ retrievedAt, ...rest }: Awaited<ReturnType<typeof getCensusSummary>>) => {
        void retrievedAt;
        return rest;
      };
      return {
        all30: strip(all30),
        all7: strip(all7),
        base: strip(base),
        ep0: await getSettlementCounts({ endpointId: EP[0] }, 30),
        payee1: await getSettlementCounts({ payeeId: "payee1" }, 30),
      };
    }

    const scalar = async (q: ReturnType<typeof sql>) => Number(rowsOf<{ n: number }>(await db.execute(q))[0]?.n ?? 0);
    const rawRows = () => scalar(sql`SELECT count(*)::int AS n FROM settlements`);

    await db.execute(sql`TRUNCATE settlements, settlement_daily`);
    await seed(0, 34);

    const before = await snapshot();
    const rawBefore = await rawRows();
    assert.equal(rawBefore, 35 * 24);
    assert.ok(before.all30.settlements_raw > 0, "30 日窓に生行がある");
    assert.ok(before.all30.unique_payers_real > 0);
    assert.ok(before.all30.endpoints_with_real_settlement > 0);

    await t.test("dry-run は何も書かない。畳む日数・行数・削減見込みを返す", async () => {
      const plan = await planRollup();
      assert.equal(plan.applied, false);
      assert.equal(plan.rawRetentionDays, RAW_RETENTION_DAYS);
      // 35 日撒いて 7 日残す → 28 日ぶんが対象。
      assert.equal(plan.days.length, 35 - RAW_RETENTION_DAYS);
      assert.equal(plan.rowsFolded, (35 - RAW_RETENTION_DAYS) * 24);
      assert.ok(plan.groupsWritten > 0 && plan.groupsWritten < plan.rowsFolded, "集約は生行より少ない");
      assert.ok(plan.estimatedFreedMb >= 0);
      assert.equal(await rawRows(), rawBefore, "dry-run で生行は減らない");
      assert.deepEqual((await snapshot()).all30, before.all30);
    });

    await t.test("apply: 7 日より古い生行は消え、センサスは 1 つも値が変わらない", async () => {
      const res = await runRollup({ apply: true });
      assert.equal(res.applied, true);
      assert.equal(res.rowsFolded, (35 - RAW_RETENTION_DAYS) * 24);
      assert.equal(await rawRows(), RAW_RETENTION_DAYS * 24, "残るのは直近 7 日ぶんだけ");

      const staleN = await scalar(sql`
        SELECT count(*)::int AS n FROM settlements
        WHERE (coalesce(block_time, observed_at) AT TIME ZONE 'UTC')::date <= (now() AT TIME ZONE 'UTC')::date - ${RAW_RETENTION_DAYS}::int
      `);
      assert.equal(staleN, 0);

      const after = await snapshot();
      assert.deepEqual(after.all30, before.all30, "30 日センサスが一致");
      assert.deepEqual(after.all7, before.all7, "7 日センサスが一致");
      assert.deepEqual(after.base, before.base, "chain 絞り込みでも一致");
      assert.deepEqual(after.ep0, before.ep0, "endpoint 単位の 30 日実需が一致");
      assert.deepEqual(after.payee1, before.payee1, "payee 単位の 30 日実需が一致");
    });

    await t.test("同じ日を何度畳んでも結果は同じ（冪等）", async () => {
      const again = await runRollup({ apply: true });
      assert.equal(again.rowsFolded, 0);
      const after = await snapshot();
      assert.deepEqual(after.all30, before.all30);
      assert.deepEqual(after.ep0, before.ep0);
    });

    await t.test("畳んだ後に遅れて届いた生行は、二重計上も取りこぼしもしない", async () => {
      const tx = `0x${"f".repeat(64)}`;
      await db.execute(sql`
        INSERT INTO settlements (chain, tx_hash, purchase_id, asset, amount, payer, payee, payer_id, payee_id,
                                 observed_at, block_time, attribution, resource_id, endpoint_id, wash_flag, source)
        VALUES (${CHAINS[0]}, ${tx}, ${`${CHAINS[0]}:${tx}`}, '0xasset', '1000', '0xp', '0xq', 'payer1', 'payee1',
                now(), (((now() AT TIME ZONE 'UTC')::date - 20)::timestamp + interval '12 hours') AT TIME ZONE 'UTC',
                'confirmed', 'res0', ${EP[0]}::uuid, 'none', 'chain_index')
      `);
      const withLate = await snapshot();
      assert.equal(withLate.all30.settlements_raw, before.all30.settlements_raw + 1, "遅れて届いた 1 件が数えられる");
      assert.equal(withLate.all30.settlements_real, before.all30.settlements_real + 1);

      await runRollup({ apply: true });
      const folded = await snapshot();
      assert.deepEqual(folded.all30, withLate.all30, "畳んでも値は変わらない（二重計上なし）");
      assert.deepEqual(folded.ep0, withLate.ep0);
    });

    await t.test("集約の保持期間を過ぎた日は落ちる（保存量が有界になる）", async () => {
      await db.execute(sql`TRUNCATE settlements, settlement_daily`);
      await seed(500, 502);
      await runRollup({ apply: true });
      const keptN = await scalar(sql`SELECT count(*)::int AS n FROM settlement_daily`);
      assert.equal(keptN, 0, "既定 45 日より古い集約は残さない");
    });

    await db.execute(sql`TRUNCATE settlements, settlement_daily`);
  });
}

// ------------------------------------------------------------
// デプロイ順序: コードが先に本番へ出て、DDL がまだ流れていない状態。
// センサスと買い手事実は「集約が空」と同じ答え（＝畳む前と同じ値）に
// 落ちて、500 を返さない。畳む処理だけは落として見えるようにする。
// ------------------------------------------------------------
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  test("settlement_daily がまだ無いとき、読み取りは生行だけで答える", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { getCensusSummary, getSettlementCounts } = await import("@/lib/settlements/census");
    const { loadBuyerFacts } = await import("@/lib/decision/buyer-facts");
    const { runRollup } = await import("@/lib/settlements/rollup");
    const db = getDb()!;

    await db.execute(sql`TRUNCATE settlements, settlement_daily`);
    const tx = `0x${"c".repeat(64)}`;
    await db.execute(sql`
      INSERT INTO settlements (chain, tx_hash, purchase_id, asset, amount, payer, payee, payer_id, payee_id,
                               observed_at, block_time, attribution, wash_flag, source)
      VALUES ('eip155:8453', ${tx}, ${`eip155:8453:${tx}`}, '0xasset', '1000', '0xp', '0xq', 'payerZ', 'payeeZ',
              now(), now(), 'confirmed', 'none', 'chain_index')
    `);
    // 表を一時的に落として「DDL 前」を再現する。
    await db.execute(sql`ALTER TABLE settlement_daily RENAME TO settlement_daily_hidden`);
    try {
      await t.test("センサスは 500 にせず生行の値を返す", async () => {
        const c = await getCensusSummary(null, "30d");
        assert.equal(c.settlements_raw, 1);
        assert.equal(c.settlements_real, 1);
        assert.equal((await getSettlementCounts({ payeeId: "payeeZ" }, 30)).real, 1);
      });
      await t.test("買い手事実も落ちない", async () => {
        const f = await loadBuyerFacts("eip155:8453:0x00000000000000000000000000000000000000zz");
        assert.equal(f.settled_count_30d, 0);
      });
      await t.test("畳む処理は fail-loud（黙って何もしない方が危ない）", async () => {
        await assert.rejects(() => runRollup({ apply: true }));
      });
    } finally {
      await db.execute(sql`ALTER TABLE settlement_daily_hidden RENAME TO settlement_daily`);
      await db.execute(sql`TRUNCATE settlements, settlement_daily`);
    }
  });
}
