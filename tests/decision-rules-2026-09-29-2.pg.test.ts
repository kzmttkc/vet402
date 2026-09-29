// ============================================================
// 判定規則 2026-09-29.2 — 本番の読み取り経路（loadSellerFacts → buildDecision）を実 DB で通す。
// 純関数の境界は tests/decision-rules-2026-09-29-2.test.ts。ここは SQL（全履歴の最後の署名・配達、
// 窓の中の並び）が判定まで届くことだけを固定する。
//
// Run: TEST_DATABASE_URL=postgres:///vet402_observatory_test_r4a \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/decision-rules-2026-09-29-2.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("decision rules 2026-09-29.2 on the DB path (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("2026-09-29.2: loadSellerFacts の並びが判定と l1_basis に届く", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { loadSellerFacts } = await import("@/lib/decision/seller-facts");
    const { buildDecision } = await import("@/lib/decision/decide");
    const db = getDb()!;

    const tag = `r4a${Date.now().toString(36)}`;
    let n = 0;
    const mkEndpoint = async () => {
      n++;
      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: `${tag}-${n}.example/api`,
          resourceUrl: `https://${tag}-${n}.example/api`,
          network: "eip155:8453",
          method: "GET",
          payTo: `0x${String(n).repeat(40).slice(0, 40)}`,
        })
        .returning();
      for (const h of [1, 2]) {
        await db.insert(schema.x402L0Probes).values({ endpointId: ep.id, method: "GET", verdict: "pass", probedAt: new Date(Date.now() - h * 3600_000) });
      }
      return ep;
    };
    // 実行ごとに別の tx（x402_l1_purchases_tx_unique に当たらない）。
    let txSeq = Date.now() * 1000;
    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
    const buy = async (endpointId: string, d: number, http: number, nonEmpty: boolean, status = "settled") =>
      db.insert(schema.x402L1Purchases).values({
        endpointId,
        status,
        httpStatusPaid: http,
        payloadNonEmpty: nonEmpty,
        txHash: `0x${(++txSeq).toString(16).padStart(64, "0")}`,
        attemptedAt: daysAgo(d),
        network: "eip155:8453",
        spentUnits: "1000",
        amountUnits: "1000",
      });
    const decideFor = async (id: string) => {
      const loaded = await loadSellerFacts(id);
      assert.ok(loaded);
      return buildDecision({
        role: "payer",
        subject: { type: "resource", id: null, endpoint_id: id, observatory_id: id, canonical_url: loaded.endpoint.canonicalUrl, method: "GET" },
        facts: loaded.facts,
        options: { l1NotCounted: loaded.l1NotCounted, l0UnverifiedCause: loaded.l0UnverifiedCause ?? null, l1Timeline: loaded.l1Timeline },
        score: null,
        registry: { status: "off", tx_hash: null },
        spendingHalted: false,
      });
    };

    await t.test("支払い済み・HTTP 500 が 2 回（cnvrt.ing 型）→ BLOCK・l1_paid_not_delivered", async () => {
      const ep = await mkEndpoint();
      await buy(ep.id, 3, 500, true);
      await buy(ep.id, 10, 500, true);
      const d = await decideFor(ep.id);
      assert.equal(d.recommendation, "BLOCK");
      assert.ok(d.reason_codes.includes("l1_paid_not_delivered"));
      assert.equal(d.l1_basis?.n_paid_undelivered_since_last_delivery, 2);
    });

    await t.test("署名した試行が 30 日の窓の外だけ → l1_stale（l1_not_attempted ではない）・時刻は ISO8601", async () => {
      const ep = await mkEndpoint();
      await buy(ep.id, 35, 200, true);
      const d = await decideFor(ep.id);
      assert.equal((d.facts as { l1: { n_attempts: number } }).l1.n_attempts, 0);
      assert.ok(d.reason_codes.includes("l1_stale"));
      assert.equal(d.reason_codes.includes("l1_not_attempted"), false);
      assert.equal(d.recommendation, "WARN");
      assert.match(d.l1_basis?.last_signed_attempt_at ?? "", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      assert.match(d.l1_basis?.last_delivered_at ?? "", /Z$/);
      assert.ok((d.l1_basis?.days_since_last_delivery ?? 0) >= 34.9);
    });

    await t.test("最新の配達が 20 日前 → WARN・l1_stale（配達はある）／3 日前なら ALLOW", async () => {
      const old = await mkEndpoint();
      await buy(old.id, 20, 200, true);
      const d = await decideFor(old.id);
      assert.equal(d.recommendation, "WARN");
      assert.ok(d.reason_codes.includes("l1_delivered") && d.reason_codes.includes("l1_stale"));
      const fresh = await mkEndpoint();
      await buy(fresh.id, 3, 200, true);
      const f = await decideFor(fresh.id);
      assert.equal(f.recommendation, "ALLOW");
      assert.equal(f.l1_basis?.latest_counted_delivered, true);
    });

    await t.test("配達の後の最新が失敗（決済なし）→ WARN・l1_latest_failed", async () => {
      const ep = await mkEndpoint();
      await buy(ep.id, 5, 200, true);
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id,
        status: "settle_failed",
        httpStatusPaid: 500,
        payloadNonEmpty: false,
        txHash: null,
        attemptedAt: daysAgo(1),
        network: "eip155:8453",
        spentUnits: "1000",
        amountUnits: "1000",
      });
      const d = await decideFor(ep.id);
      assert.equal(d.recommendation, "WARN");
      assert.ok(d.reason_codes.includes("l1_latest_failed"));
    });
  });
}
