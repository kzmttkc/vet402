// Arc のネイティブ枠は GatewayWalletBatched を数えない。
// 旗 off: Gateway だけの行は枠に入らず、no_eligible_accept の行も書かない。
// 旗 on（ARC_RPC_URL は置かない。Gateway の残高 API は呼ばない）: Base の exact と
// Arc Gateway だけの行は Arc の枠に入らない。Arc の eip3009 は入る。
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("arc gateway secondary filter (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const PAY = "0x1111111111111111111111111111111111111111";
  const ARC = "eip155:5042";
  const ARC_USDC = "0x3600000000000000000000000000000000000000";
  const BASE = "eip155:8453";

  test("Arc の枠は GatewayWalletBatched で埋まらない", async (t) => {
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const saved = {
      l1: process.env.OBSERVATORY_L1_ENABLED,
      pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY,
      arc: process.env.OBSERVATORY_ARC_L1_ENABLED,
      gw: process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED,
      rpc: process.env.ARC_RPC_URL,
      sol: process.env.OBSERVATORY_SOLANA_L1_ENABLED,
      floor: process.env.L1_LANE_FLOOR_PER_RUN,
    };
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    t.after(() => {
      restore("OBSERVATORY_L1_ENABLED", saved.l1);
      restore("OBSERVATORY_WALLET_PRIVATE_KEY", saved.pk);
      restore("OBSERVATORY_ARC_L1_ENABLED", saved.arc);
      restore("OBSERVATORY_ARC_GATEWAY_L1_ENABLED", saved.gw);
      restore("ARC_RPC_URL", saved.rpc);
      restore("OBSERVATORY_SOLANA_L1_ENABLED", saved.sol);
      restore("L1_LANE_FLOOR_PER_RUN", saved.floor);
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
    delete process.env.OBSERVATORY_SOLANA_L1_ENABLED;
    delete process.env.ARC_RPC_URL;
    process.env.L1_LANE_FLOOR_PER_RUN = "5";

    const gw = (network: string) => ({
      scheme: "exact",
      network,
      amount: "1000",
      asset: network === ARC ? ARC_USDC : "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      payTo: PAY,
      maxTimeoutSeconds: 300,
      extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000eE" },
    });
    const baseExact = {
      scheme: "exact",
      network: BASE,
      amount: "1000",
      asset: BASE_USDC,
      payTo: PAY,
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2", assetTransferMethod: "eip3009" },
    };
    const arcExact = {
      scheme: "exact",
      network: ARC,
      amount: "1000",
      asset: ARC_USDC,
      payTo: PAY,
      maxTimeoutSeconds: 300,
      extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" },
    };
    const bazaar = { extensions: { bazaar: { info: { input: { method: "GET" } } } } };
    const URLS = {
      gwOnly: "https://gw-only.example/api",
      ethFirst: "https://eth-first.example/api",
      baseGw: "https://base-gw.example/api",
      native: "https://native-arc.example/api",
      mixed: "https://native-plus-gw.example/api",
    };

    async function seed() {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_l1_purchases, x402_delisting_events`);
      const items = [
        parseCatalogItem({ resource: URLS.gwOnly, metadata: { method: "GET" }, accepts: [gw("eip155:1"), gw(ARC)] }),
        parseCatalogItem({ resource: URLS.ethFirst, accepts: [gw("eip155:1"), gw(ARC)], ...bazaar }),
        parseCatalogItem({ resource: URLS.baseGw, metadata: { method: "GET" }, accepts: [baseExact, gw(ARC)] }),
        parseCatalogItem({ resource: URLS.native, accepts: [arcExact], ...bazaar }),
        parseCatalogItem({ resource: URLS.mixed, accepts: [arcExact, gw(ARC)], ...bazaar }),
      ];
      await syncCatalog({
        fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true },
        today: "2026-10-26",
      });
      await db.execute(sql`
        INSERT INTO x402_l0_probes (endpoint_id, method, verdict, probed_at)
        SELECT id, coalesce(method, 'GET'), 'pass', now() FROM x402_endpoints
      `);
    }
    const purchasesFor = async (url: string) => {
      const raw = await db.execute(sql`
        SELECT pu.status FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id WHERE e.resource_url = ${url}
      `);
      return (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { status: string }[];
    };
    async function run() {
      const seen: string[] = [];
      const fetchImpl = async (url: string) => {
        seen.push(url);
        return new Response(JSON.stringify({ x402Version: 2, accepts: [] }), { status: 402, headers: { "content-type": "application/json" } });
      };
      const summary = await runL1Batch({ limit: 10, fetchImpl, getPayerUsdcBalance: async () => 1_000_000_000n });
      return { summary, seen };
    }

    await t.test("旗 off: Gateway だけの行は Arc の枠に入らない。eip3009 は入る", async () => {
      delete process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED;
      await seed();
      const { summary, seen } = await run();
      assert.equal(summary.laneFloor.arc, 2, `laneFloor=${JSON.stringify(summary.laneFloor)} seen=${seen.join(",")}`);
      assert.equal(seen.some((u) => u.includes("gw-only")), false);
      assert.equal((await purchasesFor(URLS.gwOnly)).length, 0);
      const ethRows = await db.execute(sql`
        SELECT pu.network FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id WHERE e.resource_url = ${URLS.ethFirst}
      `);
      const ethNets = ((Array.isArray(ethRows) ? ethRows : ((ethRows as unknown as { rows?: { network: string | null }[] }).rows ?? [])) as { network: string | null }[]).map((r) => r.network);
      assert.equal(ethNets.includes(ARC), false);
    });

    await t.test("旗 on でも Base と Gateway だけの行は Arc の枠に入らず、eip3009 は入る", async () => {
      process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = "true";
      delete process.env.ARC_RPC_URL;
      await seed();
      const { summary, seen } = await run();
      assert.equal(summary.laneFloor.arc, 2, `laneFloor=${JSON.stringify(summary.laneFloor)} seen=${seen.join(",")}`);
      assert.equal(seen.some((u) => u.includes("gw-only")), false);
      assert.equal(seen.some((u) => u.includes("native-arc") || u.includes("native-plus-gw")), true);
      assert.equal((await purchasesFor(URLS.gwOnly)).length, 0);
      const baseRows = await db.execute(sql`
        SELECT pu.network FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id WHERE e.resource_url = ${URLS.baseGw}
      `);
      const baseNets = ((Array.isArray(baseRows) ? baseRows : ((baseRows as unknown as { rows?: { network: string }[] }).rows ?? [])) as { network: string }[]).map((r) => r.network);
      assert.equal(baseNets.includes(ARC), false);
    });
  });
}
