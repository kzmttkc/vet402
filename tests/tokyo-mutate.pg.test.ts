// ============================================================
// ETHGlobal Tokyo 2026 B8 — 審査員ボタンの DB（W03-a・W03-b と戻す権利）を本物の Postgres で。
// TEST_DATABASE_URL が無ければ skip。先頭で assertTestDatabaseIsNotProduction（本番へカウンタを撃たない）。
//
//   W03-a  1日の上限は1文の upsert の中で数える: 70 本を同時に投げても通るのは 60 本
//   W03-b  停止スイッチ: 行が無い → 止めない／enabled → 止める
//   W05    戻す権利は1つ（二重に取れない）・generation が進んでいたら戻し結果を書かない
// 表はこのテストが IF NOT EXISTS で作る（本番へ流す DDL と同じ形・報告に逐語で載せる）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("tokyo mutate DB (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("tokyo mutate: 上限・停止スイッチ・戻す権利が本物の SQL で成り立つ", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { dbStore } = await import("@/app/api/tokyo/_lib/store");
    const { decideHalt, probeTokyoHalt } = await import("@/app/api/tokyo/_lib/halt");
    const { AMOUNT, DAILY_CAP, HALT_FLAG } = await import("@/app/api/tokyo/_lib/constants");
    const db = getDb()!;

    await db.execute(sql`CREATE TABLE IF NOT EXISTS ip_rate_limits (bucket_key text PRIMARY KEY, count bigint NOT NULL DEFAULT 0, reset_at timestamptz NOT NULL)`);
    await db.execute(sql`CREATE TABLE IF NOT EXISTS runtime_flags (name text PRIMARY KEY, enabled boolean NOT NULL, reason text, updated_at timestamptz NOT NULL DEFAULT now(), updated_by text)`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS tokyo_mutations (
        id integer PRIMARY KEY DEFAULT 1,
        current_value text NOT NULL,
        generation bigint NOT NULL DEFAULT 0,
        mutated_at timestamptz,
        reverting_until timestamptz,
        last_tx text,
        CONSTRAINT tokyo_mutations_singleton CHECK (id = 1)
      )`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS tokyo_mutation_log (
        id bigserial PRIMARY KEY,
        at timestamptz NOT NULL DEFAULT now(),
        from_value text NOT NULL,
        to_value text NOT NULL,
        tx text
      )`);
    await db.execute(sql`TRUNCATE tokyo_mutations, tokyo_mutation_log`);
    await db.execute(sql`DELETE FROM ip_rate_limits WHERE bucket_key LIKE 'tokyo-mutate-%'`);
    await db.execute(sql`DELETE FROM runtime_flags WHERE name = ${HALT_FLAG}`);

    const store = dbStore();

    await t.test("W03-a: 70 本を同時に数えても通るのは 60 本", async () => {
      const key = "tokyo-mutate-day:2026-09-27";
      const reset = new Date(Date.UTC(2026, 8, 28));
      const got = await Promise.all(Array.from({ length: 70 }, () => store.consumeDaily(key, DAILY_CAP, reset)));
      assert.equal(got.filter((x) => x !== null).length, 60);
      assert.equal(await store.peekDaily(key), 60);
      assert.equal(await store.consumeDaily(key, DAILY_CAP, reset), null);
    });

    await t.test("連打の間隔: 同じ鍵の2回目は通らない", async () => {
      assert.equal(await store.consumeInterval("tokyo-mutate-ip:test", 20_000), true);
      assert.equal(await store.consumeInterval("tokyo-mutate-ip:test", 20_000), false);
    });

    await t.test("W03-b: 行が無ければ止めない・enabled なら止める", async () => {
      assert.equal(decideHalt(await probeTokyoHalt()).halted, false);
      await db.execute(sql`
        INSERT INTO runtime_flags (name, enabled, reason, updated_by) VALUES (${HALT_FLAG}, true, 'test', 'test')
        ON CONFLICT (name) DO UPDATE SET enabled = true, reason = EXCLUDED.reason, updated_at = now()`);
      const v = decideHalt(await probeTokyoHalt());
      assert.equal(v.halted, true);
      assert.equal(v.source, "row");
      await db.execute(sql`UPDATE runtime_flags SET enabled = false WHERE name = ${HALT_FLAG}`);
      assert.equal(decideHalt(await probeTokyoHalt()).halted, false);
    });

    await t.test("W05: 戻す権利は1つ・進んだ generation を上書きしない", async () => {
      await store.ensureRow();
      await store.ensureRow(); // 2回目は何もしない
      let row = await store.readRow();
      assert.equal(row.currentValue, AMOUNT.off);
      await store.recordMutation("0xaaa");
      row = await store.readRow();
      assert.equal(row.currentValue, AMOUNT.on);
      assert.ok(row.mutatedAt instanceof Date);

      const [a, b] = await Promise.all([store.claimRevert(), store.claimRevert()]);
      assert.equal([a, b].filter((x) => x !== null).length, 1, "戻す権利が2つ取れた");
      const gen = (a ?? b)!;

      await store.recordMutation("0xbbb"); // 戻している間に誰かが変えた
      assert.equal(await store.finishRevert(gen, "0xccc"), false);
      row = await store.readRow();
      assert.equal(row.currentValue, AMOUNT.on);
      assert.equal(row.lastTx, "0xbbb");

      const gen2 = await store.claimRevert();
      assert.notEqual(gen2, null);
      assert.equal(await store.finishRevert(gen2!, "0xddd"), true);
      row = await store.readRow();
      assert.equal(row.currentValue, AMOUNT.off);
      assert.equal(row.revertingUntil, null);

      await store.appendLog(AMOUNT.on, AMOUNT.off, "0xddd");
      const log = await store.recentLog(10);
      assert.equal(log[0].to, AMOUNT.off);
      assert.equal(log[0].tx, "0xddd");
    });

    await t.test("id = 1 以外の行は入らない（CHECK）", async () => {
      await assert.rejects(db.execute(sql`INSERT INTO tokyo_mutations (id, current_value) VALUES (2, '10000')`));
    });
  });
}
