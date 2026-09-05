// ============================================================
// vet402 Observatory — daily metrics rollup (Phase 1.1).
//
// DB-backed. Properties under test:
//  - one UTC day × chain row per rollup, aggregated FROM the raw tables
//    (x402_l0_probes / x402_l1_purchases joined to endpoints for chain);
//  - idempotent: re-running the same day overwrites, never doubles;
//  - a catalog row with no declared network lands in chain "unknown"
//    (a missing declaration must not silently vanish from the totals);
//  - spent_units sums as integers (USDC base units), not floats.
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/observatory-metrics-rollup.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("metrics rollup (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("daily metrics rollup", async (t) => {
    const { rollupDailyMetrics } = await import("@/lib/observatory/metrics-rollup");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");

    const db = getDb()!;
    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases, x402_daily_metrics`,
    );

    const DAY = "2026-08-15";
    const insEndpoint = async (key: string, network: string | null) => {
      const [row] = await db
        .insert(schema.x402Endpoints)
        .values({ resourceKey: key, resourceUrl: `https://${key}`, network, method: "GET" })
        .returning();
      return row.id;
    };
    const base1 = await insEndpoint("base1.example/api", "eip155:8453");
    const base2 = await insEndpoint("base2.example/api", "eip155:8453");
    const sol1 = await insEndpoint("sol1.example/api", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    const bare = await insEndpoint("bare.example/api", null);

    const probe = (endpointId: string, verdict: string, at: string) =>
      db.insert(schema.x402L0Probes).values({
        endpointId,
        method: "GET",
        verdict,
        probedAt: new Date(at),
      });
    // DAY: base1 pass, base2 fail, sol1 pass, bare pass; day after: base1 pass (must not leak in)
    await probe(base1, "pass", `${DAY}T01:00:00Z`);
    await probe(base2, "fail", `${DAY}T01:00:00Z`);
    await probe(sol1, "pass", `${DAY}T02:00:00Z`);
    await probe(bare, "pass", `${DAY}T03:00:00Z`);
    await probe(base1, "pass", `2026-08-16T01:00:00Z`);

    const purchase = (endpointId: string, status: string, spent: string, at: string) =>
      db.insert(schema.x402L1Purchases).values({
        endpointId,
        status,
        spentUnits: spent,
        attemptedAt: new Date(at),
      });
    // DAY: base1 settled 3000 + base2 settle_failed 2000 (signed → spent) + sol none
    await purchase(base1, "settled", "3000", `${DAY}T04:00:00Z`);
    await purchase(base2, "settle_failed", "2000", `${DAY}T05:00:00Z`);
    await purchase(base1, "settled", "1000", `2026-08-16T04:00:00Z`);

    await t.test("aggregates one day by chain from raw tables", async () => {
      await rollupDailyMetrics(DAY);
      const rows = await db.select().from(schema.x402DailyMetrics);
      const byChain = Object.fromEntries(rows.map((r) => [r.chain, r]));
      assert.equal(rows.length, 3, "base + solana + unknown");
      assert.equal(byChain["eip155:8453"].l0Probes, 2);
      assert.equal(byChain["eip155:8453"].l0Pass, 1);
      assert.equal(byChain["eip155:8453"].l1Attempts, 2);
      assert.equal(byChain["eip155:8453"].l1Settled, 1);
      assert.equal(byChain["eip155:8453"].spentUnits, "5000");
      assert.equal(byChain["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"].l0Probes, 1);
      assert.equal(byChain["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"].l0Pass, 1);
      assert.equal(byChain["unknown"].l0Probes, 1);
    });

    await t.test("idempotent: re-run overwrites, never doubles", async () => {
      await rollupDailyMetrics(DAY);
      await rollupDailyMetrics(DAY);
      const rows = await db.select().from(schema.x402DailyMetrics);
      const base = rows.find((r) => r.chain === "eip155:8453")!;
      assert.equal(rows.length, 3);
      assert.equal(base.l0Probes, 2);
      assert.equal(base.spentUnits, "5000");
    });

    await t.test("malformed day is refused, nothing written", async () => {
      await assert.rejects(() => rollupDailyMetrics("not-a-day"));
    });

    // 2026-09-05: history と state で "attempt" の意味が違った。旧実装は L1 の行を
    // status で絞らずに数えたので、金が動いていない試行（over_cap / no_402 /
    // no_eligible_accept …）まで attempts に入っていた。本番実測で Solana は
    // rolled 50 / live 38、差の 13 件が全てこれ。
    await t.test("払っていない試行は attempts に入れない（state と同じ分母）", async () => {
      await purchase(base1, "over_cap", "0", `${DAY}T06:00:00Z`);
      await purchase(base1, "no_402", "0", `${DAY}T06:30:00Z`);
      await purchase(sol1, "no_eligible_accept", "0", `${DAY}T07:00:00Z`);
      await rollupDailyMetrics(DAY);

      const rows = await db.select().from(schema.x402DailyMetrics);
      const byChain = Object.fromEntries(rows.map((r) => [r.chain, r]));
      assert.equal(byChain["eip155:8453"].l1Attempts, 2, "over_cap / no_402 を attempts に数えている");
      assert.equal(byChain["eip155:8453"].l1Settled, 1);
      assert.equal(byChain["eip155:8453"].spentUnits, "5000");
      assert.equal(
        byChain["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"].l1Attempts,
        0,
        "no_eligible_accept を attempts に数えている",
      );
    });

    // network の空文字はネットワークの申告ではない。'' という名前のチェーン行を
    // 表に作ると、state の byChain（chainLabel が空文字をチェーンとして扱わない）と
    // 突合できない行が公開面に増える。
    await t.test("network が空文字の申告は unknown へ落とす", async () => {
      const blank = await insEndpoint("blank.example/api", "");
      await probe(blank, "pass", `${DAY}T08:00:00Z`);
      await rollupDailyMetrics(DAY);

      const rows = await db.select().from(schema.x402DailyMetrics);
      assert.equal(
        rows.find((r) => r.chain === ""),
        undefined,
        "空文字が chain 名として表に入っている",
      );
      assert.equal(rows.find((r) => r.chain === "unknown")!.l0Probes, 2);
    });

    // 定義を変えて 0 件になった日×チェーンの行が残ると、古い定義の数字が公開面に
    // 残り続ける。再計算で導出されなくなった行は同じ1文の中で消す。
    await t.test("再計算で導出されなくなった行は消える", async () => {
      await db.execute(sql`
        INSERT INTO x402_daily_metrics (day, chain, l0_probes, l0_pass, l1_attempts, l1_settled, spent_units)
        VALUES (${DAY}, 'ghost:1', 9, 9, 9, 9, '9')
      `);
      await rollupDailyMetrics(DAY);
      const rows = await db.select().from(schema.x402DailyMetrics);
      assert.equal(rows.find((r) => r.chain === "ghost:1"), undefined, "幽霊行が残っている");
      // 他の日の行は巻き添えにしない。
      await db.execute(sql`
        INSERT INTO x402_daily_metrics (day, chain, l0_probes, l0_pass, l1_attempts, l1_settled, spent_units)
        VALUES ('2026-08-16', 'ghost:2', 1, 1, 1, 1, '1')
      `);
      await rollupDailyMetrics(DAY);
      const after = await db.select().from(schema.x402DailyMetrics);
      assert.ok(after.some((r) => r.chain === "ghost:2" && r.day === "2026-08-16"));
    });
  });
}
