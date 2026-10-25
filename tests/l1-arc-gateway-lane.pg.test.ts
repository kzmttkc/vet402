// L1 Circle Gateway rail on Arc. Flag, cap, balance, and the native Arc lane.
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-arc-gateway-lane.pg.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const ARC_BASE_URL = "https://arc-base.example/api";
  const ARC_BASE_PAYTO = "0x7777777777777777777777777777777777777777";

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
      [ARC_BASE_URL]: [gw(ARC_BASE_PAYTO), base(ARC_BASE_PAYTO)],
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
      const runner = readFileSync(new URL("../src/lib/observatory/l1-runner.ts", import.meta.url), "utf8");
      assert.equal(
        runner.includes('{ chain: "arc_gateway", ready: isArcGatewayL1Enabled() && !!process.env.ARC_RPC_URL?.trim() },'),
        true,
      );
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

    async function paidOutcome(status: number | null) {
      await seed([GW_URL]);
      process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = "true";
      delete process.env.OBSERVATORY_ARC_L1_ENABLED;
      delete process.env.L1_ARC_GATEWAY_DAILY_CAP_USD;
      const w = wall();
      const fetchImpl: typeof fetch = async (input, init) => {
        const headers = new Headers(init?.headers);
        const paid = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
        if (!paid) return w.fetchImpl(input, init);
        if (status === null) throw new Error("seller_silent");
        return new Response(JSON.stringify({ data: "no" }), { status, headers: { "content-type": "application/json" } });
      };
      await run(fetchImpl, async () => 5_000_000n);
      return ledger(GW_URL);
    }

    await t.test("応答なし・402・500 は settle_claimed にしない", async () => {
      for (const status of [null, 402, 500] as const) {
        const rows = await paidOutcome(status);
        assert.equal(rows.length, 1, String(status));
        assert.equal(rows[0]?.status, "settle_failed", String(status));
        assert.equal(rows[0]?.rail, "true");
        assert.equal(rows[0]?.tx_hash, null);
      }
      const quiet = await paidOutcome(200);
      assert.equal(quiet[0]?.status, "delivered_no_receipt");
      assert.equal(quiet[0]?.rail, "true");
    });

    await t.test("旗 off では Base と Gateway を受ける出品を Base で買う", async () => {
      await seed([BASE_GW_URL, ARC_BASE_URL]);
      delete process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED;
      process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
      const w = wall();
      await run(w.fetchImpl, async () => 5_000_000n);
      const basePaid = w.seen.filter((s) => s.url === BASE_GW_URL && s.paid);
      assert.equal(basePaid.length, 1);
      assert.equal(basePaid[0]?.accepted?.network, BASE);
      assert.notEqual((await ledger(BASE_GW_URL))[0]?.rail, "true");
      const arcPaid = w.seen.filter((s) => s.url === ARC_BASE_URL && s.paid);
      assert.equal(arcPaid.length, 1);
      assert.equal(arcPaid[0]?.accepted?.network, BASE);
      assert.notEqual((await ledger(ARC_BASE_URL))[0]?.rail, "true");
    });

    await t.test("旗 on でも Base で払える出品は Gateway で払わない", async () => {
      await seed([BASE_GW_URL, ARC_BASE_URL]);
      process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = "true";
      process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
      const w = wall();
      await run(w.fetchImpl, async () => 5_000_000n);
      for (const url of [BASE_GW_URL, ARC_BASE_URL]) {
        const paid = w.seen.filter((s) => s.url === url && s.paid);
        assert.equal(paid.length, 1, url);
        assert.equal(paid[0]?.accepted?.network, BASE, url);
        assert.notEqual((await ledger(url))[0]?.rail, "true");
      }
    });

    await t.test("旗 on の onlyEndpointId は Gateway だけの 1 件を買う", async () => {
      await seed([GW_URL, BASE_URL]);
      process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = "true";
      const raw = await db.execute(sql`SELECT id::text AS id FROM x402_endpoints WHERE resource_url = ${GW_URL}`);
      const id = ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { id: string }[])[0]?.id;
      assert.ok(id);
      const w = wall();
      await runL1Batch({
        limit: 10,
        onlyEndpointId: id,
        fetchImpl: w.fetchImpl,
        getPayerUsdcBalance: funded,
        readArcGatewayAvailable: async () => 5_000_000n,
      });
      const paid = w.seen.filter((s) => s.paid);
      assert.equal(paid.length, 1);
      assert.equal((paid[0]?.accepted?.extra as { name?: string } | undefined)?.name, "GatewayWalletBatched");
      assert.equal((await ledger(BASE_URL)).length, 0);
    });

    await t.test("ライブの 402 に Base があれば Gateway の拒否で止めない", async () => {
      await seed([GW_URL]);
      process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = "true";
      const wrong = "0x9999999999999999999999999999999999999999";
      const w = wall({ [GW_URL]: [gw(wrong), base(GW_PAYTO)] });
      await run(w.fetchImpl, async () => 5_000_000n);
      const paid = w.seen.filter((s) => s.paid);
      assert.equal(paid.length, 1);
      assert.equal(paid[0]?.accepted?.network, BASE);
      const rows = await ledger(GW_URL);
      assert.equal(rows.length, 1);
      assert.notEqual(rows[0]?.status, "payto_mismatch");
      assert.notEqual(rows[0]?.rail, "true");
    });

    await t.test("署名後の窓が上限を外れたら行もヘッダも出さない", async () => {
      await seed([GW_URL]);
      process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = "true";
      const w = wall();
      await runL1Batch({
        limit: 10,
        fetchImpl: w.fetchImpl,
        getPayerUsdcBalance: funded,
        readArcGatewayAvailable: async () => 5_000_000n,
        signArcGateway: async () => ({
          header: { headerName: "PAYMENT-SIGNATURE", headerValue: "not-sent" },
          authorization: {
            from: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
            to: GW_PAYTO,
            value: "1000",
            validAfter: "1",
            validBefore: String(Math.floor(Date.now() / 1000) + 10_000_000),
            nonce: `0x${"ab".repeat(32)}`,
          },
          signature: `0x${"11".repeat(65)}`,
          verifyingContract: ARC_GATEWAY_WALLET,
        }),
      });
      assert.equal(w.seen.filter((s) => s.paid).length, 0);
      assert.deepEqual(await ledger(GW_URL), []);
    });

    await t.test("残高が読めない失敗はログに残る", async () => {
      await seed([GW_URL]);
      process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = "true";
      const w = wall();
      const lines: string[] = [];
      const orig = console.error;
      console.error = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      try {
        await run(w.fetchImpl, async () => {
          throw new Error("balance down");
        });
      } finally {
        console.error = orig;
      }
      assert.equal(w.seen.filter((s) => s.paid).length, 0);
      assert.ok(lines.some((line) => line.includes("[vouch] observatory.l1.arc_gateway_balance")));
    });

    await t.test("応答しない Gateway API でもネイティブの照合は走る", async () => {
      await seed([BASE_URL]);
      const raw = await db.execute(sql`SELECT id::text AS id FROM x402_endpoints WHERE resource_url = ${BASE_URL}`);
      const id = ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { id: string }[])[0]?.id;
      assert.ok(id);
      const nonce = `0x${"ab".repeat(32)}`;
      await db.insert(schema.x402L1Purchases).values({
        endpointId: id,
        status: "settle_claimed",
        network: BASE,
        asset: BASE_USDC,
        payTo: BASE_ONLY_PAYTO,
        payer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        amountUnits: "1000",
        spentUnits: "1000",
        txHash: `0x${"cd".repeat(32)}`,
      });
      await db.insert(schema.x402L1Purchases).values({
        endpointId: id,
        status: "delivered_no_receipt",
        network: ARC,
        asset: ARC_USDC,
        payTo: GW_PAYTO,
        payer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        amountUnits: "1000",
        spentUnits: "1000",
        rawResponseMeta: {
          circleGatewayRail: "true",
          circleGateway: {
            from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
            to: GW_PAYTO,
            value: "1000",
            validAfter: "1",
            validBefore: "9999999999",
            nonce,
            signature: `0x${"11".repeat(65)}`,
            verifyingContract: ARC_GATEWAY_WALLET,
          },
        },
      });
      const { runSettlementVerification } = await import("@/lib/observatory/settlement-verifier");
      let sawSignal = false;
      let nativeRan = false;
      await runSettlementVerification({
        budgetMs: 20_000,
        deps: {
          gatewayFetchTimeoutMs: 200,
          verifySignature: async () => true,
          readGatewayDebit: async () => 1000n,
          gatewayFetch: (async (_input: unknown, init?: RequestInit) => {
            sawSignal = Boolean(init?.signal);
            if (!init?.signal) throw new Error("missing signal");
            await new Promise<void>((_resolve, reject) => {
              const timer = setTimeout(() => reject(new Error("hung")), 30_000);
              init.signal?.addEventListener("abort", () => {
                clearTimeout(timer);
                reject(new Error("aborted"));
              });
            });
            return new Response("no");
          }) as typeof fetch,
          verify: async () => {
            nativeRan = true;
            return { ok: false, reason: "rpc_unavailable" };
          },
        },
      });
      assert.equal(sawSignal, true);
      assert.equal(nativeRan, true);
    });

    await t.test("delivered_no_receipt は請求が一致したら settled になる", async () => {
      await seed([BASE_URL]);
      const raw = await db.execute(sql`SELECT id::text AS id FROM x402_endpoints WHERE resource_url = ${BASE_URL}`);
      const id = ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { id: string }[])[0]?.id;
      assert.ok(id);
      const nonce = `0x${"ef".repeat(32)}`;
      const tx = `0x${"12".repeat(32)}`;
      await db.insert(schema.x402L1Purchases).values({
        endpointId: id,
        status: "delivered_no_receipt",
        network: ARC,
        asset: ARC_USDC,
        payTo: GW_PAYTO,
        payer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        amountUnits: "1000",
        spentUnits: "1000",
        rawResponseMeta: {
          circleGatewayRail: "true",
          circleGateway: {
            from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
            to: GW_PAYTO,
            value: "1000",
            validAfter: "1",
            validBefore: "9999999999",
            nonce,
            signature: `0x${"22".repeat(65)}`,
            verifyingContract: ARC_GATEWAY_WALLET,
          },
        },
      });
      const { reconcileArcGatewayClaims } = await import("@/lib/observatory/arc-gateway-verify");
      const summary = await reconcileArcGatewayClaims({
        db,
        verifySignature: async () => true,
        readDebit: async () => 1000n,
        fetchImpl: async () =>
          new Response(JSON.stringify({ transfers: [{ nonce, status: "confirmed", txHash: tx, from: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", amount: "1000" }] }), { status: 200 }),
      });
      assert.equal(summary.settled, 1);
      const after = await db.execute(sql`
        SELECT status, settlement_verified, tx_hash
        FROM x402_l1_purchases
        WHERE raw_response_meta->>'circleGatewayRail' = 'true'
      `);
      const rows = (Array.isArray(after) ? after : (after as { rows?: unknown[] }).rows ?? []) as { status: string; settlement_verified: boolean; tx_hash: string | null }[];
      assert.equal(rows[0]?.status, "settled");
      assert.equal(rows[0]?.settlement_verified, true);
      assert.equal(rows[0]?.tx_hash, null);
    });

    function rowsOf(raw: unknown): Record<string, unknown>[] {
      if (Array.isArray(raw)) return raw as Record<string, unknown>[];
      const rows = (raw as { rows?: unknown[] } | null)?.rows;
      return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    }

    async function endpointId(): Promise<string> {
      const raw = await db.execute(sql`SELECT id::text AS id FROM x402_endpoints WHERE resource_url = ${BASE_URL}`);
      const id = rowsOf(raw)[0]?.id;
      assert.equal(typeof id, "string");
      return String(id);
    }

    const BUYER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";

    await t.test("期限切れは status に書け、照合済みにはしない", async () => {
      await seed([BASE_URL]);
      const id = await endpointId();
      const nonce = `0x${"a1".repeat(32)}`;
      await db.insert(schema.x402L1Purchases).values({
        endpointId: id,
        status: "settle_claimed",
        network: ARC,
        asset: ARC_USDC,
        payTo: GW_PAYTO,
        payer: BUYER,
        amountUnits: "1000",
        spentUnits: "1000",
        rawResponseMeta: {
          circleGatewayRail: "true",
          circleGateway: {
            from: BUYER,
            to: GW_PAYTO,
            value: "1000",
            validAfter: "1",
            validBefore: "100",
            nonce,
            signature: `0x${"11".repeat(65)}`,
            verifyingContract: ARC_GATEWAY_WALLET,
          },
        },
      });
      const { reconcileArcGatewayClaims } = await import("@/lib/observatory/arc-gateway-verify");
      const summary = await reconcileArcGatewayClaims({
        db,
        verifySignature: async () => true,
        readDebit: async () => 1000n,
        fetchImpl: async () => new Response(JSON.stringify({ transfers: [] }), { status: 200 }),
      });
      assert.equal(summary.expired, 1);
      const after = rowsOf(await db.execute(sql`
        SELECT status, settlement_verified, settlement_verify_reason
        FROM x402_l1_purchases
        WHERE raw_response_meta->>'circleGatewayRail' = 'true'
      `));
      assert.equal(after[0]?.status, "gateway_not_charged_expired");
      assert.equal(after[0]?.settlement_verified, false);
      assert.equal(after[0]?.settlement_verify_reason, "gateway_not_charged_expired");
    });

    await t.test("nonce 未取得の行は、古い pending が limit を埋めても先に進む", async () => {
      await seed([BASE_URL]);
      const id = await endpointId();
      await db.execute(sql`
        INSERT INTO x402_l1_purchases (
          endpoint_id, status, network, asset, pay_to, payer, amount_units, spent_units, attempted_at, raw_response_meta
        )
        SELECT
          ${id}::uuid,
          'settle_claimed',
          ${ARC},
          ${ARC_USDC},
          ${GW_PAYTO},
          ${BUYER},
          '1000',
          '1000',
          timestamptz '2026-01-01 00:00:00+00' + (gs * interval '1 second'),
          jsonb_build_object(
            'circleGatewayRail', 'true',
            'circleGateway', jsonb_build_object(
              'from', ${BUYER}::text,
              'to', ${GW_PAYTO}::text,
              'value', '1000',
              'validAfter', '1',
              'validBefore', '100',
              'nonce', '0x' || lpad(to_hex(1000 + gs), 64, '0'),
              'nonceLookup', 'pending',
              'signature', '0x' || repeat('11', 65),
              'verifyingContract', ${ARC_GATEWAY_WALLET}::text
            )
          )
        FROM generate_series(0, 29) AS gs
      `);
      await db.execute(sql`
        INSERT INTO x402_l1_purchases (
          endpoint_id, status, network, asset, pay_to, payer, amount_units, spent_units, attempted_at, raw_response_meta
        )
        SELECT
          ${id}::uuid,
          'settle_claimed',
          ${ARC},
          ${ARC_USDC},
          ${GW_PAYTO},
          ${BUYER},
          '1000',
          '1000',
          timestamptz '2026-06-01 00:00:00+00' + (gs * interval '1 second'),
          jsonb_build_object(
            'circleGatewayRail', 'true',
            'circleGateway', jsonb_build_object(
              'from', ${BUYER}::text,
              'to', ${GW_PAYTO}::text,
              'value', '1000',
              'validAfter', '1',
              'validBefore', '100',
              'nonce', '0x' || lpad(to_hex(gs), 64, '0'),
              'signature', '0x' || repeat('22', 65),
              'verifyingContract', ${ARC_GATEWAY_WALLET}::text
            )
          )
        FROM generate_series(0, 4) AS gs
      `);
      const { reconcileArcGatewayClaims } = await import("@/lib/observatory/arc-gateway-verify");
      const summary = await reconcileArcGatewayClaims({
        db,
        limit: 10,
        verifySignature: async () => true,
        readDebit: async () => 1000n,
        fetchImpl: (async (input: unknown) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
          const nonce = new URL(url).searchParams.get("nonce") ?? "0x0";
          const pending = BigInt(nonce) >= 1000n;
          const body = pending
            ? { transfers: [{ nonce, status: "batched" }] }
            : { transfers: [] };
          return new Response(JSON.stringify(body), { status: 200 });
        }) as typeof fetch,
      });
      assert.equal(summary.expired, 5);
      const after = rowsOf(await db.execute(sql`
        SELECT
          count(*) FILTER (WHERE status = 'gateway_not_charged_expired')::int AS expired,
          count(*) FILTER (
            WHERE raw_response_meta->'circleGateway'->>'nonceLookup' = 'pending'
              AND status = 'settle_claimed'
              AND settlement_verified IS NULL
          )::int AS pending_open
        FROM x402_l1_purchases
        WHERE raw_response_meta->>'circleGatewayRail' = 'true'
      `))[0];
      assert.equal(Number(after?.expired), 5);
      assert.equal(Number(after?.pending_open), 30);
    });

    await t.test("遅い Gateway API でも 2000 行の未照合は毎回進み、ネイティブ照合も走る", async () => {
      await seed([BASE_URL]);
      const id = await endpointId();
      await db.execute(sql`
        INSERT INTO x402_l1_purchases (
          endpoint_id, status, network, asset, pay_to, payer, amount_units, spent_units, attempted_at, raw_response_meta
        )
        SELECT
          ${id}::uuid,
          'settle_claimed',
          ${ARC},
          ${ARC_USDC},
          ${GW_PAYTO},
          '0x' || lpad(to_hex(gs), 40, '0'),
          '1000',
          '1000',
          timestamptz '2026-01-01 00:00:00+00' + (gs * interval '1 second'),
          jsonb_build_object(
            'circleGatewayRail', 'true',
            'circleGateway', jsonb_build_object(
              'from', '0x' || lpad(to_hex(gs), 40, '0'),
              'to', ${GW_PAYTO}::text,
              'value', '1000',
              'validAfter', '1',
              'validBefore', CASE WHEN gs % 3 = 1 THEN '100' ELSE '9999999999' END,
              'nonce', '0x' || lpad(to_hex(gs), 64, '0'),
              'signature', '0x' || repeat('33', 65),
              'verifyingContract', ${ARC_GATEWAY_WALLET}::text
            )
          )
        FROM generate_series(0, 1999) AS gs
      `);
      await db.insert(schema.x402L1Purchases).values({
        endpointId: id,
        status: "settle_claimed",
        network: BASE,
        asset: BASE_USDC,
        payTo: BASE_ONLY_PAYTO,
        payer: BUYER,
        amountUnits: "1000",
        spentUnits: "1000",
        txHash: `0x${"cd".repeat(32)}`,
      });
      const { runSettlementVerification } = await import("@/lib/observatory/settlement-verifier");
      const seen = { settled: 0, expired: 0, noted: 0 };
      for (let run = 0; run < 3; run += 1) {
        let calls = 0;
        let nativeRan = false;
        const summary = await runSettlementVerification({
          budgetMs: 25_000,
          deps: {
            verifySignature: async (auth) => BigInt(auth.nonce) % 3n !== 2n,
            readGatewayDebit: async () => 1000n,
            gatewayFetch: (async (input: unknown) => {
              calls += 1;
              if (calls > 2) await new Promise((resolve) => setTimeout(resolve, 2_500));
              const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : String(input);
              const nonce = new URL(url).searchParams.get("nonce") ?? "0x0";
              const kind = Number(BigInt(nonce) % 3n);
              if (kind === 1) return new Response(JSON.stringify({ transfers: [] }), { status: 200 });
              const from = `0x${BigInt(nonce).toString(16).padStart(40, "0")}`;
              return new Response(JSON.stringify({
                transfers: [{ nonce, status: "confirmed", txHash: nonce, from, amount: "1000" }],
              }), { status: 200 });
            }) as typeof fetch,
            verify: async () => {
              nativeRan = true;
              return { ok: false, reason: "rpc_unavailable" };
            },
          },
        });
        assert.equal(nativeRan, true);
        assert.ok(summary.verified > 0);
        assert.ok(summary.gatewayExpired > 0);
        assert.ok(summary.gatewayNoted > 0);
        assert.ok(summary.verified + summary.gatewayExpired + summary.gatewayNoted < 200);
        const counts = rowsOf(await db.execute(sql`
          SELECT
            count(*) FILTER (WHERE status = 'settled' AND settlement_verified IS TRUE)::int AS settled,
            count(*) FILTER (
              WHERE status = 'gateway_not_charged_expired' AND settlement_verified IS FALSE
            )::int AS expired,
            count(*) FILTER (
              WHERE raw_response_meta->'circleGateway'->>'note' = 'gateway_signature_invalid'
            )::int AS noted,
            count(*) FILTER (
              WHERE settlement_verified IS NULL
                AND raw_response_meta->>'circleGatewayRail' = 'true'
                AND coalesce(raw_response_meta->'circleGateway'->>'nonceLookup', '') = ''
            )::int AS unread
          FROM x402_l1_purchases
        `))[0];
        const settled = Number(counts?.settled);
        const expired = Number(counts?.expired);
        const noted = Number(counts?.noted);
        const unread = Number(counts?.unread);
        assert.ok(settled > seen.settled);
        assert.ok(expired > seen.expired);
        assert.ok(noted > seen.noted);
        assert.equal(summary.gatewayExpired, expired - seen.expired);
        assert.ok(unread > 1500);
        seen.settled = settled;
        seen.expired = expired;
        seen.noted = noted;
      }
    });

    await t.test("減額が行より大きい照合は summary に残り、status は倒さない", async () => {
      await seed([BASE_URL]);
      const id = await endpointId();
      const nonce = `0x${"b2".repeat(32)}`;
      const tx = `0x${"c3".repeat(32)}`;
      await db.insert(schema.x402L1Purchases).values({
        endpointId: id,
        status: "settle_claimed",
        network: ARC,
        asset: ARC_USDC,
        payTo: GW_PAYTO,
        payer: BUYER,
        amountUnits: "1000",
        spentUnits: "1000",
        rawResponseMeta: {
          circleGatewayRail: "true",
          circleGateway: {
            from: BUYER,
            to: GW_PAYTO,
            value: "1000",
            validAfter: "1",
            validBefore: "9999999999",
            nonce,
            signature: `0x${"44".repeat(65)}`,
            verifyingContract: ARC_GATEWAY_WALLET,
          },
        },
      });
      const { runSettlementVerification } = await import("@/lib/observatory/settlement-verifier");
      const summary = await runSettlementVerification({
        budgetMs: 25_000,
        deps: {
          verifySignature: async () => true,
          readGatewayDebit: async () => 5000n,
          gatewayFetch: (async () => new Response(JSON.stringify({
            transfers: [{ nonce, status: "confirmed", txHash: tx, from: BUYER, amount: "1000" }],
          }), { status: 200 })) as typeof fetch,
        },
      });
      assert.equal(summary.gatewayOverDebit, 1);
      assert.equal(summary.verified, 0);
      const after = rowsOf(await db.execute(sql`
        SELECT status, settlement_verified
        FROM x402_l1_purchases
        WHERE raw_response_meta->>'circleGatewayRail' = 'true'
      `))[0];
      assert.equal(after?.status, "settle_claimed");
      assert.equal(after?.settlement_verified, null);
    });

    await t.test("日次の境界はセッションのタイムゾーンではなく UTC", async () => {
      await seed([BASE_URL]);
      const id = await endpointId();
      const inserted = rowsOf(await db.execute(sql`
        INSERT INTO x402_l1_purchases (
          endpoint_id, status, network, asset, pay_to, payer, amount_units, spent_units, attempted_at
        )
        VALUES (
          ${id}::uuid, 'settle_claimed', ${BASE}, ${BASE_USDC}, ${BASE_ONLY_PAYTO}, ${BUYER}, '1000', '1000',
          timestamptz '2026-10-25 15:00:00+00'
        )
        RETURNING id::text AS id
      `));
      const rowId = String(inserted[0]?.id);
      const compared = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('TimeZone', 'Asia/Tokyo', true)`);
        return rowsOf(await tx.execute(sql`
          SELECT
            count(*) FILTER (
              WHERE attempted_at >= ('2026-10-25'::timestamp AT TIME ZONE 'UTC')
                AND attempted_at < (('2026-10-25'::timestamp + interval '1 day') AT TIME ZONE 'UTC')
            )::int AS utc_day,
            count(*) FILTER (
              WHERE attempted_at >= '2026-10-25'::date
                AND attempted_at < '2026-10-26'::date
            )::int AS session_day
          FROM x402_l1_purchases
          WHERE id = ${rowId}::uuid
        `))[0];
      });
      assert.equal(Number(compared?.utc_day), 1);
      assert.equal(Number(compared?.session_day), 0);
    });
  });
}
