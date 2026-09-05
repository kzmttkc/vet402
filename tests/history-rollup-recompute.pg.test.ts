// ============================================================
// 2026-09-05: /api/v1/observatory/history と /api/v1/observatory/state の
// L1 合計が突合できなかった欠陥。第三者（配布戦略セッション）の検算で発覚——
// 「第三者が検算できる測定」を売る製品で、公開している 2 面が合わなかった。
//
// 原因は 2 つ。分母の食い違い（tests/observatory-metrics-rollup.test.ts が
// 受け持つ）と、**凍結**。集計 cron は 10:30 UTC、L1 の決済確認 cron は
// 14:00 UTC。旧実装は「前日と当日」の 2 日しか書かなかったので、その日の
// 後半に settled へ昇格した行は二度と集計へ入らなかった（本番実測:
// 集計済み 13 日で live settled > rolled settled、Base だけで 221 件の過小）。
//
// ここが固定するのは 3 つ:
//  - 直近 N 日の再計算で、後から settled になった行が反映されること
//  - その窓の外の日は勝手に動かないこと（cron が過去へ無限に手を伸ばさない）
//  - 何度走らせても同値であること（raw からの再導出なので状態を持たない）
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/history-rollup-recompute.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

// DB を要らない部分（env の読み取り）は常に走らせる。
test("METRICS_ROLLUP_LOOKBACK_DAYS の読み取り", async () => {
  const { metricsRollupLookbackDays, METRICS_ROLLUP_LOOKBACK_DEFAULT_DAYS } = await import(
    "@/lib/observatory/metrics-rollup"
  );
  assert.equal(metricsRollupLookbackDays({}), METRICS_ROLLUP_LOOKBACK_DEFAULT_DAYS);
  assert.equal(metricsRollupLookbackDays({ METRICS_ROLLUP_LOOKBACK_DAYS: "" }), 14);
  assert.equal(metricsRollupLookbackDays({ METRICS_ROLLUP_LOOKBACK_DAYS: "7" }), 7);
  // 読めない値を既定へ黙って戻さない——「設定したつもりで効いていない」が
  // このファイルが直している欠陥そのもの。
  for (const bad of ["abc", "0", "-3", "1.5", "400"]) {
    assert.throws(
      () => metricsRollupLookbackDays({ METRICS_ROLLUP_LOOKBACK_DAYS: bad }),
      /METRICS_ROLLUP_LOOKBACK_DAYS/,
      bad,
    );
  }
});

