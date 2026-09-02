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

// 2026-09-02 監査 A1（オーナー決定）: 未置換パスパラメータの URL は外向き要求を出さず、
// unverified(path_template) の行を残す。C1 の日次枠には入れない。
if (TEST_DB) {
  test("path-template endpoint: no outbound request, an unverified/path_template row, excluded from tier c1", async (t) => {
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { randomUUID } = await import("node:crypto");

    const db = getDb()!;
    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`,
    );
    const id = randomUUID();
    await db.insert(schema.x402Endpoints).values({
      id,
      resourceKey: "GET https://ph.example/v1/entreprise/:siren",
      resourceUrl: "https://ph.example/v1/entreprise/:siren",
      method: "GET",
      priceAmount: "3000",
      payTo: "0x00000000000000000000000000000000000000ph",
      network: "eip155:8453",
      status: "active",
      lastSeenAt: new Date(),
    });
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return new Response("{}", { status: 402 });
    };

    await t.test("tier c1 skips it entirely (no daily slot spent)", async () => {
      const summary = await runL0ProbeBatch({ limit: 10, fetchImpl, tier: "c1" });
      assert.equal(summary.probed, 0);
      assert.equal(seen.length, 0);
    });

    await t.test("tier all writes the row without sending a request", async () => {
      const summary = await runL0ProbeBatch({ limit: 10, fetchImpl, tier: "all" });
      assert.equal(summary.probed, 1);
      assert.equal(summary.unverified, 1);
      assert.equal(seen.length, 0, "テンプレート URL に外向き HTTP を送っている");
      const rows = await db.select().from(schema.x402L0Probes);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].verdict, "unverified");
      assert.equal(rows[0].failReason, "path_template");
      assert.equal(rows[0].httpStatus, null);
    });
  });
}

// 2026-09-02 是正 B: C1 の選定順。単発 fail（公開判定が出せない）→ 未測定 → 最終プローブが古い順。
if (TEST_DB) {
  test("tier c1 order: single-fail first, then never-probed, then oldest last probe", async (t) => {
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { randomUUID } = await import("node:crypto");
    const db = getDb()!;
    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`,
    );
    const day = 86_400_000;
    const mk = async (name: string) => {
      const id = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id,
        resourceKey: `GET https://${name}.example/api`,
        resourceUrl: `https://${name}.example/api`,
        method: "GET",
        priceAmount: "1000",
        payTo: "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea",
        network: "eip155:8453",
        status: "active",
        lastSeenAt: new Date(),
        firstSeenAt: new Date(Date.now() - 30 * day),
      });
      return id;
    };
    const probe = (endpointId: string, verdict: "pass" | "fail", agoDays: number) =>
      db.insert(schema.x402L0Probes).values({ endpointId, method: "GET", verdict, probedAt: new Date(Date.now() - agoDays * day) });

    // A: 1 回だけ・最新 fail（昨日）→ 最優先
    // B: 未測定 → 2 番目
    // C: 2 回・最新 pass・3 日前
    // D: 1 回・pass・10 日前（単発でも fail でなければ普通の古い順）
    // E: 2 回・最新 fail・12 日前（2 回目の fail は公開済み。単発ではないので古い順）
    // F: 1 回だけ・最新 fail（5 日前）→ A と同じ組。組の中は古い順なので F が A より先
    const A = await mk("a");
    await mk("b"); // 未測定
    const C = await mk("c");
    const D = await mk("d");
    const E = await mk("e");
    const F = await mk("f");
    await probe(A, "fail", 1);
    await probe(C, "pass", 4);
    await probe(C, "pass", 3);
    await probe(D, "pass", 10);
    await probe(E, "pass", 13);
    await probe(E, "fail", 12);
    await probe(F, "fail", 5);

    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return new Response("{}", { status: 500 });
    };
    const nameOf = (u: string) => /https:\/\/(\w)\.example/.exec(u)![1];

    await t.test("limit 2 → 単発 fail の F, A（古い順）だけ", async () => {
      await runL0ProbeBatch({ limit: 2, concurrency: 1, fetchImpl, tier: "c1" });
      assert.deepEqual(seen.map(nameOf), ["f", "a"]);
    });

    await t.test("残りは 未測定 B → 12 日前の E → 10 日前の D → 3 日前の C", async () => {
      await db.execute(sql`DELETE FROM x402_l0_probes WHERE probed_at > now() - interval '1 hour'`);
      seen.length = 0;
      await runL0ProbeBatch({ limit: 6, concurrency: 1, fetchImpl, tier: "c1" });
      assert.deepEqual(seen.map(nameOf), ["f", "a", "b", "e", "d", "c"]);
    });
  });
}
