// C1 の残り枠では、circle_discovery の未測定だけを 1/3 までにし、超えた分は測定済みの後ろへ下げる。
// CDP の未測定と、1 回失敗の組は上限の外。
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("circle unprobed cap (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("C1 は circle の未測定を残り枠の 1/3 までにし、CDP の未測定は組 2 のまま", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { l0OrderBy } = await import("@/lib/observatory/coverage");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_delisting_events`);
    const inserted = await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, source, status, first_seen_at)
      VALUES
        ('cap.example/cdp-new', 'https://cap.example/cdp-new', 'cdp_bazaar', 'active', '2026-01-01'),
        ('cap.example/cdp-old', 'https://cap.example/cdp-old', 'cdp_bazaar', 'active', '2026-01-02'),
        ('cap.example/circle-fail', 'https://cap.example/circle-fail', 'circle_discovery', 'active', '2026-01-03'),
        ('cap.example/circle-1', 'https://cap.example/circle-1', 'circle_discovery', 'active', '2026-02-01'),
        ('cap.example/circle-2', 'https://cap.example/circle-2', 'circle_discovery', 'active', '2026-02-02'),
        ('cap.example/circle-3', 'https://cap.example/circle-3', 'circle_discovery', 'active', '2026-02-03')
      RETURNING id, resource_url
    `);
    const rows = (Array.isArray(inserted) ? inserted : ((inserted as unknown as { rows?: { id: string; resource_url: string }[] }).rows ?? [])) as {
      id: string;
      resource_url: string;
    }[];
    const idOf = (url: string) => rows.find((r) => r.resource_url === url)!.id;
    await db.execute(sql`
      INSERT INTO x402_l0_probes (endpoint_id, probed_at, method, verdict, fail_reason)
      VALUES
        (${idOf("https://cap.example/cdp-old")}::uuid, '2026-03-01', 'GET', 'pass', null),
        (${idOf("https://cap.example/circle-fail")}::uuid, '2026-03-02', 'GET', 'fail', 'no_402')
    `);
    const ordered = await db.execute(sql`
      SELECT e.resource_url
      FROM x402_endpoints e
      LEFT JOIN LATERAL (
        SELECT max(p.probed_at) AS last_probed_at,
               count(*)::int AS probe_count,
               (SELECT p2.verdict FROM x402_l0_probes p2 WHERE p2.endpoint_id = e.id ORDER BY p2.probed_at DESC LIMIT 1) AS last_verdict,
               false AS rule_change_reprobe
        FROM x402_l0_probes p WHERE p.endpoint_id = e.id
      ) lp ON true
      WHERE e.resource_url LIKE 'https://cap.example/%'
      ORDER BY ${l0OrderBy("c1", 1)}
    `);
    const urls = ((Array.isArray(ordered) ? ordered : ((ordered as unknown as { rows?: { resource_url: string }[] }).rows ?? [])) as { resource_url: string }[]).map(
      (r) => r.resource_url,
    );
    assert.deepEqual(urls, [
      "https://cap.example/circle-fail",
      "https://cap.example/cdp-new",
      "https://cap.example/circle-1",
      "https://cap.example/cdp-old",
      "https://cap.example/circle-2",
      "https://cap.example/circle-3",
    ]);
  });
}
