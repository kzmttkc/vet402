// ============================================================
// 2026-09-29 監査 5 周目（データ記者）の是正を本物の Postgres で固定する。
//
//   1. 訂正ログ: カーソルで全件を 1 回ずつ遡れる（同じ created_at の行を頁の境目で落とさない）・total は数え直せる
//   2a. /sellers の export を outcome で数えると readSellerBoard の件数と一致する
//   2b. L0 の export を数えると getObservatoryStats の L0 の件数と一致する・mainnet の表から名前の無い id を外す
//   6/7. 照合待ち（settle_claimed）の件数と長く待つ行
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test_r5d \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/audit-r5-exports.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("audit r5 exports (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("audit r5: 訂正ログの頁送り・export と集計の一致・mainnet の表・照合待ち", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { listCorrections, countCorrections, encodeCorrectionCursor, decodeCorrectionCursor } = await import(
      "@/lib/observatory/corrections"
    );
    const { readSellerBoard, readSellerExport } = await import("@/lib/sellers/reader");
    const { countSellerExportOutcomes } = await import("@/lib/sellers/export");
    const { readL0Export } = await import("@/lib/observatory/l0-export");
    const { getObservatoryStats, getObservatoryStatsByChain, getChainScope } = await import("@/lib/observatory/reader");
    const db = getDb()!;

    await db.execute(sql`TRUNCATE correction_log, x402_endpoints, x402_l0_probes, x402_l1_purchases`);

    await t.test("訂正ログ: limit 2 のカーソルで 7 行を 1 回ずつ読み切る（同じ created_at が 3 行）", async () => {
      const same = "2026-09-29 02:15:32.820289+00";
      const ins = async (reason: string, at: string, before: unknown, after: unknown) =>
        db.execute(sql`
          INSERT INTO correction_log (subject_type, subject_id, level, before, after, reason, created_at)
          VALUES ('purchase', gen_random_uuid()::text, 'l1', ${JSON.stringify(before)}::jsonb, ${JSON.stringify(after)}::jsonb, ${reason}, ${at}::timestamptz)
        `);
      const TX = `0x${"d2".repeat(32)}`;
      for (let i = 0; i < 3; i++) {
        await ins("settlement_backfill", same, { status: "delivered_no_receipt", txHash: TX }, { status: "settle_claimed", txHash: TX });
      }
      await ins("settlement_backfill", "2026-09-29 02:58:47.1+00", { status: "settle_claimed" }, { status: "settled", blockNumber: "1" });
      await ins("settlement_backfill", "2026-09-28 00:00:00+00", { status: "settle_claimed" }, { status: "settle_claim_refuted" });
      await ins("dispute_remeasure", "2026-09-27 00:00:00+00", { publishedVerdict: "fail" }, { publishedVerdict: "pass" });
      await ins("path_template", "2026-09-02 00:00:00+00", { publishedVerdict: "fail" }, { publishedVerdict: "unverified" });

      assert.equal(await countCorrections(), 7);
      assert.equal(await countCorrections({ reason: "settlement_backfill" }), 5);

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const before = cursor ? decodeCorrectionCursor(cursor)! : undefined;
        const page = await listCorrections({ limit: 2, before });
        seen.push(...page.map((r) => r.id));
        cursor = page.length === 2 ? encodeCorrectionCursor(page[page.length - 1]) : null;
        pages++;
        assert.ok(pages < 10, "頁送りが終わらない");
      } while (cursor);
      assert.equal(seen.length, 7, "全件");
      assert.equal(new Set(seen).size, 7, "重複なし");

      const onlyBackfill = await listCorrections({ reason: "settlement_backfill", limit: 500 });
      assert.equal(onlyBackfill.length, 5);
      const paths = onlyBackfill.map((r) => r.settlement_path).sort();
      assert.deepEqual(paths, ["claim_refuted", "seller_named_tx_promoted", "seller_named_tx_promoted", "seller_named_tx_promoted", "verified_settled"]);
      const other = await listCorrections({ reason: "dispute_remeasure" });
      assert.equal(other[0].settlement_path, null);
    });

    // --- 出品と購入 ---
    const mk = async (key: string, o: { network?: string; status?: string } = {}) => {
      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: key,
          resourceUrl: `https://${key}`,
          network: o.network ?? "eip155:8453",
          method: "GET",
          status: o.status ?? "active",
          priceAmount: "1000",
        })
        .returning();
      return ep.id;
    };
    let txSeq = 0;
    const tx = () => `0x${(++txSeq).toString(16).padStart(64, "0")}`;
    const buy = async (endpointId: string, s: { status: string; http?: number | null; tx?: boolean; at: string; network?: string | null }) =>
      db.insert(schema.x402L1Purchases).values({
        endpointId,
        status: s.status,
        httpStatusPaid: s.http ?? null,
        txHash: s.tx ? tx() : null,
        attemptedAt: new Date(s.at),
        network: s.network === undefined ? "eip155:8453" : s.network,
        spentUnits: "0",
        amountUnits: "1000",
      });
    const probe = async (endpointId: string, verdict: string, hoursAgo: number) =>
      db.execute(sql`
        INSERT INTO x402_l0_probes (endpoint_id, method, verdict, http_status, probed_at)
        VALUES (${endpointId}::uuid, 'GET', ${verdict}, 402, now() - make_interval(hours => ${hoursAgo}))
      `);

    const a1 = await mk("shop.example/a");
    const a2 = await mk("shop.example:4450/b");
    const a3 = await mk("shop.example/c"); // 買っていない
    const b1 = await mk("b.example/x");
    const b2 = await mk("b.example/y");
    const gone = await mk("gone.example/x", { status: "delisted" });
    const celo = await mk("celo.example/x", { network: "eip155:11142220" });
    const odd = await mk("odd.example/x", { network: "eip155:987654321" });
    const sol = await mk("sol.example/x", { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });

    await buy(a1, { status: "settled", http: 200, tx: true, at: "2026-09-28T00:00:00Z" });
    await buy(a2, { status: "settle_claimed", http: 200, tx: true, at: "2026-09-12T12:07:55Z" }); // 17 日照合待ちの形
    await buy(b1, { status: "settle_failed", http: 500, at: "2026-09-20T00:00:00Z" });
    await buy(b1, { status: "settle_failed", http: 500, at: "2026-09-21T00:00:00Z" });
    await buy(b2, { status: "over_cap", at: "2026-09-21T00:00:00Z", network: null });
    await buy(a1, { status: "settle_claimed", http: 200, tx: true, at: new Date(Date.now() - 3600_000).toISOString() });

    await probe(a1, "pass", 1);
    await probe(a2, "fail", 2);
    await probe(a2, "fail", 1);
    await probe(b1, "pass", 24 * 9); // 7 日より古い pass
    await probe(gone, "pass", 5);
    await probe(celo, "pass", 1);
    await probe(odd, "pass", 1);
    await probe(sol, "fail", 1);

    await t.test("/sellers の export: outcome で数えると一覧の件数と一致する", async () => {
      const board = await readSellerBoard(db, false);
      const { rows } = await readSellerExport(db);
      const n = countSellerExportOutcomes(rows);
      assert.equal(rows.length, board.totals.listings);
      assert.deepEqual(
        [n.delivered, n.pending, n.seller, n.vet402, n.unsorted, n.not_bought, n.not_tried],
        [board.totals.delivered, board.totals.pending, board.totals.seller, board.totals.vet402, board.totals.unsorted, board.totals.notPaid, board.totals.notTried],
      );
      assert.equal(rows.find((r) => r.endpoint_id === a3)!.outcome, "not_tried");
      // a1 の最新は 1 時間前の settle_claimed（照合待ち）
      assert.equal(rows.find((r) => r.endpoint_id === a1)!.outcome, "pending");
      assert.match(rows.find((r) => r.endpoint_id === a1)!.purchase_id, /^[0-9a-f-]{36}$/);
      assert.ok(!rows.some((r) => r.endpoint_id === gone || r.endpoint_id === celo), "Base の掲載中の出品だけ");
    });

    await t.test("L0 の export: 数えると state の L0 の件数と一致し、mainnet の表は名前の無い id を外す", async () => {
      const stats = await getObservatoryStats();
      const read = (await readL0Export())!;
      const rows = read.rows;
      assert.equal(rows.length, stats.totalEndpoints);
      const pass = rows.filter((r) => r.published_verdict === "pass");
      assert.equal(pass.length, stats.publishedPass);
      assert.equal(pass.filter((r) => r.listed === "true").length, stats.publishedPassActive);
      assert.equal(
        pass.filter((r) => r.listed === "true" && r.latest_probe_older_than_7d === "true").length,
        stats.publishedPassActiveProbeOlderThan7d,
      );
      assert.equal(rows.filter((r) => r.published_verdict === "fail").length, stats.publishedFail);

      const byChain = await getObservatoryStatsByChain();
      const scope = await getChainScope();
      assert.ok(!byChain.some((c) => c.chain === "Celo Sepolia" || c.chain === "eip155:987654321"), "mainnet の表に入れない");
      assert.equal(scope.testnetEndpoints, 1);
      assert.deepEqual(scope.unclassified, [{ network: "eip155:987654321", totalEndpoints: 1 }]);
      const sum = byChain.reduce((a, c) => a + c.totalEndpoints, 0);
      assert.equal(sum + scope.testnetEndpoints + scope.unclassified.reduce((a, u) => a + u.totalEndpoints, 0), stats.totalEndpoints);
      const mainnetRows = rows.filter((r) => r.network_class === "mainnet");
      assert.equal(mainnetRows.length, sum);
    });

    await t.test("照合待ち: 件数・1 日と 7 日より古い行・一番古い試行", async () => {
      const stats = await getObservatoryStats();
      assert.equal(stats.l1.awaitingReread, 2);
      assert.equal(stats.l1.awaitingRereadOlderThan1d, 1);
      assert.equal(stats.l1.awaitingRereadOlderThan7d, 1);
      assert.equal(stats.l1.awaitingRereadOldestAttemptAt, "2026-09-12T12:07:55Z");
    });
  });
}
