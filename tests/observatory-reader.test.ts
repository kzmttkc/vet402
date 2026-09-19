// ============================================================
// vet402 Observatory L0 — reader integration (design §5, §7).
//
// DB-backed: the property under test is that the PUBLIC surfaces apply the
// same publication gate as publishedVerdict() — one fail renders as
// unverified everywhere (list, detail, stats) — and that empty/missing
// schema degrades to an honest empty state.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("observatory reader (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  test("observatory readers agree with the publication gate", async (t) => {
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { getObservatoryOverview, getEndpointDetail, getObservatoryStats } = await import(
      "@/lib/observatory/reader"
    );
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");

    const db = getDb()!;
    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_l1_purchases`,
    );

    // 3 endpoints: one healthy, one that will fail twice, one undeclared.
    const items = [
      parseCatalogItem({
        resource: "https://healthy.example/api",
        accepts: [{ amount: "1000", asset: "0xUSDC", network: "eip155:8453", payTo: "0xAA" }],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        quality: { l30DaysTotalCalls: 900 },
      }),
      parseCatalogItem({
        resource: "https://dead.example/api",
        accepts: [{ amount: "1000", asset: "0xUSDC", network: "eip155:8453", payTo: "0xBB" }],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        quality: { l30DaysTotalCalls: 400 },
      }),
      parseCatalogItem({
        resource: "https://nodecl.example/api",
        accepts: [{ amount: "1000", asset: "0xUSDC", network: "eip155:8453", payTo: "0xCC" }],
      }),
    ];
    await syncCatalog({
      fetchResult: { items, totalCount: 3, fetchedCount: 3, complete: true },
      today: "2026-08-14",
    });

    const challenge = JSON.stringify({
      x402Version: 2,
      accepts: [{ amount: "1000", asset: "0xUSDC", network: "eip155:8453", payTo: "0xAA" }],
    });
    const fetchImpl = async (url: string) => {
      if (url.includes("healthy")) {
        return new Response(challenge, {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("gone", { status: 404 });
    };

    await t.test("after ONE probe round a failing endpoint publishes as unverified", async () => {
      await runL0ProbeBatch({ limit: 10, concurrency: 2, fetchImpl });
      const overview = await getObservatoryOverview();
      const dead = overview.rows.find((r) => r.resourceKey === "dead.example/api")!;
      assert.equal(dead.publishedVerdict, "unverified", "single fail must not publish as fail");
      const healthy = overview.rows.find((r) => r.resourceKey === "healthy.example/api")!;
      assert.equal(healthy.publishedVerdict, "pass");
    });

    await t.test("after a SECOND failing round the fail is publishable everywhere", async () => {
      await runL0ProbeBatch({ limit: 10, concurrency: 2, fetchImpl });
      const overview = await getObservatoryOverview();
      const dead = overview.rows.find((r) => r.resourceKey === "dead.example/api")!;
      assert.equal(dead.publishedVerdict, "fail");

      const detail = await getEndpointDetail(dead.id);
      assert.ok(detail);
      assert.equal(detail!.publishedVerdict, "fail");
      assert.equal(detail!.probes.length, 2);
      assert.equal(detail!.probes[0].failReason, "no_402");

      const stats = await getObservatoryStats();
      assert.equal(stats.totalEndpoints, 3);
      // 2026-09-02 製品定義書 §6.1: method 未宣言（nodecl）は GET で測る。この fake は
      // healthy 以外に 404 を返すので、nodecl も 2 回 fail → 公開 fail が 2 件になる
      // （以前は無送信で unverified だった）。methodUndeclared はカタログ側の事実なので 1 のまま。
      assert.equal(stats.publishedFail, 2);
      assert.equal(stats.publishedPass, 1);
      assert.equal(stats.publishedUnverified, 0);
      assert.equal(stats.methodUndeclared, 1);
    });

    await t.test("L1 purchase history surfaces on detail and stats with the receipt", async () => {
      const overview = await getObservatoryOverview();
      const healthy = overview.rows.find((r) => r.resourceKey === "healthy.example/api")!;
      await db.insert(schema.x402L1Purchases).values([
        {
          endpointId: healthy.id,
          status: "settled",
          amountUnits: "3000",
          spentUnits: "3000",
          txHash: "0xfeed",
          httpStatusPaid: 200,
          latencyMs: 420,
          payloadNonEmpty: true,
        },
        {
          endpointId: healthy.id,
          status: "settle_failed",
          amountUnits: "3000",
          spentUnits: "3000",
          latencyMs: 900,
        },
      ]);
      const detail = await getEndpointDetail(healthy.id);
      assert.ok(detail);
      assert.equal(detail!.l1.attempts, 2);
      assert.equal(detail!.l1.settled, 1);
      assert.equal(detail!.purchases.length, 2);
      assert.equal(detail!.purchases.some((p) => p.txHash === "0xfeed"), true);

      const stats = await getObservatoryStats();
      assert.equal(stats.l1.attempts, 2);
      assert.equal(stats.l1.settled, 1);
      assert.equal(stats.l1.endpointsAttempted, 1);
    });

    // 2026-09-02 導線監査 F2: 受領証つき 520 本がどれか、一覧から分からなかった。
    // 行に L1 の settled/attempts を載せ、受領証あり → 測定済み → 呼出量の順に並べ、?l1=1 で絞る。
    await t.test("overview rows carry L1 settled/attempts and receipts sort first", async () => {
      const before = await getObservatoryOverview();
      const nodecl = before.rows.find((r) => r.resourceKey === "nodecl.example/api")!;
      await db.insert(schema.x402L1Purchases).values([
        { endpointId: nodecl.id, status: "settled", amountUnits: "3000", spentUnits: "3000", txHash: "0xbeef", httpStatusPaid: 200, latencyMs: 300, payloadNonEmpty: true },
        // budget_denied は払っていないので attempts に入らない
        { endpointId: nodecl.id, status: "budget_denied", amountUnits: "3000" },
      ]);
      const overview = await getObservatoryOverview();
      assert.deepEqual(
        overview.rows.map((r) => r.resourceKey),
        ["healthy.example/api", "nodecl.example/api", "dead.example/api"],
        "receipts (settled ≥ 1) first, then measured, then by call volume",
      );
      const healthy = overview.rows[0];
      assert.equal(healthy.l1Settled, 1);
      assert.equal(healthy.l1Attempts, 2);
      assert.equal(overview.rows[1].l1Settled, 1);
      assert.equal(overview.rows[1].l1Attempts, 1);
      assert.equal(overview.rows[2].l1Settled, 0);
      assert.equal(overview.rows[2].l1Attempts, 0);
    });

    await t.test("l1: true keeps only endpoints with at least one receipt", async () => {
      const overview = await getObservatoryOverview({ l1: true });
      assert.equal(overview.totalEndpoints, 2);
      assert.deepEqual(
        overview.rows.map((r) => r.resourceKey),
        ["healthy.example/api", "nodecl.example/api"],
      );
    });

    await t.test("detail rejects non-uuid ids without touching the DB", async () => {
      assert.equal(await getEndpointDetail("not-a-uuid"), null);
      assert.equal(await getEndpointDetail("../../etc/passwd"), null);
    });

    await t.test("overview is ordered by observed call volume (denominator visible)", async () => {
      const overview = await getObservatoryOverview();
      assert.equal(overview.rows[0].resourceKey, "healthy.example/api");
      assert.equal(overview.totalEndpoints, 3);
      assert.ok(overview.latestSnapshot);
      assert.equal(overview.latestSnapshot!.fetchedCount, 3);
    });
  });

  test("observatory marks and excludes vet402's own endpoint (self-neutrality)", async (t) => {
    const { getEndpointDetail, getObservatoryStats, getObservatoryStatsByChain } = await import("@/lib/observatory/reader");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");

    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_l1_purchases`);

    const SELF = `0x${"e".repeat(40)}`;
    const savedSelf = process.env.VET402_OPERATOR_PAYTO;
    t.after(() => {
      if (savedSelf === undefined) delete process.env.VET402_OPERATOR_PAYTO;
      else process.env.VET402_OPERATOR_PAYTO = savedSelf;
    });
    process.env.VET402_OPERATOR_PAYTO = SELF;

    const [own] = await db
      .insert(schema.x402Endpoints)
      .values({ resourceKey: "self.vet402.example/score", resourceUrl: "https://self.vet402.example/score", payTo: SELF, status: "active", network: "eip155:8453" })
      .returning();
    await db
      .insert(schema.x402Endpoints)
      .values({ resourceKey: "third.example/api", resourceUrl: "https://third.example/api", payTo: `0x${"7".repeat(40)}`, status: "active", network: "eip155:8453" });

    await t.test("the operator's own endpoint is flagged on its detail page", async () => {
      const detail = await getEndpointDetail(own.id);
      assert.ok(detail);
      assert.equal(detail!.endpoint.isOperatorEndpoint, true);
    });

    await t.test("the aggregate excludes the operator endpoint (2 seeded → 1 counted)", async () => {
      const stats = await getObservatoryStats();
      assert.equal(stats.totalEndpoints, 1, "only the third-party endpoint counts toward the network total");
    });

    // 2026-09-19 独立レビュー W1: §1 の総数だけが自社を外し、チェーン別の表は外して
    // いなかった。同じ頁の 2 表が別の母集団を数えていたので、/observatory/state §2 の
    // 「§1 との差はテストネットだけ」という注記も厳密には偽になっていた。
    await t.test("the per-chain table excludes it too, so both tables count one population", async () => {
      const byChain = await getObservatoryStatsByChain();
      const total = byChain.reduce((n, c) => n + c.totalEndpoints, 0);
      assert.equal(total, 1, "the operator's own endpoint must not pad the per-chain table either");
      const stats = await getObservatoryStats();
      assert.equal(total, stats.totalEndpoints, "§1 and §2 must count the same population (no testnets seeded here)");
    });

    // 2026-09-19 再レビュー V1: 同じ述語が 4 つ目の読み取り（coverage7d）に無く、母集団が
    // もう 1 つ残っていた。除外は operator-sql.ts の 1 本を全員が通る。
    await t.test("coverage7d counts the same population as the headline total", async () => {
      const { getCoverageShare } = await import("@/lib/observatory/reader");
      const coverage = await getCoverageShare();
      assert.equal(coverage.activeEndpoints, 1, "the operator's own active endpoint must not pad the coverage denominator");
    });

    // 2026-09-19 再レビュー V2: 「自社を外している」を文で保証しない。除外が今日
    // 何件取り除いたかを出す（0 は「効いていない」ではなく「取り除く行が無かった」）。
    await t.test("the aggregate publishes how many rows the exclusion actually removed", async () => {
      const stats = await getObservatoryStats();
      assert.equal(stats.operatorEndpointsExcluded, 1, "one seeded endpoint pays the operator address");
      assert.equal(stats.operatorExclusionConfigured, true, "the denylist is set in this test");
    });

    // 2026-09-19 最終確認 H3: 件数 0 は「一致が無かった」と「名簿が空＝規則が no-op」を
    // 区別できない。真偽で分ける。**アドレスそのものは出さない。**
    await t.test("an empty denylist reads as unconfigured, not as a clean zero", async () => {
      const saved = process.env.VET402_OPERATOR_PAYTO;
      process.env.VET402_OPERATOR_PAYTO = "";
      try {
        const stats = await getObservatoryStats();
        assert.equal(stats.operatorExclusionConfigured, false);
        assert.equal(stats.operatorEndpointsExcluded, 0, "空の名簿では一致 0 件——件数だけでは見分けられない");
        assert.equal(stats.totalEndpoints, 2, "除外が no-op なので自社の endpoint も数に入る");
      } finally {
        if (saved === undefined) delete process.env.VET402_OPERATOR_PAYTO;
        else process.env.VET402_OPERATOR_PAYTO = saved;
      }
    });

    // 2026-09-19 最終確認 Note: 母集団の 5 つ目（/api/v1/accuracy の coverageWeekly）にも
    // 同じ述語を通した。
    await t.test("coverageWeekly counts the same population", async () => {
      const { getCoverageWeekly } = await import("@/lib/observatory/coverage-report");
      const before = await getCoverageWeekly();
      assert.equal(before.listed, 1, "the operator's own endpoint must not pad the weekly coverage denominator");
      const saved = process.env.VET402_OPERATOR_PAYTO;
      process.env.VET402_OPERATOR_PAYTO = "";
      try {
        const unconfigured = await getCoverageWeekly();
        assert.equal(unconfigured.listed, 2, "名簿が空なら除外は no-op——同じ述語を通っている証拠");
      } finally {
        if (saved === undefined) delete process.env.VET402_OPERATOR_PAYTO;
        else process.env.VET402_OPERATOR_PAYTO = saved;
      }
    });
  });

  // 2026-09-19 公開面監査 B1: snapshot は (snapshot_date, source) の複合キーで、毎日
  // Bazaar と mpp_directory の 2 行が書かれる。latestSnapshot が日付だけで並べて
  // LIMIT 1 していたため、本番では MPP ディレクトリ側の行（1,065/1,071 = 取得不完全）が
  // 返り、29,337 件の表の見出しに「figures provisional」が付いていた。
  test("latestSnapshot names the primary catalog, not whichever source sorts first", async (t) => {
    const { getObservatoryStats, getObservatoryOverview } = await import("@/lib/observatory/reader");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { CATALOG_SOURCE } = await import("@/lib/observatory/catalog-source");
    const { MPP_DIRECTORY_SOURCE } = await import("@/lib/observatory/mpp-payer");

    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_l1_purchases`);

    // 同じ日付の 2 行。MPP 側だけ取得が不完全。
    await db.insert(schema.x402CatalogSnapshots).values([
      { snapshotDate: "2026-09-19", source: CATALOG_SOURCE, totalCount: 28_272, fetchedCount: 28_272, resourceKeys: [] },
      { snapshotDate: "2026-09-19", source: MPP_DIRECTORY_SOURCE, totalCount: 1_071, fetchedCount: 1_065, resourceKeys: [] },
    ]);

    await t.test("the primary row wins the tie and carries its own fetch health", async () => {
      const stats = await getObservatoryStats();
      assert.ok(stats.latestSnapshot);
      assert.equal(stats.latestSnapshot!.source, CATALOG_SOURCE);
      assert.equal(stats.latestSnapshot!.fetchedCount, 28_272);
      assert.ok(
        stats.latestSnapshot!.fetchedCount >= stats.latestSnapshot!.totalCount,
        "the MPP row's incomplete fetch must not attach to the primary catalog's figures",
      );
    });

    await t.test("every catalog's latest snapshot is published separately", async () => {
      const stats = await getObservatoryStats();
      assert.deepEqual(
        stats.catalogSnapshots.map((s) => [s.source, s.fetchedCount, s.totalCount]),
        [
          [CATALOG_SOURCE, 28_272, 28_272],
          [MPP_DIRECTORY_SOURCE, 1_065, 1_071],
        ],
      );
    });

    await t.test("the register page's snapshot line is fixed the same way", async () => {
      const overview = await getObservatoryOverview();
      assert.ok(overview.latestSnapshot);
      assert.equal(overview.latestSnapshot!.fetchedCount, 28_272);
    });
  });
}
