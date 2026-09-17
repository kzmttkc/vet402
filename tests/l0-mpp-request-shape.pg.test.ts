// ============================================================
// L0 ランナー × MPP の request_shape と雛形（2026-09-17/18・L0 の公平）。
//
// 守ること:
//  1. `:rest*` の雛形は要求を出さず unverified(path_template)。
//  2. mpp_directory の challenge 無しの 400 は unverified(request_shape)。**1 endpoint 1 要求**——
//     再試行も OpenAPI の取得もしない（directory が apiReference を載せていても、400 が Link を出しても）。
//  3. 同じ endpoint を次のバッチで測り直しても、やはり 1 要求。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_fairness_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l0-mpp-request-shape.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l0 mpp request shape (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;
  const USDC_E = "0x20c000000000000000000000b9537d11c60e8b50";

  test("L0 on the MPP directory: templates are not probed, a 400 without a challenge is unverified after one request", async () => {
    const { syncMppDirectory, parseMppDirectory } = await import("@/lib/observatory/mpp-directory");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const rows = <T,>(raw: unknown) => [...((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[])];
    const pay = (amount: string) => ({ intent: "charge", method: "tempo", currency: USDC_E, decimals: 6, amount });
    const directory = {
      services: [
        { id: "govlaws", serviceUrl: "https://govlaws.example", realm: "govlaws.example", docs: { apiReference: "https://govlaws.example/openapi.json" }, endpoints: [{ method: "POST", path: "/api/mpp/search", payment: pay("30000") }] },
        { id: "flightapi", serviceUrl: "https://flightapi.example", realm: "flightapi.example", endpoints: [{ method: "GET", path: "/airline/:rest*", payment: pay("2000") }] },
      ],
    };
    await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`);
    const parsed = parseMppDirectory(directory);
    await syncMppDirectory({ fetchResult: { items: parsed.items, totalCount: parsed.endpointCount, fetchedCount: parsed.items.length, complete: true }, today: "2026-09-18" });

    const seen: { url: string; body: string | null }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen.push({ url, body: typeof init?.body === "string" ? init.body : null });
      return new Response('{"error":"invalid_query"}', { status: 400, headers: { "content-type": "application/json", link: '</openapi.json>; rel="service-desc"' } });
    };
    await runL0ProbeBatch({ limit: 10, concurrency: 2, fetchImpl });
    await runL0ProbeBatch({ limit: 10, concurrency: 2, fetchImpl });

    assert.deepEqual(
      seen.map((s) => `${s.url} ${s.body}`),
      ["https://govlaws.example/api/mpp/search {}", "https://govlaws.example/api/mpp/search {}"],
      "two batches → two requests to the one probe-able endpoint, `{}` each; nothing to the template, no OpenAPI fetch",
    );
    const probes = rows<{ resource_url: string; verdict: string; fail_reason: string | null; http_status: number | null; n: number }>(
      await db.execute(sql`
        SELECT e.resource_url, p.verdict, p.fail_reason, p.http_status, count(*) OVER (PARTITION BY e.id)::int AS n
        FROM x402_l0_probes p JOIN x402_endpoints e ON e.id = p.endpoint_id ORDER BY e.resource_url`),
    );
    const search = probes.filter((p) => p.resource_url.endsWith("/search"));
    assert.equal(search.length, 2);
    assert.ok(search.every((p) => p.verdict === "unverified" && p.fail_reason === "request_shape" && p.http_status === 400));
    const tpl = probes.filter((p) => p.resource_url.endsWith(":rest*"));
    assert.ok(tpl.length >= 1 && tpl.every((p) => p.verdict === "unverified" && p.fail_reason === "path_template"));
  });
}
