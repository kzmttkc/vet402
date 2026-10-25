// L1 Circle Gateway rail on Arc. Flag, cap, balance, and the native Arc lane.
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-arc-gateway-lane.pg.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 arc gateway lane (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const ARC = "eip155:5042";
  const BASE = "eip155:8453";
  const GW_PAYTO = "0x1111111111111111111111111111111111111111";
  const NATIVE_PAYTO = "0x2222222222222222222222222222222222222222";
  const DUAL_PAYTO = "0x4444444444444444444444444444444444444444";
  const BASE_PAYTO = "0x3333333333333333333333333333333333333333";
  const BASE_GW_PAYTO = "0x5555555555555555555555555555555555555555";
  const BASE_ONLY_PAYTO = "0x6666666666666666666666666666666666666666";
  const GW_URL = "https://gw-only.example/api";
  const NATIVE_URL = "https://native-arc.example/api";
  const DUAL_URL = "https://dual-arc.example/api";
  const BASE_GW_URL = "https://base-gw.example/api";
  const BASE_URL = "https://base-only.example/api";

  test("L1 Arc Gateway lane", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { ARC_USDC, BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { ARC_GATEWAY_WALLET } = await import("@/lib/observatory/arc-gateway");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const ENV = [
      "OBSERVATORY_L1_ENABLED",
      "OBSERVATORY_WALLET_PRIVATE_KEY",
      "OBSERVATORY_ARC_GATEWAY_L1_ENABLED",
      "OBSERVATORY_ARC_L1_ENABLED",
      "OBSERVATORY_ARBITRUM_L1_ENABLED",
      "OBSERVATORY_CELO_L1_ENABLED",
      "OBSERVATORY_BNB_L1_ENABLED",
      "OBSERVATORY_STELLAR_L1_ENABLED",
      "OBSERVATORY_SOLANA_L1_ENABLED",
      "OBSERVATORY_TEMPO_L1_ENABLED",
      "OBSERVATORY_XRPL_L1_ENABLED",
      "OBSERVATORY_L1_CENSUS",
      "L1_ARC_GATEWAY_DAILY_CAP_USD",
      "L1_ARC_DAILY_CAP_USD",
      "L1_SELLER_DAILY_CAP_USD",
      "L1_DOMAIN_DAILY_CAP_USD",
      "L1_LANE_FLOOR_PER_RUN",
      "VET402_OPERATOR_PAYTO",
      "ARC_RPC_URL",
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
    process.env.ARC_RPC_URL = "http://127.0.0.1:9/arc-gateway-test-rpc";

    const gw = (payTo: string, amount = "1000") => ({
      scheme: "exact", network: ARC, amount, asset: ARC_USDC, payTo, maxTimeoutSeconds: 60,
      extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: ARC_GATEWAY_WALLET },
    });
    const native = (payTo: string, amount = "1000") => ({
      scheme: "exact", network: ARC, amount, asset: ARC_USDC, payTo, maxTimeoutSeconds: 60,
      extra: { name: "USDC", version: "2" },
    });
    const base = (payTo: string, amount = "1000") => ({
      scheme: "exact", network: BASE, amount, asset: BASE_USDC, payTo, maxTimeoutSeconds: 60,
      extra: { name: "USD Coin", version: "2" },
    });
    const CATALOG: Record<string, unknown[]> = {
      [GW_URL]: [gw(GW_PAYTO)],
      [NATIVE_URL]: [native(NATIVE_PAYTO)],
      [DUAL_URL]: [native(DUAL_PAYTO), gw(DUAL_PAYTO)],
      [BASE_GW_URL]: [base(BASE_PAYTO), gw(BASE_GW_PAYTO)],
      [BASE_URL]: [base(BASE_ONLY_PAYTO)],
    };

    let txSeq = 0;
    const wall = (over: Record<string, unknown[]> = {}) => {
      const seen: { url: string; paid: boolean; accepted: Record<string, unknown> | null; authorization: Record<string, string> | null }[] = [];
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const headers = new Headers(init?.headers);
        const sig = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
        const decoded = sig
          ? (JSON.parse(Buffer.from(sig, "base64").toString("utf8")) as {
              accepted?: Record<string, unknown>;
              payload?: { authorization?: Record<string, string> };
            })
          : null;
        seen.push({ url, paid: sig !== null, accepted: decoded?.accepted ?? null, authorization: decoded?.payload?.authorization ?? null });
        if (!sig) {
          return new Response(JSON.stringify({ x402Version: 2, accepts: over[url] ?? CATALOG[url] ?? [] }), {
            status: 402,
            headers: { "content-type": "application/json" },
          });
        }
        txSeq += 1;
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({
              success: true,
              transaction: `0x${txSeq.toString(16).padStart(64, "a")}`,
              network: String(decoded?.accepted?.network ?? BASE),
            })).toString("base64"),
          },
        });
      };
      return { seen, fetchImpl };
    };

    async function seed(urls: string[]) {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`);
      const items = urls.map((resource) => parseCatalogItem({
        resource,
        accepts: CATALOG[resource],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        quality: { l30DaysTotalCalls: 100, l30DaysUniquePayers: 10 },
      }));
      await syncCatalog({ fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true }, today: "2026-10-25" });
      await runL0ProbeBatch({
        limit: 10,
        concurrency: 2,
        fetchImpl: async (url: string) => new Response(JSON.stringify({ x402Version: 2, accepts: CATALOG[url] ?? [] }), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
      });
      const raw = await db.execute(sql`
        SELECT e.resource_url, p.verdict
        FROM x402_endpoints e
        JOIN LATERAL (SELECT verdict FROM x402_l0_probes WHERE endpoint_id = e.id ORDER BY probed_at DESC LIMIT 1) p ON true
      `);
      const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { resource_url: string; verdict: string }[];
      for (const url of urls) {
        const row = rows.find((r) => r.resource_url === url);
        assert.equal(row?.verdict, "pass", `${url} L0`);
      }
    }

    const ledger = async (resourceUrl: string) => {
      const raw = await db.execute(sql`
        SELECT pu.status, pu.network, pu.tx_hash, pu.auth_nonce, pu.spent_units,
               pu.raw_response_meta->>'circleGatewayRail' AS rail,
               pu.raw_response_meta->'circleGateway' AS gw
        FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE e.resource_url = ${resourceUrl}
      `);
      return (Array.isArray(raw) ? [...raw] : (raw as { rows?: unknown[] }).rows ?? []) as {
        status: string;
        network: string;
        tx_hash: string | null;
        auth_nonce: string | null;
        spent_units: string;
        rail: string | null;
        gw: Record<string, string> | null;
      }[];
    };

    const funded = async () => 1_000_000_000n;
    const run = (fetchImpl: typeof fetch, readArcGatewayAvailable: () => Promise<bigint | null>) =>
      runL1Batch({
        limit: 10,
        fetchImpl,
        getPayerUsdcBalance: funded,
        readArcGatewayAvailable,
      });

    await t.test("旗 off と true 以外: Gateway の出品に 1 リクエストも出さない", async () => {
      for (const value of [undefined, "1", "TRUE", "on"]) {
        await seed([GW_URL, BASE_URL]);
        if (value === undefined) delete process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED;
        else process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = value;
        const w = wall();
        await run(w.fetchImpl, async () => 5_000_000n);
        assert.equal(w.seen.filter((s) => s.url === GW_URL).length, 0, JSON.stringify(value));
        assert.deepEqual(await ledger(GW_URL), []);
        assert.equal(w.seen.filter((s) => s.url === BASE_URL && s.paid).length, 1);
      }
    });

    await t.test("Gateway だけの出品は Gateway で署名し、tx_hash は空の settle_claimed", async () => {
      await seed([GW_URL]);
      process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = "true";
      const w = wall();
      await run(w.fetchImpl, async () => 5_000_000n);
      const paid = w.seen.filter((s) => s.paid);
      assert.equal(paid.length, 1);
      const extra = paid[0]?.accepted?.extra as { name?: string; verifyingContract?: string } | undefined;
      assert.equal(extra?.name, "GatewayWalletBatched");
      assert.equal(extra?.verifyingContract?.toLowerCase(), ARC_GATEWAY_WALLET.toLowerCase());
      const authz = paid[0]?.authorization;
      assert.ok(authz);
      assert.ok(BigInt(authz.validBefore) - BigInt(authz.validAfter) > 120n);
      const rows = await ledger(GW_URL);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, "settle_claimed");
      assert.equal(rows[0]?.tx_hash, null);
      assert.equal(rows[0]?.network, ARC);
      assert.equal(rows[0]?.rail, "true");
      assert.equal(rows[0]?.auth_nonce, authz.nonce);
      assert.equal(rows[0]?.gw?.value, "1000");
      assert.equal(rows[0]?.gw?.to?.toLowerCase(), GW_PAYTO);
      assert.equal(rows[0]?.spent_units, "1000");
    });

    await t.test("ネイティブの accept は今の Arc レーンのまま。両方ある出品もネイティブ", async () => {
      await seed([NATIVE_URL, DUAL_URL]);
      process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
      process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = "true";
      const w = wall();
      await run(w.fetchImpl, async () => 5_000_000n);
      for (const url of [NATIVE_URL, DUAL_URL]) {
        const paid = w.seen.filter((s) => s.url === url && s.paid);
        assert.equal(paid.length, 1, url);
        const extra = paid[0]?.accepted?.extra as { name?: string } | undefined;
        assert.equal(extra?.name, "USDC");
        assert.notEqual(extra?.name, "GatewayWalletBatched");
        const rows = await ledger(url);
        assert.equal(rows[0]?.rail ?? null, null);
        assert.ok(rows[0]?.tx_hash);
      }
    });

    await t.test("別枠 0 は Gateway の出品にリクエストを出さない", async () => {
      await seed([GW_URL, BASE_URL]);
      process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = "true";
      process.env.L1_ARC_GATEWAY_DAILY_CAP_USD = "0";
      const w = wall();
      await run(w.fetchImpl, async () => 5_000_000n);
      assert.equal(w.seen.filter((s) => s.url === GW_URL).length, 0);
      assert.deepEqual(await ledger(GW_URL), []);
      assert.equal(w.seen.filter((s) => s.url === BASE_URL && s.paid).length, 1);
    });

    await t.test("残高不足と読めないは署名せず、Gateway だけの出品は Base に落とさない", async () => {
      for (const read of [async () => 0n, async () => null, async () => { throw new Error("down"); }]) {
        await seed([GW_URL]);
        process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = "true";
        delete process.env.L1_ARC_GATEWAY_DAILY_CAP_USD;
        const w = wall();
        await run(w.fetchImpl, read);
        assert.equal(w.seen.filter((s) => s.paid).length, 0);
        assert.deepEqual(await ledger(GW_URL), []);
      }
    });

    await t.test("Base 先頭で Gateway の残高が足りない出品は Base で買う", async () => {
      await seed([BASE_GW_URL]);
      process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = "true";
      const w = wall();
      await run(w.fetchImpl, async () => 0n);
      const paid = w.seen.filter((s) => s.paid);
      assert.equal(paid.length, 1);
      assert.equal(paid[0]?.accepted?.network, BASE);
      const rows = await ledger(BASE_GW_URL);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.network, BASE);
      assert.notEqual(rows[0]?.rail, "true");
    });

    await t.test("Gateway の別枠を使い切った日は Gateway では払わない", async () => {
      await seed([GW_URL, BASE_URL]);
      process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = "true";
      const raw = await db.execute(sql`SELECT id FROM x402_endpoints WHERE resource_url = ${BASE_URL}`);
      const list = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { id: string }[];
      const id = list[0]?.id;
      assert.ok(id);
      await db.insert(schema.x402L1Purchases).values({
        endpointId: id,
        status: "settle_claimed",
        payer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        network: ARC,
        asset: ARC_USDC,
        payTo: GW_PAYTO,
        amountUnits: "2000000",
        spentUnits: "2000000",
        rawResponseMeta: { circleGatewayRail: "true" },
      });
      const w = wall();
      await run(w.fetchImpl, async () => 5_000_000n);
      assert.equal(w.seen.filter((s) => s.url === GW_URL).length, 0);
      assert.equal((await ledger(GW_URL)).length, 0);
    });
  });
}
