// ============================================================
// ② find_x402_sellers を v1 に載せる線（2026-10-28・要件書 v3 §2.2）: 本番と同じ件数規模の fixture で p95 1.5 秒。
//
// 件数は本番の実測（2026-10-27 06:17Z・読むだけの SELECT）に合わせる:
//   x402_endpoints 121,299 行（うち active 80,867）、x402_l1_purchases 19,420 行（うち直近 30 日 9,441）。
// 説明文は 60〜260 字。query は当たりの多い語・少ない語・当たらない語を混ぜ、tool の本体（findSellers）ごと測る。
// 線を割ったら、src/lib/mcp/tools.ts の FIND_TOOL_ENABLED を false にして ① と ③ だけで出す。
//
// Run: TEST_DATABASE_URL=postgres://takeshi@localhost:5432/vet402_test_mcp \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/mcp-find-p95.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

export const PROD_ENDPOINTS = 121_299;
export const PROD_ACTIVE = 80_867;
export const PROD_PURCHASES = 19_420;
export const PROD_PURCHASES_30D = 9_441;
const P95_LIMIT_MS = 1_500;

if (!TEST_DB) {
  test("mcp find p95 (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("② find_x402_sellers: 本番規模の fixture で p95 1.5 秒以内", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { readFindSellers } = await import("@/lib/mcp/reads");
    const { findSellers, FIND_TOOL_ENABLED } = await import("@/lib/mcp/tools");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);

    const t0 = Date.now();
    // 単語の表から説明文を作る（weather は約 1%、search は約 8%）
    await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, source, method, network, pay_to, price_amount, description, status, canonical_url, last_seen_at)
      SELECT 'host' || (n % 9000) || '.example/api/v' || (n % 7) || '/r' || n,
             'https://host' || (n % 9000) || '.example/api/v' || (n % 7) || '/r' || n,
             CASE WHEN n % 3 = 0 THEN 'circle_discovery' ELSE 'cdp_bazaar' END,
             CASE WHEN n % 5 = 0 THEN 'POST' ELSE 'GET' END,
             CASE WHEN n % 10 < 7 THEN 'eip155:8453' WHEN n % 10 < 9 THEN 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' ELSE 'eip155:5042' END,
             '0x' || lpad(to_hex(n), 40, '0'),
             (1000 * (1 + n % 50))::text,
             CASE WHEN n % 100 = 0 THEN 'Weather forecast and history for any city. ' ELSE '' END ||
             CASE WHEN n % 12 = 0 THEN 'Search the web and return ranked results. ' ELSE '' END ||
             'Paid API for agents with x402 payments. Returns JSON with fields for price, volume, news and data quality. ' ||
             repeat('Lorem ipsum dolor sit amet. ', (n % 6)),
             CASE WHEN n <= ${PROD_ACTIVE} THEN 'active' ELSE 'delisted' END,
             'https://host' || (n % 9000) || '.example/api/v' || (n % 7) || '/r' || n,
             now() - (n % 30) * interval '1 day'
      FROM generate_series(1, ${PROD_ENDPOINTS}) n`);
    // 購入: 直近 30 日に 9,441 行、それより前に残り。出品は掲載中から散らす。届いた（settled・200）は約 55%
    await db.execute(sql`
      WITH ids AS (SELECT id, row_number() OVER (ORDER BY id) AS rn FROM x402_endpoints WHERE status = 'active')
      INSERT INTO x402_l1_purchases (endpoint_id, attempted_at, status, network, http_status_paid, payload_non_empty, tx_hash, spent_units, amount_units)
      SELECT ids.id,
             CASE WHEN g.n <= ${PROD_PURCHASES_30D} THEN now() - (g.n % 29) * interval '1 day' - (g.n % 1440) * interval '1 minute'
                  ELSE now() - (31 + g.n % 60) * interval '1 day' END,
             CASE WHEN g.n % 20 < 11 THEN 'settled' WHEN g.n % 20 < 15 THEN 'settle_failed' WHEN g.n % 20 < 18 THEN 'no_402' ELSE 'over_cap' END,
             'eip155:8453',
             CASE WHEN g.n % 20 < 11 THEN 200 WHEN g.n % 20 < 15 THEN 500 ELSE NULL END,
             CASE WHEN g.n % 20 < 11 THEN true ELSE NULL END,
             CASE WHEN g.n % 20 < 15 THEN '0x' || lpad(to_hex(g.n), 64, '0') ELSE NULL END,
             '0', '1000'
      FROM generate_series(1, ${PROD_PURCHASES}) g(n)
      JOIN ids ON ids.rn = 1 + ((g.n * 7919) % ${PROD_ACTIVE})`);
    await db.execute(sql`ANALYZE x402_endpoints`);
    await db.execute(sql`ANALYZE x402_l1_purchases`);
    const counts = (await db.execute(sql`
      SELECT (SELECT count(*) FROM x402_endpoints)::int AS e,
             (SELECT count(*) FROM x402_endpoints WHERE status = 'active')::int AS a,
             (SELECT count(*) FROM x402_l1_purchases)::int AS p,
             (SELECT count(*) FROM x402_l1_purchases WHERE attempted_at > now() - interval '30 days')::int AS p30`)) as unknown as
      | { e: number; a: number; p: number; p30: number }[]
      | { rows: { e: number; a: number; p: number; p30: number }[] };
    const c = Array.isArray(counts) ? counts[0] : counts.rows[0];
    assert.deepEqual(c, { e: PROD_ENDPOINTS, a: PROD_ACTIVE, p: PROD_PURCHASES, p30: PROD_PURCHASES_30D });
    const seededMs = Date.now() - t0;

    const deps = { findSellers: (like: string, limit: number) => readFindSellers(db, like, limit) } as unknown as Parameters<typeof findSellers>[0];
    const queries = ["weather", "search", "price", "news", "data quality", "host42", "no-such-word-at-all", "api/v3", "Lorem", "x402"];
    for (const q of queries.slice(0, 3)) await findSellers(deps, { query: q }); // 暖機
    const times: number[] = [];
    for (let round = 0; round < 4; round++) {
      for (const q of queries) {
        const s = performance.now();
        const out = await findSellers(deps, { query: q, limit: 10 });
        times.push(performance.now() - s);
        assert.notEqual(out, "invalid_query");
      }
    }
    times.sort((a, b) => a - b);
    const pick = (p: number) => times[Math.min(times.length - 1, Math.ceil((p / 100) * times.length) - 1)];
    const p50 = pick(50);
    const p95 = pick(95);
    console.log(
      `[mcp-find-p95] seeded ${PROD_ENDPOINTS} endpoints / ${PROD_PURCHASES} purchases in ${seededMs} ms; ` +
        `n=${times.length} p50=${p50.toFixed(1)} ms p95=${p95.toFixed(1)} ms max=${times[times.length - 1].toFixed(1)} ms`,
    );
    const w = await findSellers(deps, { query: "weather" });
    assert.ok(w !== "invalid_query" && w.sellers.every((s) => s.delivered_30d >= 1));
    if (FIND_TOOL_ENABLED) assert.ok(p95 <= P95_LIMIT_MS, `p95 ${p95.toFixed(1)} ms が ${P95_LIMIT_MS} ms を超えた。FIND_TOOL_ENABLED を false にする`);
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases`);
  });
}