test("shiftDay は UTC 日を跨いでずれない", async () => {
  const { shiftDay } = await import("@/lib/observatory/metrics-rollup");
  assert.equal(shiftDay("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftDay("2026-09-05", -14), "2026-08-22");
});

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("history rollup recompute (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const CHAIN = "eip155:8453";

  test("直近 N 日の再計算", async (t) => {
    const {
      rollupDailyMetrics,
      rollupRecentDailyMetrics,
      getDailyMetricsCoverage,
      previewDailyMetrics,
    } = await import("@/lib/observatory/metrics-rollup");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;

    const DAY = "2026-08-20";
    const TODAY = "2026-08-25"; // DAY から 5 日後

    const reset = async () => {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases, x402_daily_metrics`,
      );
      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: "late.example/api",
          resourceUrl: "https://late.example/api",
          network: CHAIN,
          method: "GET",
        })
        .returning();
      const [pu] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId: ep.id,
          status: "settle_failed",
          network: CHAIN,
          spentUnits: "1000",
          attemptedAt: new Date(`${DAY}T18:00:00Z`),
        })
        .returning();
      return { endpointId: ep.id, purchaseId: pu.id };
    };

    const rolled = async (day: string) => {
      const rows = await db
        .select()
        .from(schema.x402DailyMetrics)
        .where(eq(schema.x402DailyMetrics.day, day));
      return rows.find((r) => r.chain === CHAIN) ?? null;
    };

    await t.test("集計後に settled へ昇格した行が、次の再計算で入る", async () => {
      const { purchaseId } = await reset();
      // その日の 10:30 UTC の cron が走った時点（まだ settle_failed）。
      await rollupDailyMetrics(DAY);
      assert.equal((await rolled(DAY))!.l1Attempts, 1);
      assert.equal((await rolled(DAY))!.l1Settled, 0, "前提が崩れている");

      // 14:00 UTC の verify-settlements が settled へ昇格させる。
      await db
        .update(schema.x402L1Purchases)
        .set({ status: "settled" })
        .where(eq(schema.x402L1Purchases.id, purchaseId));

      // 旧実装（当日＋前日だけ）なら 5 日後のこの実行では届かない。
      await rollupRecentDailyMetrics({ days: 14, endDay: TODAY });
      assert.equal((await rolled(DAY))!.l1Settled, 1, "遅れて確定した決済が集計へ入っていない");
      assert.equal((await rolled(DAY))!.l1Attempts, 1);
    });

    await t.test("窓の外の日は動かさない（cron が過去へ無限に伸びない）", async () => {
      const { purchaseId } = await reset();
      await rollupDailyMetrics(DAY);
      await db
        .update(schema.x402L1Purchases)
        .set({ status: "settled" })
        .where(eq(schema.x402L1Purchases.id, purchaseId));

      // 窓 2 日・終端 TODAY（= DAY の 5 日後）なので DAY は範囲外。
      const days = await rollupRecentDailyMetrics({ days: 2, endDay: TODAY });
      assert.deepEqual(days, ["2026-08-24", "2026-08-25"]);
      assert.equal((await rolled(DAY))!.l1Settled, 0, "窓の外の日まで書き換えている");
    });

    await t.test("冪等: 2 回回しても同値（updated_at 以外）", async () => {
      await reset();
      await rollupRecentDailyMetrics({ days: 14, endDay: TODAY });
      const first = await db.select().from(schema.x402DailyMetrics);
      await rollupRecentDailyMetrics({ days: 14, endDay: TODAY });
      const second = await db.select().from(schema.x402DailyMetrics);
      const strip = (rows: typeof first) =>
        rows
          .map((r) => ({ ...r, updatedAt: null }))
          .sort((a, b) => `${a.day}${a.chain}`.localeCompare(`${b.day}${b.chain}`));
      assert.deepEqual(strip(second), strip(first));
    });

    await t.test("preview は書かない（dry-run が表を触らない）", async () => {
      await reset();
      const preview = await previewDailyMetrics(DAY);
      assert.equal(preview.length, 1);
      assert.equal(preview[0].chain, CHAIN);
      assert.equal(preview[0].l1Attempts, 1);
      const rows = await db.select().from(schema.x402DailyMetrics);
      assert.equal(rows.length, 0, "dry-run が表へ書いている");
    });

    await t.test("preview と rollup は同じ値を出す", async () => {
      await reset();
      const preview = await previewDailyMetrics(DAY);
      await rollupDailyMetrics(DAY);
      const written = await rolled(DAY)!;
      assert.equal(preview[0].l1Attempts, written!.l1Attempts);
      assert.equal(preview[0].l1Settled, written!.l1Settled);
      assert.equal(preview[0].spentUnits, written!.spentUnits);
    });

    await t.test("coverage は表の被覆をそのまま返す", async () => {
      await reset();
      await rollupRecentDailyMetrics({ days: 14, endDay: TODAY });
      const cov = await getDailyMetricsCoverage();
      assert.equal(cov.coverageFrom, DAY, "行のある最古の日を返していない");
      assert.equal(cov.rolledUpThrough, DAY, "行のある最新の日を返していない");
      assert.match(cov.lastRollupAt ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    await t.test("行が 1 つも無ければ coverage は null（0 と偽らない）", async () => {
      await db.execute(sql`TRUNCATE x402_daily_metrics`);
      const cov = await getDailyMetricsCoverage();
      assert.deepEqual(cov, { coverageFrom: null, rolledUpThrough: null, lastRollupAt: null });
    });
  });
}
