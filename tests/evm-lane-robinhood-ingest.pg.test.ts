// ============================================================
// #20 Robinhood — DB への取り込みと l1.byChain への反映（Postgres）。
//
// Run: TEST_DATABASE_URL=postgres://... npx tsx --test --test-force-exit --test-concurrency=1 \
//   tests/evm-lane-robinhood-ingest.pg.test.ts
// ============================================================
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
const FIXTURE = join(__dirname, "fixtures/evm-lane/robinhood-roots.json");

if (!TEST_DB) {
  test("evm lane robinhood ingest (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("ingest: rows match public roots; byChain gains Robinhood Chain with settled 13", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const {
      evmLanePublicCountsFromRoots,
      ingestEvmLaneRobinhood,
      loadEvmLaneRootsJson,
      ROBINHOOD_CAIP2,
    } = await import("@/lib/observatory/evm-lane-ingest");
    const { getObservatoryStats } = await import("@/lib/observatory/reader");

    const db = getDb()!;
    const roots = loadEvmLaneRootsJson(FIXTURE);
    const expect = evmLanePublicCountsFromRoots(roots);

    await t.test("reset L1 purchases for Robinhood network", async () => {
      await db.execute(sql`DELETE FROM x402_l1_purchases WHERE network = ${ROBINHOOD_CAIP2}`);
    });

    const first = await ingestEvmLaneRobinhood(db, roots);
    assert.equal(first.scanned, expect.published);
    assert.equal(first.inserted, expect.published);
    assert.equal(first.skipped, 0);

    const second = await ingestEvmLaneRobinhood(db, roots);
    assert.equal(second.inserted, 0);
    assert.equal(second.skipped, expect.published);

    const counts = await db.execute(sql`
      SELECT count(*)::int AS attempts,
             count(*) FILTER (WHERE status = 'settled')::int AS settled,
             count(*) FILTER (WHERE status = 'settled' AND http_status_paid BETWEEN 200 AND 299 AND payload_non_empty)::int AS delivered
      FROM x402_l1_purchases WHERE network = ${ROBINHOOD_CAIP2}
    `);
    const row = (Array.isArray(counts) ? counts[0] : (counts as { rows: Record<string, number>[] }).rows[0]) as {
      attempts: number;
      settled: number;
      delivered: number;
    };
    assert.equal(row.attempts, expect.published);
    assert.equal(row.settled, expect.settled);
    assert.equal(row.delivered, expect.delivered);

    const state = await getObservatoryStats();
    const rh = state.l1.byChain.find((c) => c.network === ROBINHOOD_CAIP2);
    assert.ok(rh, "l1.byChain includes Robinhood Chain");
    assert.equal(rh!.label, "Robinhood Chain");
    assert.equal(rh!.settled, expect.settled);
    assert.equal(rh!.delivered, expect.delivered);
    assert.equal(rh!.attempts, expect.published);
  });
}
