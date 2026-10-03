// ============================================================
// 出品単位の買い直し（2026-10-03・旗 OBSERVATORY_L1_RETEST_LISTINGS）— readRetestSellers の選び方。
//
// 事故: 売り手単位の retest は売り手の最新の 1 行しか見ないので、同じ売り手の別の出品が後で届いていると、
// こちらの落ち度（財布切れ）で失敗したままの出品が買い直されない（10/03 /sellers: vet402 側 1,384 出品）。
//
// 守ること:
//  1. 旗が無ければ従来どおり（売り手の最新の行が届いている売り手は選ばない）
//  2. 旗があれば、出品ごとの最新の行がこちらの落ち度の出品を持つ売り手を選び、その出品を優先する
//  3. 出品の最新の行が届いていれば（買い直し済み）、もう選ばない
//  4. 売り手側の失敗（期間外の 402）は選ばない
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-retest-listings.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 retest listings (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("listing-level retest picks failed listings behind a later success", async (t) => {
    const { readRetestSellers } = await import("@/lib/observatory/l1-runner");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const rowsOf = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
    const saved = process.env.OBSERVATORY_L1_RETEST_LISTINGS;
    t.after(() => (saved === undefined ? delete process.env.OBSERVATORY_L1_RETEST_LISTINGS : (process.env.OBSERVATORY_L1_RETEST_LISTINGS = saved)));

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);
    const ep = async (key: string) =>
      String(
        rowsOf(
          await db.execute(sql`
            INSERT INTO x402_endpoints (resource_key, resource_url, source, method, network, pay_to, price_amount, price_asset, status)
            VALUES (${key}, ${"https://" + key}, 'cdp_bazaar', 'GET', 'eip155:8453', '0x00000000000000000000000000000000000000a1', '10000',
                    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'active')
            RETURNING id::text AS id`),
        )[0].id,
      );
    const buy = async (endpointId: string, at: string, status: string, http: number | null, tx: string | null) =>
      db.execute(sql`
        INSERT INTO x402_l1_purchases (endpoint_id, attempted_at, status, network, http_status_paid, tx_hash, amount_units)
        VALUES (${endpointId}::uuid, ${at}::timestamptz, ${status}, 'eip155:8453', ${http}, ${tx}, '10000')`);

    // 売り手 a: 出品 a/1 は財布切れの期間に 402（こちらの落ち度）、出品 a/2 はその後に届いた（売り手の最新は成功）
    const a1 = await ep("a.example/1");
    const a2 = await ep("a.example/2");
    await buy(a1, "2026-09-14T03:00:00Z", "settle_failed", 402, null);
    await buy(a2, "2026-09-30T03:00:00Z", "settled", 200, `0x${"a2".repeat(32)}`);
    // 売り手 b: 期間外の 402（売り手側の失敗）。選ばない
    const b1 = await ep("b.example/1");
    await buy(b1, "2026-09-20T03:00:00Z", "settle_failed", 402, null);
    // 売り手 c: 出品 c/1 は財布切れで失敗した後、買い直して届いた（最新は成功）。選ばない
    const c1 = await ep("c.example/1");
    await buy(c1, "2026-09-14T04:00:00Z", "settle_failed", 402, null);
    await buy(c1, "2026-10-01T04:00:00Z", "settled", 200, `0x${"c1".repeat(32)}`);

    delete process.env.OBSERVATORY_L1_RETEST_LISTINGS;
    const off = await readRetestSellers(db);
    assert.ok(off);
    assert.deepEqual(JSON.parse(off.hostsJson), [], "flag off: seller a's newest row delivered, so the seller-level retest skips it");

    process.env.OBSERVATORY_L1_RETEST_LISTINGS = "on";
    const on = await readRetestSellers(db);
    assert.ok(on);
    assert.deepEqual(JSON.parse(on.hostsJson), ["a.example"], "flag on: seller a has a listing whose latest row failed on vet402's side");
    assert.deepEqual(JSON.parse(on.preferredIdsJson), [a1], "the failed listing itself is preferred, not the delivered one");
    assert.equal(on.hostCount, 1);

    // a/1 を買い直して届けば、もう選ばない
    await buy(a1, "2026-10-04T03:00:00Z", "settled", 200, `0x${"a1".repeat(32)}`);
    const after = await readRetestSellers(db);
    assert.deepEqual(JSON.parse(after!.hostsJson), [], "re-bought and delivered: no longer a candidate");
  });
}
