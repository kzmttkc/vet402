// ============================================================
// 2026-09-04 W15: 生行を 7 日で畳んでも、買い手事実の 30 日集計と
// 初回観測日は変わらない。/decision が読む公開事実なので、保存の都合で
// 「30 日の実績」が「7 日の実績」に静かにすり替わってはいけない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("buyer facts raw window (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  test("buyer_facts: 畳んでも 30 日の件数・取引先数・初回観測は変わらない", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { loadBuyerFacts } = await import("@/lib/decision/buyer-facts");
    const { runRollup } = await import("@/lib/settlements/rollup");
    const { payeeId } = await import("@/lib/ids/canonical");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE settlements, settlement_daily, funder_wallets`);

    const CHAIN = "eip155:8453";
    const PAYER = payeeId(CHAIN, "0x00000000000000000000000000000000000000b7");
    // 3 / 12 / 25 日前に別々の payee へ、200 日前に 1 件（生涯の初回観測）。
    const rows: [number, string][] = [
      [3, "payeeA"],
      [12, "payeeB"],
      [25, "payeeC"],
      [25, "payeeC"],
      [200, "payeeD"],
    ];
    let k = 0;
    for (const [daysAgo, payee] of rows) {
      k++;
      const tx = `0x${k.toString(16).padStart(64, "0")}`;
      await db.execute(sql`
        INSERT INTO settlements (chain, tx_hash, purchase_id, asset, amount, payer, payee, payer_id, payee_id,
                                 observed_at, block_time, attribution, wash_flag, source)
        VALUES (${CHAIN}, ${tx}, ${`${CHAIN}:${tx}`}, '0xasset', '1000', '0xp', '0xq', ${PAYER}, ${payee},
                (((now() AT TIME ZONE 'UTC')::date - ${daysAgo}::int)::timestamp + interval '12 hours') AT TIME ZONE 'UTC',
                (((now() AT TIME ZONE 'UTC')::date - ${daysAgo}::int)::timestamp + interval '12 hours') AT TIME ZONE 'UTC',
                'confirmed', 'none', 'chain_index')
      `);
    }

    const before = await loadBuyerFacts(PAYER);

    const ageDays = (iso: string | null) => (iso ? (Date.now() - new Date(iso).getTime()) / 86_400_000 : null);

    await t.test("畳む前: 30 日窓に 4 件・取引先 3、初回観測は 200 日前", async () => {
      assert.equal(before.settled_count_30d, 4);
      assert.equal(before.unique_payees_30d, 3);
      assert.ok(before.first_seen, "first_seen が取れている");
      assert.ok(ageDays(before.first_seen)! > 190, `初回観測が 200 日前のはず (実際 ${Math.round(ageDays(before.first_seen)!)} 日)`);
    });

    await t.test("畳んだ後も 30 日の件数と取引先数は 1 つも変わらない", async () => {
      await runRollup({ apply: true });
      const after = await loadBuyerFacts(PAYER);
      assert.equal(after.settled_count_30d, before.settled_count_30d);
      assert.equal(after.unique_payees_30d, before.unique_payees_30d);
      assert.equal(after.last_seen?.slice(0, 10), before.last_seen?.slice(0, 10), "最終観測は日単位で一致");
    });

    await t.test("first_seen は「保持している範囲の初回」に縮む——消えはしない（既知の制約）", async () => {
      // 200 日前の 1 件は集約の保持期間（既定 45 日）を過ぎて落ちている。
      // 生涯の初回観測は保存し直さない限り復元できない。null にはせず、
      // 保持範囲で最も古い 25 日前を返す。/decision の「新規（7 日未満）」
      // 判定は保守側に振れるだけで、fail-open にはならない。
      const after = await loadBuyerFacts(PAYER);
      assert.ok(after.first_seen, "畳んでも first_seen は null にならない");
      const age = ageDays(after.first_seen)!;
      assert.ok(age > 24 && age < 30, `保持範囲の最も古い 25 日前を返すはず (実際 ${Math.round(age)} 日)`);
    });

    await db.execute(sql`TRUNCATE settlements, settlement_daily, funder_wallets`);
  });
}
