// ============================================================
// 台帳ハッシュチェーン（TEE設計 Stage 0 / 買収DDの資産固定）。
// 固定する性質:
//  - 決定的: 同じ日のデータからは常に同じ root（並び順は主キーで固定）
//  - 連鎖: day N の root は day N-1 の root を含んで計算される
//  - 冪等: 再実行で root が変わらない（変わらないデータなら）
//  - 改竄検出: 過去行を1つ書き換えると root が変わる
//  - 不可逆の防波堤: anchored_tx が入った日の root は上書きしない
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/observatory-anchors.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("ledger anchors (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  test("ledger anchor chain", async (t) => {
    const { anchorDay, getAnchors } = await import("@/lib/observatory/anchors");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, x402_daily_metrics, ledger_anchors`);
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({ resourceKey: "a.example/api", resourceUrl: "https://a.example/api", network: "eip155:8453", method: "GET" })
      .returning();
    const buy = (status: string, spent: string, at: string) =>
      db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id, status, spentUnits: spent, attemptedAt: new Date(at),
      });
    await buy("settled", "3000", "2026-08-15T04:00:00Z");
    await buy("settle_failed", "2000", "2026-08-15T05:00:00Z");
    await buy("settled", "1000", "2026-08-16T04:00:00Z");

    let root15 = "";
    await t.test("決定的・冪等・entry_countが実数", async () => {
      const a = await anchorDay("2026-08-15");
      const b = await anchorDay("2026-08-15");
      assert.equal(a.rootHash, b.rootHash);
      assert.match(a.rootHash, /^[0-9a-f]{64}$/);
      assert.equal(a.entryCount, 2);
      root15 = a.rootHash;
    });

    await t.test("連鎖: day16のprev_rootはday15のroot", async () => {
      const a16 = await anchorDay("2026-08-16");
      const rows = await getAnchors(30);
      const r16 = rows.find((r) => r.day === "2026-08-16")!;
      assert.equal(r16.prevRoot, root15);
      assert.equal(a16.entryCount, 1);
    });

    // 2026-11-10 公平審査 3.8 の 6c: 後ろの日が繋がった root は書き換えない（書き換えると鎖が切れ、
    // 封印の後に中身を差し替えた日が検証を通ってしまう）。改ざんは計算し直した root の差で見える。
    await t.test("改竄検出: 過去行を書き換えると計算し直した root が変わり、後ろが繋がった root は書き換えない", async () => {
      await db.execute(sql`UPDATE x402_l1_purchases SET spent_units='9999' WHERE spent_units='3000'`);
      const a = await anchorDay("2026-08-15");
      assert.equal(a.status, "conflict_frozen");
      assert.equal(a.rootHash, root15, "the stored root a later day links to stays");
      assert.notEqual(a.recomputedRoot, root15, "tamper must change the recomputed root");
    });

    await t.test("鎖の先頭（後ろに日が無い）なら、同日の遅延到着行で root を更新する", async () => {
      const before = (await getAnchors(30)).find((r) => r.day === "2026-08-16")!;
      await buy("settled", "500", "2026-08-16T05:00:00Z");
      const a = await anchorDay("2026-08-16");
      assert.equal(a.status, "updated");
      assert.notEqual(a.rootHash, before.rootHash);
    });

    await t.test("anchored_txが入った日は上書きを拒否する", async () => {
      const current = (await getAnchors(30)).find((r) => r.day === "2026-08-15")!;
      await db
        .update(schema.ledgerAnchors)
        .set({ anchoredTx: "0xanchored" })
        .where(eq(schema.ledgerAnchors.day, "2026-08-15"));
      await db.execute(sql`UPDATE x402_l1_purchases SET spent_units='1' WHERE spent_units='9999'`);
      const a = await anchorDay("2026-08-15");
      assert.equal(a.status, "conflict_frozen");
      const after = (await getAnchors(30)).find((r) => r.day === "2026-08-15")!;
      assert.equal(after.rootHash, current.rootHash, "anchored root must never change");
    });
  });
}
