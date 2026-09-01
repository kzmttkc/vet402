// ============================================================
// §5: カタログ同期が canonical ID を列に埋める（2026-09-02）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("canonical ids on sync (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  test("canonical ids on sync", async (t) => {
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { resourceId, endpointHash } = await import("@/lib/ids/canonical");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`);

    const items = [
      parseCatalogItem({
        resource: "https://Api.Example.com/v1/quote/?sig=abc&b=2&a=1",
        accepts: [{ amount: "1000", asset: "0xUSDC", network: "base", payTo: "0xAA" }],
        extensions: { bazaar: { info: { input: { method: "POST" } } } },
      }),
      parseCatalogItem({
        resource: "https://sol.example/api/x",
        accepts: [{ amount: "1000", asset: "EPjF", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }],
      }),
    ];
    await syncCatalog({ fetchResult: { items, totalCount: 2, fetchedCount: 2, complete: true }, today: "2026-09-02" });

    await t.test("同期直後に resource_id / endpoint_hash / payee_id / canonical_url が埋まる", async () => {
      const raw = await db.execute(sql`
        SELECT resource_url, method, canonical_url, resource_id, endpoint_hash, payee_id, undeclared_query
        FROM x402_endpoints ORDER BY resource_url
      `);
      const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<string, unknown>[];
      assert.equal(rows.length, 2);
      const evm = rows.find((r) => String(r.resource_url).includes("Example.com"))!;
      assert.equal(evm.canonical_url, "https://api.example.com/v1/quote?a=1&b=2");
      assert.equal(evm.resource_id, resourceId("POST", String(evm.resource_url)));
      assert.equal(evm.endpoint_hash, endpointHash(String(evm.resource_url)));
      assert.equal(evm.payee_id, "eip155:8453:0xaa"); // v1 スラグ base → CAIP-2、EVM は小文字
      assert.deepEqual(evm.undeclared_query, ["sig"]);

      const sol = rows.find((r) => String(r.resource_url).includes("sol.example"))!;
      assert.equal(sol.resource_id, resourceId("GET", String(sol.resource_url))); // method 未宣言は GET
      assert.equal(sol.payee_id, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    });

    await t.test("再同期で ID が変わらない（決定的）", async () => {
      const before = await db.execute(sql`SELECT resource_id FROM x402_endpoints ORDER BY resource_url`);
      await syncCatalog({ fetchResult: { items, totalCount: 2, fetchedCount: 2, complete: true }, today: "2026-09-03" });
      const after = await db.execute(sql`SELECT resource_id FROM x402_endpoints ORDER BY resource_url`);
      assert.deepEqual(after, before);
    });
  });
}
