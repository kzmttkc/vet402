// ============================================================
// 2026-09-29 会計監査 7 周目（低）: acquireLease は取得の文が例外を投げると acquired: true を返す（lease.ts・凍結中）。
// DB の障害時に 2 本の起動が両方走れる。呼び手（l1-purchase・demo verify・index/verify-settlements・settlements-rollup）は
// acquireLeaseFailClosed で取り、取れたと確かめられたときだけ走る。
//
// 守ること:
//  1. 普通に取れる・保持中なら held・解放すれば次が取れる（従来どおり）。
//  2. 取得の文が例外（表が無い）で acquireLease が「通した」とき、acquired: false / unverified。
//  3. 他者が保持中のリースがあるのに、取得が例外で「通した」とき（acquire を差し替えて再現）も unverified。
//  4. 取れた直後の確認が読めなかったら、本当に取れていたリースは解放する（期限まで握らない）。
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

    await t.test("他者が保持中なのに取得が例外で「通した」とき、走らない（unverified）", async () => {
      await reset();
      const other = await acquireLease(NAME, 60);
      assert.equal(other.acquired, true);
      const r = await silence(() =>
        acquireLeaseFailClosed(NAME, 60, { acquire: async () => ({ acquired: true, release: async () => {} }) }),
      );
      assert.deepEqual(r, { acquired: false, reason: "unverified" });
      const [row] = (await db.execute(sql`SELECT count(*)::int AS n FROM job_leases WHERE name = ${NAME}`)) as unknown as { n: number }[];
      assert.equal(row.n, 1, "他者のリースを消している");
      if (other.acquired) await other.release();
    });

    await t.test("確認の読みが落ちたら、本当に取れていたリースは解放して走らない", async () => {
      await reset();
      let released = 0;
      const r = await silence(() =>
        acquireLeaseFailClosed(NAME, 60, {
          acquire: async (n, ttl) => {
            const real = await acquireLease(n, ttl);
            assert.equal(real.acquired, true);
            // 取った直後に行を消し、確認が「無い」と読む形を作る。
            await db.execute(sql`DELETE FROM job_leases WHERE name = ${NAME}`);
            return { acquired: true, release: async () => { released++; if (real.acquired) await real.release(); } };
          },
        }),
      );
      assert.deepEqual(r, { acquired: false, reason: "unverified" });
      assert.equal(released, 1, "確かめられなかったリースを解放していない");
    });
  });
}
