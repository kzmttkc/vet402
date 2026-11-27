// ============================================================
// network を書いた予約購入（2026-11-27・Prezenti M3 の x402atlas.xyz を Celo で）。
//
//  1. Base が先頭で Celo の accept も持つ出品を、予約どおり Celo の USDC で買い、行は eip155:42220・selection pinned_purchase。
//     同じホストの Celo の別の口（$0.02）は、窓のあいだ Celo の枠から買わない。
//  2. 壁に Celo の accept が無いときは Base に落とさない（署名しない・予約の 1 件を使わない）。
//  3. Celo の残高が無いときも Base に落とさない（未入金の買い直しで Base を選ばない）。
//  4. Celo のレーンが off のときは、その予約の出品へ 402 も取りに行かない。
//  5. 初回購入の日次枠（120 件）を使い切った日も、レーンの枠が 0 でも、予約の出品を引いて Celo で買う（11/27 に GET の 3 口が
//     候補にならなかった）。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-pinned-network.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 pinned network (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const CELO_CAIP2 = "eip155:42220";
  const BASE_CAIP2 = "eip155:8453";
  const CELO_USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
  const BASE_PAYTO = "0x299cb831e8580f559e58064d4f145389db418ece";
  const CELO_PAYTO = "0x2632a66e376090565f84794705970b96e75c5c2a";
  const PIN_URL = "https://x402atlas.xyz/api/chain/block-number";
  const DEAR_URL = "https://x402atlas.xyz/v1/images/generations";
  const INSIDE_MS = Date.parse("2026-11-27T06:00:00.000Z");

  test("L1 network-pinned purchase", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { PINNED_PURCHASES } = await import("@/lib/observatory/pinned-purchases");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    assert.ok(PINNED_PURCHASES.some((p) => p.url === PIN_URL && p.network === CELO_CAIP2), "the reservation under test is in the list");

    const ENV = [
      "OBSERVATORY_L1_ENABLED",
      "OBSERVATORY_WALLET_PRIVATE_KEY",
      "OBSERVATORY_CELO_L1_ENABLED",
      "OBSERVATORY_ARC_L1_ENABLED",
      "OBSERVATORY_SOLANA_L1_ENABLED",
      "OBSERVATORY_TEMPO_L1_ENABLED",
      "OBSERVATORY_XRPL_L1_ENABLED",
      "OBSERVATORY_L1_CENSUS",
      "L1_CELO_DAILY_CAP_USD",
      "L1_SELLER_DAILY_CAP_USD",
      "L1_DOMAIN_DAILY_CAP_USD",
      "L1_LANE_FLOOR_PER_RUN",
      "VET402_OPERATOR_PAYTO",
    ] as const;
    const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    t.after(() => {
      for (const k of ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
    for (const k of ENV) delete process.env[k];
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;

    const baseUsdc = (amount: string) => ({
      scheme: "exact", network: BASE_CAIP2, amount, asset: BASE_USDC, payTo: BASE_PAYTO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" },
    });
    const celoUsdc = (amount: string) => ({
      scheme: "exact", network: CELO_CAIP2, amount, asset: CELO_USDC, payTo: CELO_PAYTO, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" },
    });
    // 2026-11-27 の Bazaar の形: Base が先頭、Celo の受取先は Base と別。
    const CATALOG: Record<string, unknown[]> = {
      [PIN_URL]: [baseUsdc("1000"), celoUsdc("1000")],
      [DEAR_URL]: [baseUsdc("20000"), celoUsdc("20000")],
    };

    let txSeq = 0;
    const wall = (over: Record<string, unknown[]> = {}) => {
      const seen: { url: string; paid: boolean; network: string | null }[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const sig = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
        const decoded = sig ? (JSON.parse(Buffer.from(sig, "base64").toString("utf8")) as { accepted?: { network?: string } }) : null;
        seen.push({ url, paid: sig !== null, network: decoded?.accepted?.network ?? null });
        if (!sig) {
          return new Response(JSON.stringify({ x402Version: 2, accepts: over[url] ?? CATALOG[url] ?? [] }), { status: 402, headers: { "content-type": "application/json" } });
        }
        txSeq += 1;
        return new Response(JSON.stringify({ data: { result: "0x1" } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({
                success: true,
                transaction: `0x${txSeq.toString(16).padStart(4, "0").repeat(16)}`,
                network: String(decoded?.accepted?.network ?? BASE_CAIP2),
                payer: "0x0000000000000000000000000000000000000001",
              }),
            ).toString("base64"),
          },
        });
      };
      const paid = (url: string) => seen.filter((s) => s.paid && s.url === url);
      const requests = (url: string) => seen.filter((s) => s.url === url);
      return { fetchImpl, paid, requests };
    };

    async function seed() {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      const items = Object.keys(CATALOG).map((resource) =>
        parseCatalogItem({
          resource,
          accepts: CATALOG[resource],
          extensions: { bazaar: { info: { input: { method: resource === DEAR_URL ? "POST" : "GET", ...(resource === DEAR_URL ? { body: { prompt: "x" }, bodyType: "json" } : {}) } } } },
          quality: { l30DaysTotalCalls: 100, l30DaysUniquePayers: 10 },
        }),
      );
      await syncCatalog({ fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true }, today: "2026-11-27" });
      await runL0ProbeBatch({
        limit: 10,
        concurrency: 2,
        fetchImpl: async (url: string) => new Response(JSON.stringify({ x402Version: 2, accepts: CATALOG[url] ?? [] }), { status: 402, headers: { "content-type": "application/json" } }),
      });
    }

    const ledgerFor = async (resourceUrl: string) => {
      const raw = await db.execute(sql`
        SELECT pu.status, pu.network, pu.pay_to, pu.raw_response_meta->>'selection' AS selection
        FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE e.resource_url = ${resourceUrl} ORDER BY pu.attempted_at ASC`);
      return ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<string, string>[]).map((r) => ({ ...r }));
    };
    const FUNDED = async () => 1_000_000_000n;

    await t.test("Celo on: the reservation is bought on Celo, and the pricier listing of the same host is not bought on Celo", async () => {
      await seed();
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      const w = wall();
      await runL1Batch({ limit: 10, now: () => INSIDE_MS, getPayerUsdcBalance: FUNDED, fetchImpl: w.fetchImpl });
      assert.deepEqual(w.paid(PIN_URL).map((s) => s.network), [CELO_CAIP2]);
      const rows = await ledgerFor(PIN_URL);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.network, CELO_CAIP2);
      assert.equal(rows[0]!.pay_to?.toLowerCase(), CELO_PAYTO);
      assert.equal(rows[0]!.selection, "pinned_purchase");
      assert.equal(w.paid(DEAR_URL).filter((s) => s.network === CELO_CAIP2).length, 0, "the $0.02 listing is left to the reservation's window");
    });

    await t.test("no Celo accept on the wall: nothing is signed for the reservation (not on Base either)", async () => {
      await seed();
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      const w = wall({ [PIN_URL]: [baseUsdc("1000")] });
      await runL1Batch({ limit: 10, now: () => INSIDE_MS, getPayerUsdcBalance: FUNDED, fetchImpl: w.fetchImpl });
      assert.equal(w.paid(PIN_URL).length, 0);
      assert.deepEqual(await ledgerFor(PIN_URL), []);
    });

    await t.test("Celo payer unfunded: the reservation is not re-bought on Base", async () => {
      await seed();
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      const w = wall();
      await runL1Batch({
        limit: 10,
        now: () => INSIDE_MS,
        getPayerUsdcBalance: async ({ chain }) => (chain === "celo" ? 0n : 1_000_000_000n),
        fetchImpl: w.fetchImpl,
      });
      assert.equal(w.paid(PIN_URL).length, 0);
      assert.deepEqual(await ledgerFor(PIN_URL), []);
    });

    await t.test("Celo lane off: the reservation's listing gets no request at all", async () => {
      await seed();
      delete process.env.OBSERVATORY_CELO_L1_ENABLED;
      const w = wall();
      await runL1Batch({ limit: 10, now: () => INSIDE_MS, getPayerUsdcBalance: FUNDED, fetchImpl: w.fetchImpl });
      assert.equal(w.requests(PIN_URL).length, 0);
      assert.deepEqual(await ledgerFor(PIN_URL), []);
    });
    await t.test("first-purchase quota used up and no lane floor: the reservation is still fetched and bought on Celo", async () => {
      await seed();
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      process.env.L1_LANE_FLOOR_PER_RUN = "0";
      await db.execute(sql`
        WITH ins AS (
          INSERT INTO x402_endpoints (resource_key, resource_url, source, status)
          SELECT 'quota.example/' || g, 'https://quota.example/' || g, 'cdp_bazaar', 'delisted' FROM generate_series(1, 120) g
          RETURNING id
        )
        INSERT INTO x402_l1_purchases (endpoint_id, status) SELECT id, 'request_error' FROM ins`);
      const w = wall();
      await runL1Batch({ limit: 10, now: () => INSIDE_MS, getPayerUsdcBalance: FUNDED, fetchImpl: w.fetchImpl });
      delete process.env.L1_LANE_FLOOR_PER_RUN;
      assert.deepEqual(w.paid(PIN_URL).map((s) => s.network), [CELO_CAIP2]);
      const rows = await ledgerFor(PIN_URL);
      assert.equal(rows[0]?.selection, "pinned_purchase");
    });
  });
}
