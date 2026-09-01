// ============================================================
// anchorThrough は欠けた日を古い順に埋め、鎖を連続にする（2026-09-02 監査）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("anchors backfill (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  test("anchors backfill", async (t) => {
    const { anchorDay, anchorThrough, getAnchors, chainContinuity } = await import("@/lib/observatory/anchors");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE ledger_anchors, x402_l1_purchases`);

    await t.test("genesis: 最初の日は前日無しで固定できる", async () => {
      const r = await anchorDay("2026-08-14");
      assert.equal(r.status, "created");
    });

    await t.test("前日が欠けた日を直接 anchorDay すると拒否される（穴を飛ばして連結しない）", async () => {
      await assert.rejects(() => anchorDay("2026-08-16"), /前日が未固定/);
    });

    await t.test("anchorThrough は欠けた日を埋めてから目的日を固定し、鎖が連続になる", async () => {
      const rs = await anchorThrough("2026-08-18");
      assert.deepEqual(
        rs.map((r) => r.day),
        ["2026-08-15", "2026-08-16", "2026-08-17", "2026-08-18"],
      );
      const rows = await getAnchors(30);
      const c = chainContinuity(rows);
      assert.equal(c.linked, true);
      assert.equal(c.contiguous, true);
      assert.deepEqual(c.gaps, []);
      assert.equal(rows.length, 5);
    });

    await t.test("再実行は冪等（unchanged）", async () => {
      const rs = await anchorThrough("2026-08-18");
      assert.equal(rs.length, 1);
      assert.equal(rs[0].status, "unchanged");
    });

    await t.test("後から穴を埋めたら、その後の既存日も再連結される（prev_root が飛ばない）", async () => {
      // 旧実装の状態を再現: 16 が無く、17 は 15 に「飛ばして連結」している
      const r15 = await db.execute(sql`SELECT root_hash FROM ledger_anchors WHERE day = '2026-08-15'`);
      const root15 = ((Array.isArray(r15) ? r15 : (r15 as { rows?: unknown[] }).rows) as { root_hash: string }[])[0].root_hash;
      await db.execute(sql`DELETE FROM ledger_anchors WHERE day = '2026-08-16'`);
      await db.execute(sql`UPDATE ledger_anchors SET prev_root = ${root15}, root_hash = 'stale17' WHERE day = '2026-08-17'`);
      await db.execute(sql`UPDATE ledger_anchors SET prev_root = 'stale17', root_hash = 'stale18' WHERE day = '2026-08-18'`);
      const rs = await anchorThrough("2026-08-18");
      assert.deepEqual(rs.map((r) => `${r.day}:${r.status}`), ["2026-08-16:created", "2026-08-17:updated", "2026-08-18:updated"]);
      const c = chainContinuity(await getAnchors(30));
      assert.equal(c.intact, true);
    });
  });
}
