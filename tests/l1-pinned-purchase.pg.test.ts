// ============================================================
// 予約購入: 窓の内は先頭、上限で買えない、台帳に selection が残る。
// ============================================================
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const FUNDED_PAYER = async () => 1_000_000_000n;
const TEST_DB = process.env.TEST_DATABASE_URL;
const PIN_URL = "https://agent402.tools/api/weather-forecast";

if (!TEST_DB) {
  test("l1 pinned purchase (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const payToFor = (n: string) => `0x${String(n).repeat(40).slice(0, 40)}`;

  after(async () => {
    const { getDb } = await import("@/lib/db/client");
    const db = getDb() as unknown as { $client?: { end?: () => Promise<void> } } | null;
    await db?.$client?.end?.();
  });

  test("L1 pinned purchase", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { PINNED_PURCHASES } = await import("@/lib/observatory/pinned-purchases");
    const { getDb } = await import("@/lib/db/client");
    const { sql, eq } = await import("drizzle-orm");
    const schema = await import("@/lib/db/schema");

    const db = getDb()!;
    const pinFrom = PINNED_PURCHASES[0]!.from;
    const saved = {
      l1: process.env.OBSERVATORY_L1_ENABLED,
      pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY,
    };
    t.after(() => {
      if (saved.l1 === undefined) delete process.env.OBSERVATORY_L1_ENABLED;
      else process.env.OBSERVATORY_L1_ENABLED = saved.l1;
      if (saved.pk === undefined) delete process.env.OBSERVATORY_WALLET_PRIVATE_KEY;
      else process.env.OBSERVATORY_WALLET_PRIVATE_KEY = saved.pk;
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;

    const insideMs = Date.parse(PINNED_PURCHASES[0]!.from) + 10 * 3600_000;
    const outsideMs = Date.parse(PINNED_PURCHASES[0]!.from) - 24 * 3600_000;

    let tx = 0;
    const challengeFor = (payTo: string) =>
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "3000",
            asset: BASE_USDC,
            payTo,
            maxTimeoutSeconds: 300,
            extra: { name: "USD Coin", version: "2" },
          },
        ],
      });

    const settleFetch = async (url: string, init?: RequestInit, payTo?: string) => {
      const headers = new Headers(init?.headers);
      const pt = payTo ?? payToFor(url.includes("weather-forecast") ? "1" : "9");
      if (headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT")) {
        tx++;
        return new Response(JSON.stringify({ data: "ok" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({ success: true, transaction: `0x${String(tx).padStart(64, "0")}`, network: "eip155:8453" }),
            ).toString("base64"),
          },
        });
      }
      return new Response(challengeFor(pt), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    };

    const seed = async () => {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases`,
      );
      const items = [
        parseCatalogItem({
          resource: PIN_URL,
          accepts: [{ amount: "3000", asset: BASE_USDC, network: "eip155:8453", payTo: payToFor("1") }],
          quality: { l30DaysTotalCalls: 5, l30DaysUniquePayers: 1 },
        }),
        parseCatalogItem({
          resource: "https://seller-high.example/api",
          accepts: [{ amount: "3000", asset: BASE_USDC, network: "eip155:8453", payTo: payToFor("9") }],
          quality: { l30DaysTotalCalls: 5000, l30DaysUniquePayers: 500 },
        }),
      ];
      await syncCatalog({ fetchResult: { items, totalCount: 2, fetchedCount: 2, complete: true }, today: new Date(insideMs).toISOString().slice(0, 10) });
      await runL0ProbeBatch({
        limit: 10,
        fetchImpl: async (url: string) =>
          new Response(challengeFor(payToFor(url.includes("weather-forecast") ? "1" : "9")), {
            status: 402,
            headers: { "content-type": "application/json" },
          }),
      });
    };

    await t.test("inside window: pinned listing is bought first", async () => {
      await seed();
      const seen: string[] = [];
      await runL1Batch({
        limit: 1,
        now: () => insideMs,
        getPayerUsdcBalance: FUNDED_PAYER,
        fetchImpl: async (url, init) => {
          seen.push(url);
          return settleFetch(url, init);
        },
      });
      assert.ok(seen.length > 0);
      assert.ok(seen[0].includes("weather-forecast"), `expected pinned first, got ${seen[0]}`);
      const purchases = await db.select().from(schema.x402L1Purchases);
      const pinRow = purchases.find((p) => (p.rawResponseMeta as Record<string, unknown> | null)?.selection === "pinned_purchase");
      assert.ok(pinRow, `expected a row with selection=pinned_purchase, statuses=${purchases.map((p) => p.status).join(",")}`);
      assert.equal((pinRow!.rawResponseMeta as Record<string, unknown>).pinnedPurchaseReason, PINNED_PURCHASES[0]!.reason);
    });

    await t.test("outside window: higher-demand listing wins", async () => {
      await seed();
      const seen: string[] = [];
      await runL1Batch({
        limit: 1,
        now: () => outsideMs,
        getPayerUsdcBalance: FUNDED_PAYER,
        fetchImpl: async (url, init) => {
          seen.push(url);
          return settleFetch(url, init);
        },
      });
      assert.ok(seen.length > 0);
      assert.ok(seen[0].includes("seller-high.example"));
    });

    await t.test("already settled inside window since from: pin has no effect", async () => {
      await seed();
      const pinRow = await db
        .select({ id: schema.x402Endpoints.id })
        .from(schema.x402Endpoints)
        .where(eq(schema.x402Endpoints.resourceUrl, PIN_URL));
      assert.equal(pinRow.length, 1);
      await db.execute(sql`
        INSERT INTO x402_l1_purchases (endpoint_id, status, payer, network, asset, pay_to, amount_units, spent_units, attempted_at)
        VALUES (${pinRow[0]!.id}::uuid, 'settled', '0xabc', 'eip155:8453', ${BASE_USDC}, ${payToFor("1")}, '3000', '3000', ${pinFrom}::timestamptz)
      `);
      const seen: string[] = [];
      await runL1Batch({
        limit: 1,
        now: () => insideMs,
        getPayerUsdcBalance: FUNDED_PAYER,
        fetchImpl: async (url, init) => {
          seen.push(url);
          return settleFetch(url, init);
        },
      });
      assert.ok(seen.length > 0);
      assert.ok(!seen[0].includes("weather-forecast"));
    });

    await t.test("seller daily cap reached on pinned payTo: not bought", async () => {
      await seed();
      const pinPayTo = payToFor("1");
      process.env.L1_SELLER_DAILY_CAP_USD = "0.001";
      t.after(() => delete process.env.L1_SELLER_DAILY_CAP_USD);
      const pinRow = await db
        .select({ id: schema.x402Endpoints.id })
        .from(schema.x402Endpoints)
        .where(eq(schema.x402Endpoints.resourceUrl, PIN_URL));
      await db.execute(sql`
        INSERT INTO x402_l1_purchases (endpoint_id, status, payer, network, asset, pay_to, amount_units, spent_units, attempted_at)
        VALUES (${pinRow[0]!.id}::uuid, 'settled', '0xabc', 'eip155:8453', ${BASE_USDC}, ${pinPayTo}, '3000', '1000000', now())
      `);
      const seen: string[] = [];
      const summary = await runL1Batch({
        limit: 2,
        now: () => insideMs,
        getPayerUsdcBalance: FUNDED_PAYER,
        fetchImpl: async (url, init) => {
          seen.push(url);
          return settleFetch(url, init);
        },
      });
      assert.ok(!seen.some((u) => u.includes("weather-forecast")));
      assert.ok(summary.skipped >= 0);
    });
  });
}