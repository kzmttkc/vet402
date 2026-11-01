// ============================================================
// loadSellerFacts が窓の外のプローブを読む SQL と回数（2026-11-02・純関数は decision-l0-streak-window.test.ts）。
//
// Run: TEST_DATABASE_URL=postgres://localhost/<test db> \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/decision-l0-streak-window.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("decision l0 streak window (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("loadSellerFacts: 窓の外は足りないときだけ 1 回読み、判定の材料にだけ使う", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { loadSellerFacts } = await import("@/lib/decision/seller-facts");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);

    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
    let seq = 0;
    const mk = async (probes: readonly (readonly [string, number])[]) => {
      seq++;
      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: `streak${seq}.example/api`,
          resourceUrl: `https://streak${seq}.example/api`,
          network: "eip155:8453",
          method: "GET",
          payTo: `0x${String(seq).repeat(40).slice(0, 40)}`,
        })
        .returning();
      for (const [verdict, days] of probes) {
        await db.insert(schema.x402L0Probes).values({
          endpointId: ep.id,
          method: "GET",
          verdict,
          probedAt: daysAgo(days),
          failReason: verdict === "fail" ? `reason_at_${days}d` : null,
        });
      }
      return ep.id as string;
    };

    // 同じ db の execute を数える。窓の外を読んだ分だけ 1 回増える。
    const executes = t.mock.method(db, "execute");
    const load = async (id: string) => {
      const before = executes.mock.callCount();
      const loaded = await loadSellerFacts(id);
      assert.ok(loaded);
      return { loaded, calls: executes.mock.callCount() - before };
    };

    const twoInWindow = await load(await mk([["fail", 1], ["fail", 2]]));
    assert.equal(twoInWindow.loaded.facts.l0.status, "fail");
    const passInWindow = await load(await mk([["pass", 1]]));
    assert.equal(passInWindow.loaded.facts.l0.status, "pass");
    assert.equal(passInWindow.calls, twoInWindow.calls, "pass は追加で読まない");
    const base = twoInWindow.calls;

    const failOut = await load(await mk([["fail", 11], ["fail", 31], ["pass", 60]]));
    assert.equal(failOut.calls, base + 1, "足りないときだけ 1 回");
    assert.equal(failOut.loaded.facts.l0.status, "fail");
    assert.equal(failOut.loaded.facts.l0.fail_reason, "reason_at_11d", "窓の中の最新の行");
    assert.equal(failOut.loaded.l0UnverifiedCause, null);
    assert.equal(failOut.loaded.facts.availability_30d, 0, "窓の外の行は分母にも入らない");
    assert.equal(failOut.loaded.facts.offer_stability, "unknown");

    const passOut = await load(await mk([["fail", 11], ["pass", 31], ["fail", 40]]));
    assert.equal(passOut.calls, base + 1);
    assert.equal(passOut.loaded.facts.l0.status, "unverified", "窓の外の直近の 1 本だけを見る");
    assert.equal(passOut.loaded.l0UnverifiedCause, "single_fail");

    const onlyOne = await load(await mk([["fail", 11]]));
    assert.equal(onlyOne.calls, base + 1);
    assert.equal(onlyOne.loaded.facts.l0.status, "unverified");
    assert.equal(onlyOne.loaded.l0UnverifiedCause, "single_fail");

    const noneInWindow = await load(await mk([["fail", 31], ["fail", 32]]));
    assert.equal(noneInWindow.calls, base, "窓の中に 0 本なら読まない");
    assert.equal(noneInWindow.loaded.facts.l0.status, "unverified");
    assert.equal(noneInWindow.loaded.l0UnverifiedCause, "not_probed");

    const unverifiedInWindow = await load(await mk([["unverified", 11], ["fail", 31]]));
    assert.equal(unverifiedInWindow.calls, base, "連続が始まっていなければ読まない");
    assert.equal(unverifiedInWindow.loaded.facts.l0.status, "unverified");

    // 別の出品の行を拾わない（endpoint_id で絞る）: 直前に窓の外の fail を持つ出品が並んでいても本数は足りない。
    const other = await load(await mk([["fail", 12]]));
    assert.equal(other.loaded.l0UnverifiedCause, "single_fail");
  });
}
