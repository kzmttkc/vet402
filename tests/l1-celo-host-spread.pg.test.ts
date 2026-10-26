// Celo レーンは、出品の多い 1 ホストが取得窓を埋めても、未試行のホストへ広がる。
// Arc は同じ形でも窓が太いホストのまま。Base の需要順は変えない。
//
// Run: TEST_DATABASE_URL=postgres:///vet402_test_celo \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-celo-host-spread.pg.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 celo host spread (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const CELO = "eip155:42220";
  const BASE = "eip155:8453";
  const ARC = "eip155:5042";

  test("Celo の枠は未試行ホストへ広がり、Arc は太いホストが窓を埋め、Base の需要順は残る", async (t) => {
    const { runL1Batch, CELO_LANE_MAX_LISTINGS_PER_HOST } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC, CELO_CHAIN, ARC_CHAIN } = await import("@/lib/observatory/x402-payer");
    const { CHAIN_DAILY_CAPS, DOMAIN_DAILY_CAP_USD_DEFAULT, LANE_FLOOR_FETCH_MAX, LANE_FLOOR_OVERSAMPLE, SELLER_DAILY_CAP_USD_DEFAULT } = await import("@/lib/observatory/budget");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const ENV = [
      "OBSERVATORY_L1_ENABLED",
      "OBSERVATORY_WALLET_PRIVATE_KEY",
      "OBSERVATORY_CELO_L1_ENABLED",
      "OBSERVATORY_ARC_L1_ENABLED",
      "OBSERVATORY_ARC_GATEWAY_L1_ENABLED",
      "OBSERVATORY_SOLANA_L1_ENABLED",
      "OBSERVATORY_TEMPO_L1_ENABLED",
      "OBSERVATORY_XRPL_L1_ENABLED",
      "OBSERVATORY_STELLAR_L1_ENABLED",
      "OBSERVATORY_BNB_L1_ENABLED",
      "OBSERVATORY_ARBITRUM_L1_ENABLED",
      "OBSERVATORY_L1_CENSUS",
      "L1_CELO_DAILY_CAP_USD",
      "L1_ARC_DAILY_CAP_USD",
      "L1_SELLER_DAILY_CAP_USD",
      "L1_DOMAIN_DAILY_CAP_USD",
      "L1_LANE_FLOOR_PER_RUN",
      "ARC_RPC_URL",
      "BNB_RPC_URL",
      "ARBITRUM_RPC_URL",
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
    process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
    process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
    process.env.L1_LANE_FLOOR_PER_RUN = "5";

    const window = Math.min(5 * LANE_FLOOR_OVERSAMPLE, LANE_FLOOR_FETCH_MAX);
    const FAT_N = window + 5;
    assert.ok(FAT_N > window, `太いホストは取得窓 ${window} を超える件数である`);
    assert.equal(CELO_LANE_MAX_LISTINGS_PER_HOST, 2);
    assert.equal(CHAIN_DAILY_CAPS.celo.defaultUsd, 2);
    assert.equal(SELLER_DAILY_CAP_USD_DEFAULT, 2);
    assert.equal(DOMAIN_DAILY_CAP_USD_DEFAULT, 3);

    const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
    const amount = "1000";
    const baseUsdc = (payTo: string) => ({
      scheme: "exact", network: BASE, amount, asset: BASE_USDC, payTo, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" },
    });
    const celoUsdc = (payTo: string) => ({
      scheme: "exact", network: CELO, amount, asset: CELO_CHAIN.usdc, payTo, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" },
    });
    const arcUsdc = (payTo: string) => ({
      scheme: "exact", network: ARC, amount, asset: ARC_CHAIN.usdc, payTo, maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" },
    });

    const THIN = 5;
    const items: { url: string; accepts: unknown[]; payers: number; calls: number }[] = [];
    const push = (url: string, accepts: unknown[], payers = 10, calls = 100) => items.push({ url, accepts, payers, calls });
    for (let i = 0; i < FAT_N; i++) push(`https://fat-celo.example/n/${i}`, [baseUsdc(addr(0x11)), celoUsdc(addr(0x11))]);
    for (let i = 0; i < THIN; i++) push(`https://thin-celo-${i}.example/api`, [baseUsdc(addr(0x20 + i)), celoUsdc(addr(0x20 + i))]);
    push("https://primary-celo.example/api", [celoUsdc(addr(0x30))]);
    push("https://tried.example/a", [baseUsdc(addr(0x31)), celoUsdc(addr(0x31))]);
    push("https://tried.example/b", [baseUsdc(addr(0x31)), celoUsdc(addr(0x31))]);
    for (let i = 0; i < FAT_N; i++) push(`https://fat-arc.example/n/${i}`, [arcUsdc(addr(0x40))]);
    for (let i = 0; i < THIN; i++) push(`https://thin-arc-${i}.example/api`, [arcUsdc(addr(0x50 + i))]);
    push("https://base-high.example/api", [baseUsdc(addr(0x60))], 900, 9000);
    push("https://base-mid.example/api", [baseUsdc(addr(0x61))], 800, 8000);
    push("https://base-low.example/api", [baseUsdc(addr(0x62))], 700, 7000);

    const catalog = new Map(items.map((item) => [item.url, item.accepts]));
    await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`);
    const parsed = items.map((item) =>
      parseCatalogItem({
        resource: item.url,
        accepts: item.accepts,
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        quality: { l30DaysTotalCalls: item.calls, l30DaysUniquePayers: item.payers },
      }),
    );
    await syncCatalog({ fetchResult: { items: parsed, totalCount: parsed.length, fetchedCount: parsed.length, complete: true }, today: "2026-10-26" });
    await runL0ProbeBatch({
      limit: parsed.length + 10,
      concurrency: 8,
      fetchImpl: async (url: string) =>
        new Response(JSON.stringify({ x402Version: 2, accepts: catalog.get(url) ?? [] }), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
    });

    await db.execute(sql`
      UPDATE x402_endpoints SET
        quality_payers_30d = CASE resource_url
          WHEN 'https://base-high.example/api' THEN 900
          WHEN 'https://base-mid.example/api' THEN 800
          WHEN 'https://base-low.example/api' THEN 700
          ELSE 10
        END,
        quality_calls_30d = CASE resource_url
          WHEN 'https://base-high.example/api' THEN 9000
          WHEN 'https://base-mid.example/api' THEN 8000
          WHEN 'https://base-low.example/api' THEN 7000
          ELSE 100
        END,
        first_seen_at = CASE
          WHEN resource_url LIKE 'https://fat-celo.example/n/%'
            THEN timestamptz '2020-01-01+00' + (substring(resource_url from '/n/([0-9]+)$')::int) * interval '1 second'
          WHEN resource_url LIKE 'https://fat-arc.example/n/%'
            THEN timestamptz '2020-01-01+00' + (substring(resource_url from '/n/([0-9]+)$')::int) * interval '1 second'
          WHEN resource_url = 'https://tried.example/a' OR resource_url = 'https://tried.example/b'
            THEN timestamptz '2023-01-01+00'
          WHEN resource_url = 'https://primary-celo.example/api'
            THEN timestamptz '2024-06-01+00'
          WHEN resource_url LIKE 'https://thin-celo-%.example/api'
            THEN timestamptz '2025-01-01+00' + (substring(resource_url from 'thin-celo-([0-9]+)')::int) * interval '1 day'
          WHEN resource_url LIKE 'https://thin-arc-%.example/api'
            THEN timestamptz '2025-06-01+00' + (substring(resource_url from 'thin-arc-([0-9]+)')::int) * interval '1 day'
          ELSE timestamptz '2026-01-01+00'
        END
    `);

    const passed = await db.execute(sql`
      SELECT count(*)::int AS n
      FROM x402_endpoints e
      JOIN LATERAL (
        SELECT verdict FROM x402_l0_probes p WHERE p.endpoint_id = e.id ORDER BY probed_at DESC LIMIT 1
      ) lp ON lp.verdict = 'pass'
    `);
    const passRows = (Array.isArray(passed) ? passed : ((passed as { rows?: unknown[] }).rows ?? [])) as { n: number }[];
    assert.equal(Number(passRows[0]?.n), parsed.length, "L0 が全出品を pass にしている");

    const tried = await db.execute(sql`SELECT id FROM x402_endpoints WHERE resource_url = 'https://tried.example/a'`);
    const triedRows = (Array.isArray(tried) ? tried : ((tried as { rows?: unknown[] }).rows ?? [])) as { id: string }[];
    assert.equal(triedRows.length, 1);
    await db.insert(schema.x402L1Purchases).values(
      [0, 1, 2].map(() => ({
        endpointId: triedRows[0].id,
        status: "settle_claimed",
        payer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        network: CELO,
        asset: CELO_CHAIN.usdc,
        payTo: addr(0x31),
        amountUnits: amount,
        spentUnits: amount,
      })),
    );

    let txSeq = 0;
    const seen: { url: string; network: string | null }[] = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const sig = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
      const decoded = sig
        ? (JSON.parse(Buffer.from(sig, "base64").toString("utf8")) as { accepted?: { network?: string } })
        : null;
      if (sig) seen.push({ url, network: decoded?.accepted?.network ?? null });
      if (!sig) {
        return new Response(JSON.stringify({ x402Version: 2, accepts: catalog.get(url) ?? [] }), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      }
      txSeq += 1;
      return new Response(JSON.stringify({ data: "goods" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "PAYMENT-RESPONSE": Buffer.from(
            JSON.stringify({
              success: true,
              transaction: `0x${txSeq.toString(16).padStart(64, "0")}`,
              network: String(decoded?.accepted?.network ?? BASE),
              payer: "0x0000000000000000000000000000000000000001",
            }),
          ).toString("base64"),
        },
      });
    };

    const summary = await runL1Batch({
      limit: 3,
      fetchImpl,
      getPayerUsdcBalance: async () => 1_000_000_000n,
    });
    assert.equal(summary.stoppedForDeadline, false, JSON.stringify(summary.laneFloor));
    assert.equal(summary.payerUnfunded, 0, JSON.stringify(summary.payerFundsUnreadable));
    assert.equal(summary.sellerCapped, 0);

    const hostOf = (url: string) => new URL(url).hostname;
    const celoPaid = seen.filter((row) => row.network === CELO);
    const celoHosts = celoPaid.map((row) => hostOf(row.url));
    const celoCount = new Map<string, number>();
    for (const host of celoHosts) celoCount.set(host, (celoCount.get(host) ?? 0) + 1);
    assert.deepEqual(
      [...celoCount.keys()].sort(),
      ["fat-celo.example", "primary-celo.example", "thin-celo-0.example", "thin-celo-1.example"],
    );
    assert.equal(celoCount.get("fat-celo.example"), 2);
    assert.equal(celoCount.get("primary-celo.example"), 1);
    assert.ok(!celoHosts.includes("tried.example"));
    for (const count of celoCount.values()) assert.ok(count <= 2);
    assert.equal(summary.laneFloor.celo, 5);

    const arcPaid = seen.filter((row) => row.network === ARC);
    assert.ok(arcPaid.length > 0 && arcPaid.length <= 2, `arc payments ${arcPaid.length}`);
    assert.ok(arcPaid.every((row) => hostOf(row.url) === "fat-arc.example"));
    assert.equal(summary.laneFloor.arc, arcPaid.length);
    assert.ok((summary.laneFloorHostCapped.arc ?? 0) > 0, "Arc は JS のホスト上限で細いホストに届かない");

    const basePaid = seen.filter((row) => row.network === BASE).map((row) => row.url);
    assert.deepEqual(basePaid, [
      "https://base-high.example/api",
      "https://base-mid.example/api",
      "https://base-low.example/api",
    ]);
  });
}
