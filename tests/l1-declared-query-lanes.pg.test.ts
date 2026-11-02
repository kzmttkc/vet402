// ============================================================
// Declared query on the Arbitrum and Avalanche lanes: the allow list alone decides it.
//
// What this pins:
//  1. Not listed (production today): the paid request has no query and the row has no requestQuery.
//  2. Listed: the paid request carries the declared query, the row records declared, and what is signed does not change.
//  3. Listing one network does not turn on the other (exact match).
//  4. A Base-first listing bought on the lane: the list is read for the network being signed, not the listing's first
//     network. With only Base listed the lane row has no requestQuery. Every production row on these lanes is Base-first.
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_census_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-declared-query-lanes.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 declared query lanes (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const PAY_TO = "0x242ba6d68ffeb4a098b591b32d370f973ff882b7";
  const BASE_CAIP2 = "eip155:8453";
  type Accept = { scheme: string; network: string; amount: string; asset: string; payTo: string; maxTimeoutSeconds: number; extra: { name: string; version: string } };
  const LANES = [
    { name: "Arbitrum", caip2: "eip155:42161", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", flag: "OBSERVATORY_ARBITRUM_L1_ENABLED", rpc: "ARBITRUM_RPC_URL", other: "eip155:43114" },
    { name: "Avalanche", caip2: "eip155:43114", usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", flag: "OBSERVATORY_AVALANCHE_L1_ENABLED", rpc: "AVALANCHE_RPC_URL", other: "eip155:42161" },
  ] as const;
  const URL_ = "https://seller.example/api";
  const DECLARED = { exchange: "NYSE" };

  test("declared query on the Arbitrum and Avalanche lanes", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const ENV = [
      "OBSERVATORY_L1_ENABLED",
      "OBSERVATORY_WALLET_PRIVATE_KEY",
      "OBSERVATORY_ARBITRUM_L1_ENABLED",
      "OBSERVATORY_AVALANCHE_L1_ENABLED",
      "ARBITRUM_RPC_URL",
      "AVALANCHE_RPC_URL",
      "OBSERVATORY_L1_DECLARED_QUERY_NETWORKS",
      "OBSERVATORY_L1_CENSUS",
      "L1_LANE_FLOOR_PER_RUN",
    ] as const;
    const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    t.after(() => {
      for (const k of ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    for (const lane of LANES) {
      const accept: Accept = { scheme: "exact", network: lane.caip2, amount: "2000", asset: lane.usdc, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
      const baseAccept: Accept = { ...accept, network: BASE_CAIP2, asset: BASE_USDC };
      let accepts: Accept[] = [accept];
      const wall402 = () =>
        new Response(
          JSON.stringify({ x402Version: 2, accepts, resource: { url: URL_ }, extensions: { bazaar: { info: { input: { type: "http", method: "GET", queryParams: DECLARED } } } } }),
          { status: 402, headers: { "content-type": "application/json" } },
        );
      const wall = () => {
        const seen: { url: string; paid: boolean; envelope: { accepted?: unknown; resource?: unknown; payload?: { authorization?: { to?: string; value?: string } } } | null }[] = [];
        const fetchImpl = async (url: string, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          const sig = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
          seen.push({ url, paid: sig !== null, envelope: sig ? JSON.parse(Buffer.from(sig, "base64").toString("utf8")) : null });
          if (!sig) return wall402();
          if (!new URL(url).searchParams.has("exchange")) {
            return new Response(JSON.stringify({ error: "missing_parameter" }), { status: 400, headers: { "content-type": "application/json" } });
          }
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "PAYMENT-RESPONSE": Buffer.from(
                JSON.stringify({ success: true, transaction: `0x${String(seen.length).padStart(64, "a")}`, network: String((seen[seen.length - 1].envelope?.accepted as { network?: string } | undefined)?.network), payer: "0x0000000000000000000000000000000000000001" }),
              ).toString("base64"),
            },
          });
        };
        return { seen, fetchImpl };
      };
      const seed = async (list: Accept[] = [accept]) => {
        accepts = list;
        for (const k of ENV) delete process.env[k];
        process.env.OBSERVATORY_L1_ENABLED = "true";
        process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
        process.env[lane.flag] = "true";
        process.env[lane.rpc] = "http://127.0.0.1:9/test-rpc";
        await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`);
        const items = [
          parseCatalogItem({
            resource: URL_,
            accepts: list,
            extensions: { bazaar: { info: { input: { method: "GET" } } } },
            quality: { l30DaysTotalCalls: 100, l30DaysUniquePayers: 10 },
          }),
        ];
        await syncCatalog({ fetchResult: { items, totalCount: 1, fetchedCount: 1, complete: true }, today: new Date().toISOString().slice(0, 10) });
        await runL0ProbeBatch({ limit: 5, concurrency: 1, fetchImpl: async () => wall402() });
      };
      const row = async () => {
        const raw = await db.execute(sql`
          SELECT status, http_status_paid, network, raw_response_meta->>'requestQuery' AS q, raw_response_meta ? 'requestQuery' AS has_q FROM x402_l1_purchases`);
        const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { status: string; http_status_paid: number; network: string; q: string | null; has_q: boolean }[];
        assert.equal(rows.length, 1);
        return rows[0];
      };
      const buy = async () => {
        const w = wall();
        await runL1Batch({ limit: 5, fetchImpl: w.fetchImpl, getPayerUsdcBalance: async () => 1_000_000_000n });
        const paid = w.seen.filter((s) => s.paid);
        assert.equal(paid.length, 1);
        const e = paid[0].envelope!;
        return { url: paid[0].url, signed: { accepted: e.accepted, resource: e.resource, to: e.payload?.authorization?.to, value: e.payload?.authorization?.value } };
      };

      let notListed: Awaited<ReturnType<typeof buy>>["signed"] | null = null;

      await t.test(`${lane.name}, not listed: no query is sent, the row records none, and the seller refuses`, async () => {
        await seed();
        const b = await buy();
        notListed = b.signed;
        assert.equal(b.url, URL_);
        const r = await row();
        assert.equal(r.network, lane.caip2);
        assert.equal(r.http_status_paid, 400);
        assert.equal(r.has_q, false);
      });

      await t.test(`${lane.name}, only the other lane listed: still no query`, async () => {
        await seed();
        process.env.OBSERVATORY_L1_DECLARED_QUERY_NETWORKS = lane.other;
        const b = await buy();
        assert.equal(b.url, URL_);
        assert.equal((await row()).has_q, false);
      });

      await t.test(`${lane.name}, listed: the paid request carries the query, the row says declared, and what is signed is the same`, async () => {
        await seed();
        process.env.OBSERVATORY_L1_DECLARED_QUERY_NETWORKS = `eip155:8453,${lane.caip2}`;
        const b = await buy();
        assert.equal(b.url, `${URL_}?exchange=NYSE`);
        assert.deepEqual(b.signed, notListed);
        const r = await row();
        assert.equal(r.q, "declared");
        assert.equal(r.http_status_paid, 200);
      });

      let baseFirstNotListed: Awaited<ReturnType<typeof buy>>["signed"] | null = null;

      await t.test(`${lane.name}, Base-first listing, only Base listed: the lane row has no query`, async () => {
        await seed([baseAccept, accept]);
        process.env.OBSERVATORY_L1_DECLARED_QUERY_NETWORKS = `${BASE_CAIP2},base`;
        const b = await buy();
        baseFirstNotListed = b.signed;
        assert.equal((b.signed.accepted as { network?: string }).network, lane.caip2, "bought on the lane");
        assert.equal(b.url, URL_);
        const r = await row();
        assert.equal(r.network, lane.caip2);
        assert.equal(r.http_status_paid, 400);
        assert.equal(r.has_q, false);
      });

      await t.test(`${lane.name}, Base-first listing, lane added: the lane row says declared, and what is signed is the same`, async () => {
        await seed([baseAccept, accept]);
        process.env.OBSERVATORY_L1_DECLARED_QUERY_NETWORKS = `${BASE_CAIP2},base,${lane.caip2}`;
        const b = await buy();
        assert.equal(b.url, `${URL_}?exchange=NYSE`);
        assert.deepEqual(b.signed, baseFirstNotListed);
        const r = await row();
        assert.equal(r.network, lane.caip2);
        assert.equal(r.q, "declared");
        assert.equal(r.http_status_paid, 200);
      });
    }
  });
}
