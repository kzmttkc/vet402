// ============================================================
// 2026-08-24 監査: cron のバッチ排他。
//
// l1-purchase は実資金を動かすのにバッチ全体の排他が無かった。予約SQL
// (reserveSpend) が単一文で原子的なので**日次上限そのものは破れない**が、
// 二重起動は孤児 in_flight の増減・summary の混乱・同じエンドポイントへの
// 重複購入を生む。Vercel cron の重複発火は実在し得るし、手動トリガと定時が
// 重なることもある（デモ日に一番困る形）。
//
// advisory lock は使えない: neon-http はステートレスなHTTPで、セッション
// レベルのロックが文をまたいで保たれない。reserveSpend を単一文にしたのと
// 同じ制約なので、同じ手を使う——期限付きリースを1文の upsert で取る。
// 読んでから書かないので TOCTOU が無い。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("cron lease (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  // TRUNCATE より前に、接続先が本番（Neon）でないことを機械で確かめる（2026-09-04 監査 D・P2）。
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("cron lease", async (t) => {
    const { acquireLease } = await import("@/lib/cron/lease");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS job_leases (
        name text PRIMARY KEY,
        holder uuid NOT NULL,
        acquired_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      )`);
    const NAME = "test-lease";
    const reset = async () => db.execute(sql`DELETE FROM job_leases WHERE name = ${NAME}`);

    await t.test("同時に取りに行っても1本しか取れない", async () => {
      await reset();
      const rs = await Promise.all([1, 2, 3, 4, 5].map(() => acquireLease(NAME, 60)));
      const got = rs.filter((r) => r.acquired).length;
      assert.equal(got, 1, "二重起動が両方通っている——排他が効いていない");
      for (const r of rs) if (r.acquired) await r.release();
    });

    await t.test("保持中は取れない", async () => {
      await reset();
      const held = await acquireLease(NAME, 60);
      assert.equal(held.acquired, true);
      const second = await acquireLease(NAME, 60);
      assert.equal(second.acquired, false);
      if (held.acquired) await held.release();
    });

    await t.test("解放したら次が取れる", async () => {
      await reset();
      const a = await acquireLease(NAME, 60);
      assert.equal(a.acquired, true);
      if (a.acquired) await a.release();
      const b = await acquireLease(NAME, 60);
      assert.equal(b.acquired, true, "解放後に取れない——デッドロックになる");
      if (b.acquired) await b.release();
    });

    await t.test("期限が切れたリースは奪える（殺された関数がロックを永久に残さない）", async () => {
      await reset();
      const a = await acquireLease(NAME, 60);
      assert.equal(a.acquired, true);
      // 関数がプラットフォームに殺された状況を作る: release せず期限だけ過去にする
      await db.execute(sql`UPDATE job_leases SET expires_at = now() - interval '1 second' WHERE name = ${NAME}`);
      const b = await acquireLease(NAME, 60);
      assert.equal(b.acquired, true, "期限切れを奪えない——一度殺されたら二度と走らない");
      if (b.acquired) await b.release();
    });

    await t.test("他人のリースは解放できない", async () => {
      await reset();
      const a = await acquireLease(NAME, 60);
      assert.equal(a.acquired, true);
      // a を奪った体で b が保持している状態にする
      await db.execute(sql`UPDATE job_leases SET expires_at = now() - interval '1 second' WHERE name = ${NAME}`);
      const b = await acquireLease(NAME, 60);
      assert.equal(b.acquired, true);
      // a が遅れて release しても、b の保持を壊さない
      if (a.acquired) await a.release();
      const c = await acquireLease(NAME, 60);
      assert.equal(c.acquired, false, "他人のリースを解放してしまっている");
      if (b.acquired) await b.release();
    });

    await reset();
  });
}
