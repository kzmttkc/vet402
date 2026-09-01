// ============================================================
// vet402 Observatory L0 — rolling probe runner integration (design §4).
//
// DB-backed because the property under test is the ROLLING ORDER: each batch
// must take the endpoints whose last probe is oldest (never-probed first), so
// the whole catalog cycles even though one cron firing can't cover it.
// Gated behind TEST_DATABASE_URL like observatory-sync.test.ts.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("observatory probe runner (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  test("rolling probe batches cycle through the catalog oldest-first", async (t) => {
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");

    const db = getDb()!;
    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`,
    );

    // Seed 5 endpoints: 4 GET-declared, 1 undeclared method.
    const items = [1, 2, 3, 4].map((n) =>
      parseCatalogItem({
        resource: `https://svc${n}.example/api`,
        accepts: [{ amount: "1000", asset: "0xUSDC", network: "eip155:8453", payTo: `0xPAY${n}` }],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
      }),
    );
    items.push(
      parseCatalogItem({
        resource: "https://nodecl.example/api",
        accepts: [{ amount: "1000", asset: "0xUSDC", network: "eip155:8453", payTo: "0xPAY9" }],
      }),
    );
    await syncCatalog({
      fetchResult: { items, totalCount: 5, fetchedCount: 5, complete: true },
      today: "2026-08-14",
    });

    const challenge = (payTo: string) =>
      JSON.stringify({
        x402Version: 2,
        accepts: [{ amount: "1000", asset: "0xUSDC", network: "eip155:8453", payTo }],
      });
    const probedUrls: string[] = [];
    const fetchImpl = async (url: string) => {
      probedUrls.push(url);
      const n = /svc(\d)/.exec(url)?.[1] ?? "9";
      return new Response(challenge(`0xPAY${n}`), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    };

    await t.test("batch 1 (limit 3) probes 3 endpoints and records verdicts", async () => {
      const summary = await runL0ProbeBatch({ limit: 3, concurrency: 2, fetchImpl });
      assert.equal(summary.probed, 3);
      const rows = await db.select().from(schema.x402L0Probes);
      assert.equal(rows.length, 3);
    });

    await t.test("batch 2 reaches the endpoints batch 1 did not touch", async () => {
      const before = probedUrls.length;
      const summary = await runL0ProbeBatch({ limit: 3, concurrency: 2, fetchImpl });
      assert.equal(summary.probed, 3);
      // 5 endpoints total; the 2 untouched ones must be in this batch.
      const batch2 = probedUrls.slice(before);
      const batch1 = new Set(probedUrls.slice(0, before));
      const fresh = batch2.filter((u) => !batch1.has(u));
      // undeclared-method endpoint sends no request, so URLs alone undercount;
      // assert via DB: every endpoint now has at least one probe row.
      const counts = await db.execute(sql`
        SELECT count(DISTINCT endpoint_id)::int AS n FROM x402_l0_probes
      `);
      const list = Array.isArray(counts) ? counts : (counts as { rows?: unknown[] }).rows ?? [];
      assert.equal((list as { n: number }[])[0].n, 5, "all 5 endpoints probed after two batches");
      assert.ok(fresh.length >= 1);
    });

    // 2026-09-02 製品定義書 §6.1: 宣言の無い Resource は GET で測る（以前は無送信で
    // unverified）。行は普通の測定行として残り、method 列に GET が記録される。
    await t.test("undeclared-method endpoint is probed with GET (§6.1) and gets a measured row", async () => {
      const rows = await db.select().from(schema.x402L0Probes);
      assert.equal(rows.filter((r) => r.failReason === "method_undeclared").length, 0);
      assert.ok(probedUrls.some((u) => u.includes("nodecl.example")));
      const nodecl = rows.find((r) => r.method === "GET" && r.verdict === "pass");
      assert.ok(nodecl, "GET で測った pass 行がある");
    });

    await t.test("pass rows carry the evidence fields", async () => {
      const rows = await db.select().from(schema.x402L0Probes);
      const passes = rows.filter((r) => r.verdict === "pass");
      assert.ok(passes.length >= 4);
      for (const p of passes) {
        assert.equal(p.httpStatus, 402);
        assert.equal(p.has402Challenge, true);
        assert.equal(p.priceConsistent, true);
        assert.equal(p.metadataConsistent, true);
      }
    });
  });
}
