// ============================================================
// §7.2 カタログ外の受取人の書き込み（upsertDiscoveryPayees・2026-09-15）。実 DB で SQL を通す。
//  - 500 行ごとに分けて全件入る（パラメータ上限の内側）
//  - 同じ (chain, pay_to, source) の再取り込みは行を増やさず last_seen_at だけ進める
//  - first_seen_at は最初の日のまま
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/settlements-discovery-payees.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("discovery payees upsert (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("upsertDiscoveryPayees", async () => {
    const { upsertDiscoveryPayees, DISCOVERY_PAYEE_SOURCE_PAYAI } = await import("@/lib/settlements/discovery-payees");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
    await db.execute(sql`CREATE TABLE IF NOT EXISTS x402_discovery_payees (
      chain text NOT NULL, pay_to text NOT NULL, source text NOT NULL,
      first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (chain, pay_to, source))`);
    await db.execute(sql`TRUNCATE x402_discovery_payees`);

    const rows = Array.from({ length: 1201 }, (_, i) => ({ chain: SOL, payTo: `payee${i}`, source: DISCOVERY_PAYEE_SOURCE_PAYAI }));
    assert.equal(await upsertDiscoveryPayees(db, rows), 1201);
    const count = async () => {
      const r = await db.execute(sql`SELECT count(*)::int AS n FROM x402_discovery_payees`);
      return ((Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? []) as { n: number }[])[0].n;
    };
    assert.equal(await count(), 1201, "3 回に分けて全件入る");

    await db.execute(sql`UPDATE x402_discovery_payees SET first_seen_at = now() - interval '20 days', last_seen_at = now() - interval '20 days' WHERE pay_to = 'payee7'`);
    await upsertDiscoveryPayees(db, [rows[7]]);
    assert.equal(await count(), 1201, "再取り込みで行は増えない");
    const r = await db.execute(sql`SELECT (now() - first_seen_at) > interval '19 days' AS old_first, (now() - last_seen_at) < interval '1 minute' AS fresh_last FROM x402_discovery_payees WHERE pay_to = 'payee7'`);
    const row = ((Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? []) as { old_first: boolean; fresh_last: boolean }[])[0];
    assert.equal(row.old_first, true, "first_seen_at は最初の日のまま");
    assert.equal(row.fresh_last, true, "last_seen_at は進む");
  });
}
