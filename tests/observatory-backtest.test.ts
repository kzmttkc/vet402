// ============================================================
// SpendGuardバックテスト（#9）。主張を機械定義に固定する:
//  「事前シグナル」= 支払い試行時点で (a) 直前2連続のL0 fail が存在した、
//  または (b) 同一エンドポイントに先行する settle_failed が存在した。
//  - avoided  = シグナル有りで settle しなかった試行（従えば失えなかった金）
//  - forgone  = シグナル有りなのに settle した試行（従えば見送った成功——
//               これも同じ重みで公開する。片面だけ出したら宣伝になる）
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("backtest (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  test("spend guard backtest", async (t) => {
    const { computeSpendGuardBacktest } = await import("@/lib/observatory/backtest");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);

    const mkEp = async (key: string) => {
      const [r] = await db
        .insert(schema.x402Endpoints)
        .values({ resourceKey: key, resourceUrl: `https://${key}`, network: "eip155:8453", method: "GET" })
        .returning();
      return r.id;
    };
    const probe = (endpointId: string, verdict: string, at: string) =>
      db.insert(schema.x402L0Probes).values({ endpointId, method: "GET", verdict, probedAt: new Date(at) });
    const buy = (endpointId: string, status: string, spent: string, at: string) =>
      db.insert(schema.x402L1Purchases).values({ endpointId, status, spentUnits: spent, attemptedAt: new Date(at) });

    // A: 2連続fail後に settle_failed（→ avoided に入る・3000）
    const a = await mkEp("a.example/api");
    await probe(a, "fail", "2026-08-10T01:00:00Z");
    await probe(a, "fail", "2026-08-10T02:00:00Z");
    await buy(a, "settle_failed", "3000", "2026-08-10T03:00:00Z");

    // B: 2連続fail後に settled（→ forgone に入る・2000）
    const b = await mkEp("b.example/api");
    await probe(b, "fail", "2026-08-10T01:00:00Z");
    await probe(b, "fail", "2026-08-10T02:00:00Z");
    await buy(b, "settled", "2000", "2026-08-10T03:00:00Z");

    // C: pass直後の settle_failed（シグナル無し → どちらにも入らない）
    const c = await mkEp("c.example/api");
    await probe(c, "pass", "2026-08-10T01:00:00Z");
    await buy(c, "settle_failed", "1500", "2026-08-10T02:00:00Z");

    // D: 先行settle_failedの後の再試行settle_failed（(b)シグナル → avoided・1000）。
    //    最初の失敗自体はシグナル無しなので数えない。
    const d = await mkEp("d.example/api");
    await buy(d, "settle_failed", "500", "2026-08-09T01:00:00Z");
    await buy(d, "settle_failed", "1000", "2026-08-10T01:00:00Z");

    // E: 2連続fail後の settle_claimed（照合待ち＝結果が無い → 分母にも avoided にも入らない・2026-09-29）
    const e = await mkEp("e.example/api");
    await probe(e, "fail", "2026-08-10T01:00:00Z");
    await probe(e, "fail", "2026-08-10T02:00:00Z");
    await buy(e, "settle_claimed", "7000", "2026-08-10T03:00:00Z");

    await t.test("両面が機械定義どおりに数えられる", async () => {
      const r = await computeSpendGuardBacktest();
      assert.equal(r.attemptsTotal, 5, "settle_claimed（E）は数えない");
      assert.equal(r.avoided.count, 2, "A + Dの再試行");
      assert.equal(r.avoided.spentUnits, "4000");
      assert.equal(r.forgone.count, 1, "B");
      assert.equal(r.forgone.spentUnits, "2000");
      assert.ok(r.definition.includes("two consecutive"), "定義文を同梱");
    });
  });
}
