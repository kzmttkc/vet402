// ============================================================
// 2026-09-04 W16: 「30 日」が保存の都合で黙って「7 日」に縮まないこと。
//
// settlements の生行は RAW_RETENTION_DAYS 日しか残らない（rollup.ts）。
// 生行だけを見る 30 日述語は、畳んだ瞬間に窓が縮む——**エラーは出ない**。
// C2 だった endpoint が C1 へ落ち、L1 の対象から静かに消える。
//
// このテストが固定するのは 1 点だけ——**畳んでも階層と分母が変わらない**こと。
//   - l0TierWhere('c1') / l0TierWhere('c2') の該当件数
//   - loadCoverageTiers の階層（C0〜C4）
//   - fetchSloSnapshot の c2_l1_within_48h_pct（分母 = 30 日 DISTINCT endpoint）
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_w16_test \
//        npx tsx --test tests/coverage-rollup-window.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("coverage rollup window (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;
  // 本番の既定は生行 30 日（rollup.ts）。このテストが守るのは「30 日窓の内側で
  // 畳まれた日も数え続ける」ことなので、保持を 7 日に縮めて畳みを起こす。
  // rollup は下で動的 import するので、この env はモジュール読込前に効く。
  process.env.SETTLEMENTS_RAW_RETENTION_DAYS = "7";

  // 30 日以内・生行の保持期間（このテストでは 7 日）より古い日（畳む対象になる日）。
  const OLD_DAY = 20;
  // 生行の保持期間の内側（畳んでも残る日）。
  const NEW_DAY = 1;

  const EP = {
    // 古い決済だけ・帰属あり → C2。畳むと壊れる筆頭。
    a: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
    // 古い決済だけ・帰属なし・掲載も 40 日前 → settled30d だけで C1。
    b: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
    // 決済なし・掲載は 5 日前 → C1（決済に依存しない対照）。
    c: "cccccccc-3333-4333-8333-cccccccccccc",
    // 直近の決済・帰属あり → C2（畳んでも生行に残る対照）。
    d: "dddddddd-4444-4444-8444-dddddddddddd",
  } as const;

  test("settlements を畳んでも coverage の階層と L0 分母は変わらない", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { l0TierWhere, loadCoverageTiers } = await import("@/lib/observatory/coverage");
    const { fetchSloSnapshot } = await import("@/lib/scoring/l0-accuracy");
    const { runRollup } = await import("@/lib/settlements/rollup");
    const { rowsOf } = await import("@/lib/settlements/upsert");
    const db = getDb()!;

    const at = (daysAgo: number) =>
      sql`((((now() AT TIME ZONE 'UTC')::date - ${daysAgo}::int)::timestamp + interval '12 hours') AT TIME ZONE 'UTC')`;

    async function seedEndpoint(id: string, lastSeenDaysAgo: number) {
      await db.execute(sql`
        INSERT INTO x402_endpoints (id, resource_key, resource_url, source, method, status, first_seen_at, last_seen_at)
        VALUES (${id}::uuid, ${`key-${id}`}, ${`https://example.test/${id}`}, 'cdp_bazaar', 'GET', 'active',
                ${at(60)}, ${at(lastSeenDaysAgo)})
      `);
    }

    let txSeq = 0;
    async function seedSettlement(endpointId: string, daysAgo: number, attribution: string) {
      txSeq++;
      const tx = `0x${txSeq.toString(16).padStart(64, "0")}`;
      await db.execute(sql`
        INSERT INTO settlements (chain, tx_hash, purchase_id, asset, amount, payer, payee, payer_id, payee_id,
                                 observed_at, block_time, attribution, resource_id, endpoint_id, wash_flag, source)
        VALUES ('eip155:8453', ${tx}, ${`eip155:8453:${tx}`}, '0xasset', '1000', '0xp', '0xq',
                ${`payer-${endpointId}`}, ${`payee-${endpointId}`}, ${at(daysAgo)}, ${at(daysAgo)},
                ${attribution}, ${`res-${endpointId}`}, ${endpointId}::uuid, 'none', 'chain_index')
      `);
    }

    await db.execute(sql`TRUNCATE settlements, settlement_daily, x402_endpoints, x402_l1_purchases, decision_lookups, disputes`);

    await seedEndpoint(EP.a, 40);
    await seedEndpoint(EP.b, 40);
    await seedEndpoint(EP.c, 5);
    await seedEndpoint(EP.d, 40);
    await seedSettlement(EP.a, OLD_DAY, "confirmed");
    await seedSettlement(EP.b, OLD_DAY, "unmatched");
    await seedSettlement(EP.d, NEW_DAY, "probable");
    // c2_l1_within_48h_pct の分子側。分母 {a, d} のうち d だけが 48h 以内に L1 済み → 50%。
    await db.execute(sql`
      INSERT INTO x402_l1_purchases (endpoint_id, attempted_at, status, spent_units)
      VALUES (${EP.d}::uuid, now() - interval '1 hour', 'success', '0')
    `);

    const tierCount = async (tier: "c1" | "c2") =>
      Number(
        rowsOf<{ n: number }>(
          await db.execute(sql`SELECT count(*)::int AS n FROM x402_endpoints e WHERE ${l0TierWhere(tier)}`),
        )[0]?.n ?? 0,
      );

    async function snapshot() {
      const tiers = await loadCoverageTiers(Object.values(EP));
      const slo = await fetchSloSnapshot();
      return {
        c1: await tierCount("c1"),
        c2: await tierCount("c2"),
        tiers: Object.fromEntries([...tiers.entries()].sort()),
        c2Fresh: slo.c2_l1_within_48h_pct,
      };
    }

    const before = await snapshot();

    await t.test("畳む前: 古い決済だけの endpoint も C2 / C1 に入る", () => {
      assert.deepEqual(before.tiers, { [EP.a]: "C2", [EP.b]: "C1", [EP.c]: "C1", [EP.d]: "C2" });
      assert.equal(before.c1, 4, "c1 候補は 4 件（a は決済で、b は決済で、c は掲載で、d は決済で入る）");
      assert.equal(before.c2, 2, "c2 候補は帰属のある a と d");
      assert.equal(before.c2Fresh, 50, "分母 2（a, d）のうち 48h 以内の L1 は d だけ");
    });

    await t.test("7 日より古い生行を畳んでも、階層も分母も 1 つも変わらない", async () => {
      const res = await runRollup({ apply: true });
      assert.ok(res.rowsFolded >= 2, "古い 2 件は畳まれた");
      const remaining = Number(
        rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM settlements`))[0]?.n ?? 0,
      );
      assert.equal(remaining, 1, "生行に残るのは直近 7 日の 1 件だけ");

      const after = await snapshot();
      assert.deepEqual(after.tiers, before.tiers, "階層が一致");
      assert.equal(after.c1, before.c1, "c1 候補数が一致");
      assert.equal(after.c2, before.c2, "c2 候補数が一致");
      assert.equal(after.c2Fresh, before.c2Fresh, "c2_l1_within_48h_pct の分母が一致");
    });

    await db.execute(sql`TRUNCATE settlements, settlement_daily, x402_endpoints, x402_l1_purchases, decision_lookups, disputes`);
  });

  // ------------------------------------------------------------
  // デプロイ順序: コードが先に本番へ出て DDL が未実行のとき、階層判定と
  // SLO は「集約が空」＝生行だけの答えに落ちる（500 にしない）。
  // ------------------------------------------------------------
  test("settlement_daily がまだ無くても、階層判定と SLO は落ちない", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { l0TierWhere, loadCoverageTiers } = await import("@/lib/observatory/coverage");
    const { fetchSloSnapshot } = await import("@/lib/scoring/l0-accuracy");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { rowsOf } = await import("@/lib/settlements/upsert");
    const db = getDb()!;

    await db.execute(sql`TRUNCATE settlements, settlement_daily, x402_endpoints, x402_l1_purchases, decision_lookups, disputes`);
    await db.execute(sql`
      INSERT INTO x402_endpoints (id, resource_key, resource_url, source, method, status, first_seen_at, last_seen_at)
      VALUES (${EP.c}::uuid, 'key-c', 'https://example.test/c', 'cdp_bazaar', 'GET', 'active', now(), now())
    `);
    await db.execute(sql`ALTER TABLE settlement_daily RENAME TO settlement_daily_hidden`);
    try {
      await t.test("l0TierWhere(tier, false) は生行だけの式になる", async () => {
        const n = Number(
          rowsOf<{ n: number }>(
            await db.execute(sql`SELECT count(*)::int AS n FROM x402_endpoints e WHERE ${l0TierWhere("c1", false)}`),
          )[0]?.n ?? 0,
        );
        assert.equal(n, 1);
      });
      await t.test("probe-runner は候補を 0 件にせず、生行だけの式へ落ちる", async () => {
        const summary = await runL0ProbeBatch({
          tier: "c1",
          limit: 10,
          concurrency: 1,
          fetchImpl: async () => new Response("", { status: 500 }),
        });
        assert.equal(summary.probed, 1, "集約表が無くても候補は見つかる（0 件に落ちない）");
      });
      await t.test("loadCoverageTiers も落ちない", async () => {
        assert.equal((await loadCoverageTiers([EP.c])).get(EP.c), "C1");
      });
      await t.test("fetchSloSnapshot も落ちない", async () => {
        const slo = await fetchSloSnapshot();
        assert.equal(slo.c2_l1_within_48h_pct, null, "帰属のある endpoint が 0 件なら率は出さない");
      });
    } finally {
      await db.execute(sql`ALTER TABLE settlement_daily_hidden RENAME TO settlement_daily`);
      await db.execute(sql`TRUNCATE settlements, settlement_daily, x402_endpoints, x402_l0_probes`);
    }
  });
}
