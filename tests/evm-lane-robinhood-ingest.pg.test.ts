// ============================================================
// #20 Robinhood — DB への取り込みと l1.byChain への反映（Postgres）。
//
// Run: TEST_DATABASE_URL=postgres://... npx tsx --test --test-force-exit --test-concurrency=1 \
//   tests/evm-lane-robinhood-ingest.pg.test.ts
// ============================================================
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { deliveredPredicate } from "@/lib/observatory/delivery";
import { EXPORT_CSV_COLUMNS } from "@/lib/observatory/export-columns";
import { notSellerRetestRequestSourceSql } from "@/lib/observatory/seller-retest-requests";
import { settlementSourceOf } from "@/lib/observatory/settlement-source";
import { settledTier } from "@/lib/observatory/settled-tier";
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
      EVM_LANE_ENDPOINT_SOURCE,
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

    const statsBeforeIngest = await getObservatoryStats();

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
             count(*) FILTER (WHERE ${sql.raw(deliveredPredicate())})::int AS delivered
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

    const statsAfterIngest = await getObservatoryStats();
    assert.equal(statsAfterIngest.activeEndpoints, statsBeforeIngest.activeEndpoints, "vet402_evm_lane must not inflate L0 active count");
    assert.equal(statsAfterIngest.totalEndpoints, statsBeforeIngest.totalEndpoints, "vet402_evm_lane must not inflate listed total");

    await t.test("rows: auth_nonce null, amount_payee_only tier, vet402_index settlement source", async () => {
      const purchases = await db.execute(sql`
        SELECT status, auth_nonce, tx_hash, settlement_verified, network,
               raw_response_meta->'lateSettlement' AS late_settlement
        FROM x402_l1_purchases WHERE network = ${ROBINHOOD_CAIP2}
      `);
      const rows = (Array.isArray(purchases) ? purchases : (purchases as { rows: Record<string, unknown>[] }).rows) as {
        status: string;
        auth_nonce: string | null;
        tx_hash: string | null;
        settlement_verified: boolean | null;
        network: string;
        late_settlement: unknown;
      }[];
      assert.equal(rows.filter((r) => r.auth_nonce).length, 0, "leaf salt must not be stored as auth_nonce");
      for (const r of rows) {
        if (r.status !== "settled" || !r.tx_hash) continue;
        assert.equal(
          settledTier({
            status: r.status,
            authNonce: r.auth_nonce,
            settlementVerified: r.settlement_verified,
            network: r.network,
          }),
          "amount_payee_only",
        );
        assert.equal(settlementSourceOf({ txHash: r.tx_hash, lateSettlement: r.late_settlement }), "vet402_index");
      }
    });

    await t.test("vet402_evm_lane endpoints fail listing exclusion predicate (not L1 candidates)", async () => {
      const hit = await db.execute(sql`
        SELECT count(*)::int AS n FROM x402_endpoints e
        WHERE e.source = ${EVM_LANE_ENDPOINT_SOURCE} AND ${notSellerRetestRequestSourceSql()}
      `);
      const hitRow = (Array.isArray(hit) ? hit[0] : (hit as { rows: Record<string, unknown>[] }).rows[0]) as { n: number };
      assert.equal(hitRow.n, 0);
    });

    const savedProxy = process.env.PROXY_HEADER_SOURCE;
    process.env.PROXY_HEADER_SOURCE = "generic";
    try {
      const { GET } = await import("@/app/api/v1/observatory/export.csv/route");
      const res = await GET(
        new NextRequest(`https://vet402.com/api/v1/observatory/export.csv?days=366`, {
          headers: { "x-forwarded-for": "203.0.113.120" },
        }),
      );
      assert.equal(res.status, 200);
      const lines = (await res.text()).split("\n").filter((l) => l.length > 0);
      assert.equal(lines[0], EXPORT_CSV_COLUMNS.join(","), "export header unchanged");
      const data = lines.slice(1);
      const rhRows = data.filter((row) => row.includes(ROBINHOOD_CAIP2));
      assert.equal(rhRows.length, expect.published, "export.csv includes every Robinhood attempt");
      const settledInExport = rhRows.filter((row) => /,settled,/.test(row) || row.includes(",\"settled\",")).length;
      assert.equal(settledInExport, expect.settled);
    } finally {
      if (savedProxy === undefined) delete process.env.PROXY_HEADER_SOURCE;
      else process.env.PROXY_HEADER_SOURCE = savedProxy;
    }
  });
}
