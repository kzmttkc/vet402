// ============================================================
// 2026-09-29 会計監査 7 周目（低）: acquireLease は取得の文が例外を投げると acquired: true を返す（lease.ts・凍結中）。
// DB の障害時に 2 本の起動が両方走れる。呼び手（l1-purchase・demo verify・index/verify-settlements・settlements-rollup）は
// acquireLeaseFailClosed で取り、取れたと確かめられたときだけ走る。
//
// 守ること:
//  1. 普通に取れる・保持中なら held・解放すれば次が取れる（従来どおり）。
//  2. 取得の文が例外（表が無い）で acquireLease が「通した」とき、acquired: false / unverified。
//  3. 自分の取得が例外で終わり、別の起動が t0 より後に取った行があっても unverified（独立レビューの警告の再現）。
//  4. 別の起動が保持中なら held。期限切れの行は取り直せ、release は自分の holder の行だけ消す。
// Run: TEST_DATABASE_URL=postgres:///vet402_observatory_test_r7d \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/cron-lease-fail-closed.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("cron lease fail-closed (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("cron lease fail-closed", async (t) => {
    const { acquireLease } = await import("@/lib/cron/lease");
    const { acquireLeaseFailClosed } = await import("@/lib/cron/lease-fail-closed");
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
    const NAME = "test-lease-fail-closed";
    const reset = () => db.execute(sql`DELETE FROM job_leases WHERE name = ${NAME}`);
    const silence = async <T>(f: () => Promise<T>): Promise<T> => {
      const orig = console.error;
      console.error = () => {};
      try {
        return await f();
      } finally {
        console.error = orig;
      }
    };

    await t.test("普通に取れる・保持中は held・解放すれば次が取れる", async () => {
      await reset();
      const a = await acquireLeaseFailClosed(NAME, 60);
      assert.equal(a.acquired, true);
      const b = await acquireLeaseFailClosed(NAME, 60);
      assert.deepEqual(b, { acquired: false, reason: "held" });
      if (a.acquired) await a.release();
      const c = await acquireLeaseFailClosed(NAME, 60);
      assert.equal(c.acquired, true);
      if (c.acquired) await c.release();
    });

    await t.test("表が無く acquireLease が「通した」とき、走らない（unverified）", async () => {
      await reset();
      await db.execute(sql`ALTER TABLE job_leases RENAME TO job_leases_hidden_r7d`);
      try {
        const plain = await silence(() => acquireLease(NAME, 60));
        assert.equal(plain.acquired, true, "前提: lease.ts は例外で通す（この所見の本体）");
        const r = await silence(() => acquireLeaseFailClosed(NAME, 60));
        assert.deepEqual(r, { acquired: false, reason: "unverified" });
      } finally {
        await db.execute(sql`ALTER TABLE job_leases_hidden_r7d RENAME TO job_leases`);
      }
    });

    await t.test("自分の取得が例外で終わり、別の起動が t0 より後に取った行があっても、走らない（unverified）", async () => {
      // 独立レビューの警告の再現: 別の起動の行（acquired_at が今より後・期限内）が在る状態で、自分の upsert が例外になる
      // （ttl が int に収まらない）。初版は acquireLease の「通した」を受けて表を読み直し、その行を自分のものと数えた。
      await reset();
      await db.execute(sql`
        INSERT INTO job_leases (name, holder, acquired_at, expires_at)
        VALUES (${NAME}, gen_random_uuid(), now() + interval '1 minute', now() + interval '10 minutes')`);
      const r = await silence(() => acquireLeaseFailClosed(NAME, 2 ** 40));
      assert.deepEqual(r, { acquired: false, reason: "unverified" });
      const raw = await db.execute(sql`SELECT count(*)::int AS n FROM job_leases WHERE name = ${NAME}`);
      const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { n: number }[];
      assert.equal(rows[0].n, 1, "別の起動のリースを消している");
    });

    await t.test("別の起動が保持中なら held。期限の切れた他者の行は取り直せ、解放は自分の行だけ消す", async () => {
      await reset();
      const other = await acquireLease(NAME, 60);
      assert.equal(other.acquired, true);
      assert.deepEqual(await acquireLeaseFailClosed(NAME, 60), { acquired: false, reason: "held" });
      if (other.acquired) await other.release();

      await db.execute(sql`
        INSERT INTO job_leases (name, holder, acquired_at, expires_at)
        VALUES (${NAME}, gen_random_uuid(), now() - interval '10 minutes', now() - interval '1 minute')`);
      const mine = await acquireLeaseFailClosed(NAME, 60);
      assert.equal(mine.acquired, true, "期限の切れた行を取り直せない");
      // 自分の期限が切れた後に他者が取り直した場面: 自分の release は他者の行を消さない。
      await db.execute(sql`UPDATE job_leases SET holder = gen_random_uuid() WHERE name = ${NAME}`);
      if (mine.acquired) await mine.release();
      const raw = await db.execute(sql`SELECT count(*)::int AS n FROM job_leases WHERE name = ${NAME}`);
      const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { n: number }[];
      assert.equal(rows[0].n, 1, "他者の行を解放している");
      await reset();
    });
  });
}
