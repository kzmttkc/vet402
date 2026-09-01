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
    const { getEndpointDetail, getObservatoryStats } = await import("@/lib/observatory/reader");
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
      .values({ resourceKey: "self.vet402.example/score", resourceUrl: "https://self.vet402.example/score", payTo: SELF, status: "active" })
      .returning();
    await db
      .insert(schema.x402Endpoints)
      .values({ resourceKey: "third.example/api", resourceUrl: "https://third.example/api", payTo: `0x${"7".repeat(40)}`, status: "active" });

    await t.test("the operator's own endpoint is flagged on its detail page", async () => {
      const detail = await getEndpointDetail(own.id);
      assert.ok(detail);
      assert.equal(detail!.endpoint.isOperatorEndpoint, true);
    });

    await t.test("the aggregate excludes the operator endpoint (2 seeded → 1 counted)", async () => {
      const stats = await getObservatoryStats();
      assert.equal(stats.totalEndpoints, 1, "only the third-party endpoint counts toward the network total");
    });
  });
}
