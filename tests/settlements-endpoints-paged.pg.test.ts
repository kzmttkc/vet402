// ============================================================
// §7.1 EVM 決済索引 — エンドポイントの事前ロードを分けて読む（2026-11-04）。
//
// 事故: Base の有効エンドポイントは 12 万行・25 MB あり、1 文で読むと HTTP の流れが
// 途中で切れて（NGHTTP2_INTERNAL_ERROR）Base の索引がその回まるごと止まっていた。
//
// 守ること:
//  1. 分けて読んでも 1 文のときと同じ行が、重複も抜けもなく返る
//  2. 行数がページの大きさちょうどでも止まらず、抜けない
//  3. 絞り込み（有効・0x・チェーン・base の別名）は変わらない
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/settlements-endpoints-paged.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("settlements endpoints paged (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("loadChainEndpoints returns every matching row once across pages", async () => {
    const { loadChainEndpoints } = await import("@/lib/settlements/index-evm");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints`);

    const insert = (key: string, network: string, status: string, payTo: string | null) =>
      db.execute(sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, source, method, network, pay_to, price_amount, status, last_seen_at)
        VALUES (${key}, ${`https://${key}`}, 'cdp_bazaar', 'GET', ${network}, ${payTo}, '10000', ${status}, now())
      `);
    const PAY = "0x00000000000000000000000000000000000000B1";
    const keep: string[] = [];
    for (let i = 0; i < 6; i++) {
      const key = `keep.example/${i}`;
      keep.push(key);
      await insert(key, i === 5 ? "base" : "eip155:8453", "active", PAY);
    }
    await insert("delisted.example/a", "eip155:8453", "delisted", PAY);
    await insert("celo.example/a", "eip155:42220", "active", PAY);
    await insert("nopay.example/a", "eip155:8453", "active", null);
    await insert("solana.example/a", "eip155:8453", "active", "So11111111111111111111111111111111111111112");

    const whole = await loadChainEndpoints(db, "eip155:8453", 1_000);
    assert.equal(whole.length, keep.length);
    assert.equal(new Set(whole.map((r) => r.id)).size, keep.length);
    assert.ok(whole.every((r) => r.pay_to === PAY.toLowerCase()));

    // 1 ページの行数が割り切れるとき・割り切れないとき・1 行ずつ。
    for (const pageRows of [1, 2, 3, 4, 6, 7]) {
      const paged = await loadChainEndpoints(db, "eip155:8453", pageRows);
      assert.deepEqual(paged.map((r) => r.id), whole.map((r) => r.id), `pageRows=${pageRows}`);
    }

    const celo = await loadChainEndpoints(db, "eip155:42220", 2);
    assert.equal(celo.length, 1, "base の別名は Base のときだけ");
    await db.execute(sql`TRUNCATE x402_endpoints`);
  });
}
