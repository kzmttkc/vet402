// ============================================================
// status を直接読む公開面から payer_unfunded を外す（Issue #29・2026-09-17 独立検証の指摘）。
//
//   /decisions・/impact の paid_no_settlement … 「払ったのに決済されなかった損失」。
//     payer_unfunded は我々の空の財布に売り手が 402/5xx を返した行で、金も予算も賭かって
//     いない。budget_denied と同じく判定の外（除外は定義文に書く。行は export.csv に残る）。
//     unsettled_4xx は損失に残す: 生きた署名を出し、決済されなかった支出の事実で、
//     売り手の帰責を述べる面ではない。
//   backtest の事前シグナル（先行 settle_failed）… payer_unfunded は売り手について何も
//     予告しないので外す。payer_unfunded の試行そのものも母数から外す（期間内の試行は
//     シグナルに関係なく決済し得なかったので、avoided を水増しする）。unsettled_4xx は
//     「同じ形の要求がまた決済されない」予告として残す（支出の予測であって帰責ではない）。
//   l1-settlement-record（受取スコアの天井）… settle_failed の 5xx を売り手の咎と数えるが、
//     期間内の 5xx は payer_unfunded なので数えない。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_prep_0917 \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-payer-unfunded-surfaces.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("payer_unfunded surfaces (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("payer_unfunded は損失・事前シグナル・受取の天井に入らない", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { getDecisionFeed } = await import("@/lib/observatory/decisions");
    const { computeSpendGuardBacktest, BACKTEST_DEFINITION } = await import("@/lib/observatory/backtest");
    const { getL1SettlementRecord } = await import("@/lib/scoring/l1-settlement-record");
    const db = getDb()!;

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);
    const mk = async (n: number) => {
      const payTo = `0x${String(n).repeat(40).slice(0, 40)}`;
      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({ resourceKey: `pu${n}.example/api`, resourceUrl: `https://pu${n}.example/api`, network: "eip155:8453", method: "GET", payTo })
        .returning();
      return { ep, payTo };
    };
    const buy = (endpointId: string, payTo: string, status: string, http: number | null, at: string) =>
      db.insert(schema.x402L1Purchases).values({
        endpointId,
        status,
        httpStatusPaid: http,
        payTo,
        network: "eip155:8453",
        spentUnits: "1000",
        amountUnits: "1000",
        attemptedAt: new Date(at),
      });

    // A: 資金切れ期間の 402 と 5xx だけ（のちの 1 件は期間外の 500）
    const a = await mk(1);
    await buy(a.ep.id, a.payTo, "settle_failed", 402, "2026-09-13T06:00:00Z");
    await buy(a.ep.id, a.payTo, "settle_failed", 500, "2026-09-14T06:00:00Z");
    await buy(a.ep.id, a.payTo, "settle_failed", 500, "2026-09-16T06:00:00Z");
    // B: 期間外の 402 → 402 → 500（従来どおり）
    const b = await mk(2);
    await buy(b.ep.id, b.payTo, "settle_failed", 402, "2026-09-10T06:00:00Z");
    await buy(b.ep.id, b.payTo, "settle_failed", 402, "2026-09-11T06:00:00Z");
    await buy(b.ep.id, b.payTo, "settle_failed", 500, "2026-09-12T06:00:00Z");
    // C: 決済レシートなしの 4xx（unsettled_4xx）→ 400
    const c = await mk(3);
    await buy(c.ep.id, c.payTo, "settle_failed", 400, "2026-09-10T06:00:00Z");
    await buy(c.ep.id, c.payTo, "settle_failed", 422, "2026-09-11T06:00:00Z");

    await t.test("/decisions: payer_unfunded は paid_no_settlement に入らず、行にも出さない", async () => {
      const feed = await getDecisionFeed(366);
      // 全 8 行のうち payer_unfunded は 2 行（A の 402 と期間内 500）
      assert.equal(feed.totalDecisions, 6);
      assert.equal(feed.totals.paidNoSettlement, 6, "期間外 5xx/402・unsettled_4xx は損失のまま");
      assert.equal(feed.rows.length, 6);
      assert.ok(!feed.rows.some((r) => r.at.startsWith("2026-09-13") || r.at.startsWith("2026-09-14")));
      assert.match(feed.definition, /payer_unfunded/);
    });

    await t.test("backtest: payer_unfunded は事前シグナルにも母数にも入らない", async () => {
      const r = await computeSpendGuardBacktest();
      // 母数 = 8 − payer_unfunded 2
      assert.equal(r.attemptsTotal, 6);
      // シグナル有り×非 settle: A の 09-16（先行は payer_unfunded だけ → シグナル無し）は入らない。
      // B の 09-11・09-12（先行 402 期間外）、C の 09-11（先行 unsettled_4xx）で 3。
      assert.equal(r.avoided.count, 3);
      assert.match(BACKTEST_DEFINITION, /payer_unfunded/);
    });

    await t.test("受取の天井: 期間内 5xx は売り手の咎に数えない・期間外 5xx は数える", async () => {
      const recA = await getL1SettlementRecord(a.payTo);
      assert.equal(recA.resolvedNonSettling, 1, "A は期間外の 500 だけ");
      assert.equal(recA.nonSettlingDays, 1);
      const recB = await getL1SettlementRecord(b.payTo);
      assert.equal(recB.resolvedNonSettling, 1, "B は期間外の 500（402 は従来どおり数えない）");
    });
  });
}
