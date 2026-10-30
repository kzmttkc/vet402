// ============================================================
// 売り手依頼の 1 回きり L1 買い直し（2026-10-30・差し戻し fix round）。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_seller_retest_test \
//   OBSERVATORY_SELLER_RETEST_TEST_LIST=1 \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-seller-retest.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const FUNDED_PAYER = async () => 1_000_000_000n;
const TEST_DB = process.env.TEST_DATABASE_URL;

const SELLER_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS x402_l1_purchases_seller_request_id_auth_unique
  ON x402_l1_purchases ((raw_response_meta->>'sellerRequestId'))
  WHERE raw_response_meta->>'sellerRequestId' IS NOT NULL
    AND auth_nonce IS NOT NULL
`;

if (!TEST_DB) {
  test("l1 seller retest (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;
  process.env.OBSERVATORY_SELLER_RETEST_TEST_LIST = "1";

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const PAYER = "0xf39Fd6e51aad88F6F4ce6bBFCB3678f9CF0C731".toLowerCase();

  test("L1 seller retest requests", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const {
      completedSellerRequestIds,
      pendingSellerRetestRequests,
      validateSellerRequest402,
      SELLER_RETEST_REQUEST_SOURCE,
      ensureSellerRetestEndpoint,
    } = await import("@/lib/observatory/seller-retest");
    const { sellerRetestRequestCatalog, resolveSellerRetestUrl, SELLER_RETEST_MAX_PER_RUN } = await import(
      "@/lib/observatory/seller-retest-requests",
    );
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC, MAX_PER_PURCHASE_UNITS, ARBITRUM_CAIP2, ARBITRUM_CHAIN } = await import("@/lib/observatory/x402-payer");
    const { readSellerBoard } = await import("@/lib/sellers/reader");
    const { getObservatoryStats } = await import("@/lib/observatory/reader");
    const { l0ProbeTierWhere } = await import("@/lib/observatory/coverage");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");

    const db = getDb()!;
    const rowsOf = (raw: unknown): Record<string, unknown>[] =>
      (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];

    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_l1_purchases`,
    );
    await db.execute(sql.raw(SELLER_INDEX_SQL));

    const KEYS = [
      "OBSERVATORY_L1_ENABLED",
      "OBSERVATORY_WALLET_PRIVATE_KEY",
      "OBSERVATORY_L1_CENSUS",
      "L1_LANE_FLOOR_PER_RUN",
      "OBSERVATORY_ARBITRUM_L1_ENABLED",
      "OBSERVATORY_SELLER_RETEST_ENABLED",
      "ARBITRUM_RPC_URL",
    ] as const;
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    t.after(() => {
      for (const k of KEYS) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    delete process.env.OBSERVATORY_L1_CENSUS;
    delete process.env.L1_LANE_FLOOR_PER_RUN;
    delete process.env.OBSERVATORY_ARBITRUM_L1_ENABLED;
    delete process.env.OBSERVATORY_SELLER_RETEST_ENABLED;

    const catalog = sellerRetestRequestCatalog();
    assert.equal(catalog.length, 12);

    const payToForUrl = (url: string): string => {
      const m = /route\/(?:post-)?(\d+)/.exec(url) ?? /route\/query/.exec(url);
      if (url.includes("/route/query")) return catalog[2]!.payTo;
      const n = m ? Number(m[1]) : 1;
      return catalog[n - 1]!.payTo;
    };

    const challengeDoc = (
      url: string,
      payTo: string,
      amount = "5000",
      extraAccepts: { network: string; amount: string; asset: string; payTo: string }[] = [],
    ) =>
      JSON.stringify({
        x402Version: 2,
        accepts: [
          ...extraAccepts,
          {
            scheme: "exact",
            network: "eip155:8453",
            amount,
            asset: BASE_USDC,
            payTo,
            maxTimeoutSeconds: 300,
            extra: { name: "USD Coin", version: "2" },
          },
        ],
      });

    const state = new Map<
      string,
      { paid: boolean; wrongPayTo?: boolean; overCap?: boolean; no402?: boolean; bodyDeclJson?: string }
    >();

    const txForUrl = (url: string) =>
      `0xabc${createHash("sha256").update(url).digest("hex").slice(0, 58)}`;

    const clearPurchases = async () => {
      for (let attempt = 0; attempt < 8; attempt++) {
        await db.execute(sql`TRUNCATE x402_l1_purchases RESTART IDENTITY`);
        const raw = await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases`);
        const n = Number(rowsOf(raw)[0]?.n ?? -1);
        if (n === 0) return;
        await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
      }
      throw new Error("clearPurchases: x402_l1_purchases still not empty");
    };

    const markCompletedExcept = async (exceptId: string) => {
      await clearPurchases();
      for (const req of catalog) {
        if (req.id === exceptId) continue;
        const endpointId = await ensureSellerRetestEndpoint(db, req, PAYER);
        await db.insert(schema.x402L1Purchases).values({
          endpointId,
          status: "settle_failed",
          payer: PAYER,
          authNonce: `done-${req.id}`,
          spentUnits: "5000",
          rawResponseMeta: { selection: "seller_request", sellerRequestId: req.id },
        });
      }
    };

    const seedOnlyPending = async (exceptId: string) => {
      for (let attempt = 0; attempt < 6; attempt++) {
        await markCompletedExcept(exceptId);
        const done = await completedSellerRequestIds(db);
        if (!done.has(exceptId)) return;
        await clearPurchases();
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
      }
      throw new Error(`seedOnlyPending: ${exceptId} still marked completed`);
    };

    const runSeller = (extra: Parameters<typeof runL1Batch>[0] = {}) =>
      runL1Batch({
        getPayerUsdcBalance: FUNDED_PAYER,
        fetchImpl,
        limit: 0,
        batchBudgetMs: 900_000,
        timeoutMs: 5_000,
        ...extra,
      });

    await t.beforeEach(async () => {
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      delete process.env.OBSERVATORY_L1_CENSUS;
      delete process.env.OBSERVATORY_ARBITRUM_L1_ENABLED;
      delete process.env.OBSERVATORY_SELLER_RETEST_ENABLED;
      delete process.env.ARBITRUM_RPC_URL;
      state.clear();
      await clearPurchases();
    });

    const fetchImpl = async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
      const st = state.get(url) ?? { paid: false };
      const payTo = st.wrongPayTo ? "0x9999999999999999999999999999999999999999" : payToForUrl(url);
      const amount = st.overCap ? String(MAX_PER_PURCHASE_UNITS + 1n) : "5000";
      if (!paid) {
        if (st.no402) return new Response("nope", { status: 503 });
        const extra =
          st.bodyDeclJson !== undefined
            ? []
            : url.includes("arbitrum-pick")
              ? [
                  {
                    scheme: "exact",
                    network: ARBITRUM_CAIP2,
                    amount: "5000",
                    asset: ARBITRUM_CHAIN.usdc,
                    payTo,
                  },
                ]
              : [];
        const body =
          st.bodyDeclJson !== undefined
            ? challengeDoc(url, payTo, amount, extra).replace(
                '"accepts":',
                `"extensions":{"bazaar":{"info":{"input":{"body":${st.bodyDeclJson}}}}},"accepts":`,
              )
            : challengeDoc(url, payTo, amount, extra);
        return new Response(body, {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      }
      st.paid = true;
      state.set(url, st);
      return new Response(JSON.stringify({ ok: true, route: url }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-goldsky-x402-balance": "12345",
          "PAYMENT-RESPONSE": Buffer.from(
            JSON.stringify({
              success: true,
              transaction: txForUrl(url),
              network: "eip155:8453",
              payer: PAYER,
            }),
          ).toString("base64"),
        },
      });
    };

    const seedSellerEndpointsWithL0Pass = async () => {
      for (const req of catalog) {
        const endpointId = await ensureSellerRetestEndpoint(db, req, PAYER);
        await db.insert(schema.x402L0Probes).values({
          endpointId,
          method: "GET",
          verdict: "pass",
          probedAt: new Date(),
        });
      }
    };

    const agePurchasesDays = async (days: number) => {
      await db.execute(sql`
        UPDATE x402_l1_purchases
        SET attempted_at = now() - make_interval(days => ${days})
      `);
    };

    await t.test("seller request signs on request network when Arbitrum lane prefers wall head", async () => {
      await seedOnlyPending(catalog[0]!.id);
      process.env.OBSERVATORY_ARBITRUM_L1_ENABLED = "true";
      state.clear();
      const url0 = resolveSellerRetestUrl(catalog[0]!.url, PAYER);
      state.set(url0, { paid: false });
      const fetchArb = async (u: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (!headers.has("PAYMENT-SIGNATURE") && !headers.has("X-PAYMENT") && u === url0) {
          return new Response(
            JSON.stringify({
              x402Version: 2,
              accepts: [
                { scheme: "exact", network: ARBITRUM_CAIP2, amount: "5000", asset: ARBITRUM_CHAIN.usdc, payTo: payToForUrl(u) },
                { scheme: "exact", network: "eip155:8453", amount: "5000", asset: BASE_USDC, payTo: payToForUrl(u) },
              ],
            }),
            { status: 402, headers: { "content-type": "application/json" } },
          );
        }
        return fetchImpl(u, init);
      };
      const s = await runSeller({ fetchImpl: fetchArb });
      assert.ok(s.attempted >= 1, JSON.stringify(s));
      const row = await db.execute(sql`
        SELECT network FROM x402_l1_purchases
        WHERE raw_response_meta->>'sellerRequestId' = ${catalog[0]!.id}
          AND auth_nonce IS NOT NULL AND auth_nonce NOT LIKE 'presign:%'
        LIMIT 1
      `);
      const net = rowsOf(row)[0]?.network;
      assert.equal(net, "eip155:8453");
    });

    await t.test("seller request skips when request network accept missing", async () => {
      await seedOnlyPending(catalog[0]!.id);
      state.clear();
      const url = resolveSellerRetestUrl(catalog[0]!.url, PAYER);
      state.set(url, {
        paid: false,
        wrongPayTo: false,
      });
      const orig = globalThis.fetch;
      const fetchNoBase = async (u: string, init?: RequestInit) => {
        if (!u.includes("mock-seller")) return fetchImpl(u, init);
        const headers = new Headers(init?.headers);
        if (!headers.has("PAYMENT-SIGNATURE") && !headers.has("X-PAYMENT")) {
          return new Response(
            JSON.stringify({
              x402Version: 2,
              accepts: [{ scheme: "exact", network: ARBITRUM_CAIP2, amount: "5000", asset: ARBITRUM_CHAIN.usdc, payTo: payToForUrl(u) }],
            }),
            { status: 402, headers: { "content-type": "application/json" } },
          );
        }
        return fetchImpl(u, init);
      };
      void orig;
      await runSeller({ fetchImpl: fetchNoBase });
      const rows = await db
        .select()
        .from(schema.x402L1Purchases)
        .where(sql`raw_response_meta->>'sellerRequestId' = ${catalog[0]!.id}`);
      assert.ok(rows.some((r) => (r.rawResponseMeta as { reason?: string })?.reason === "seller_request_network_missing"));
    });

    await t.test("catalog: up to 10 bought per run then remainder", async () => {
      state.clear();
      const s1 = await runSeller();
      assert.equal(s1.sellerRequestCandidates, SELLER_RETEST_MAX_PER_RUN);
      assert.equal(s1.attempted, SELLER_RETEST_MAX_PER_RUN);
      const s2 = await runSeller();
      assert.equal(s2.attempted, 1);
      const s3 = await runSeller();
      assert.equal(s3.attempted, 0);
    });

    await t.test("payTo mismatch: recorded, not signed", async () => {
      await seedOnlyPending(catalog[0]!.id);
      const url = resolveSellerRetestUrl(catalog[0]!.url, PAYER);
      state.clear();
      state.set(url, { paid: false, wrongPayTo: true });
      const s = await runSeller();
      assert.equal(s.attempted, 0);
      const rows = await db
        .select()
        .from(schema.x402L1Purchases)
        .where(sql`raw_response_meta->>'sellerRequestId' = ${catalog[0]!.id}`);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "no_eligible_accept");
      assert.equal((rows[0].rawResponseMeta as { reason?: string })?.reason, "seller_request_payto_mismatch");
      assert.equal(rows[0].authNonce, null);
    });

    await t.test("over per-purchase cap: not signed", async () => {
      await seedOnlyPending(catalog[1]!.id);
      state.clear();
      const url = resolveSellerRetestUrl(catalog[1]!.url, PAYER);
      state.set(url, { paid: false, overCap: true });
      await runSeller();
      const rows = await db
        .select()
        .from(schema.x402L1Purchases)
        .where(sql`raw_response_meta->>'sellerRequestId' = ${catalog[1]!.id}`);
      assert.ok(rows.some((r) => (r.rawResponseMeta as { reason?: string })?.reason === "seller_request_over_cap"));
      assert.ok(rows.every((r) => r.authNonce === null));
    });

    await t.test("public seller board sees purchases like ordinary L1", async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      state.clear();
      const s = await runSeller();
      assert.ok(s.attempted >= 1, JSON.stringify(s));
      const board = await readSellerBoard(db, false);
      const host = board.sellers.find((h) => h.host === "mock-seller-retest.example");
      assert.ok(host, board.sellers.map((h) => h.host).join(", "));
      assert.ok((host?.listings ?? 0) >= 1);
    });

    await t.test("BLOCK: ordinary L1 walk does not rebuy seller_retest endpoints", async () => {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_l1_purchases`,
      );
      await db.execute(sql.raw(SELLER_INDEX_SQL));
      state.clear();
      for (let i = 0; i < 3; i++) {
        await runSeller();
      }
      await seedSellerEndpointsWithL0Pass();
      await agePurchasesDays(8);
      await db.execute(sql`
        UPDATE x402_l1_purchases SET raw_response_meta = coalesce(raw_response_meta, '{}'::jsonb) - 'selection'
      `);
      const summary = await runSeller({ limit: 100, fetchImpl });
      assert.equal(summary.attempted, 0);
      assert.equal(summary.settled, 0);
    });

    await t.test("BLOCK census: seller_retest rows not in census candidates", async () => {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_l1_purchases`,
      );
      await db.execute(sql.raw(SELLER_INDEX_SQL));
      process.env.OBSERVATORY_L1_CENSUS = "on";
      await seedSellerEndpointsWithL0Pass();
      await db.insert(schema.x402Endpoints).values({
        resourceKey: "census-only.example/x",
        resourceUrl: "https://census-only.example/x",
        source: "cdp_bazaar",
        method: "GET",
        network: "eip155:8453",
        payTo: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
        priceAmount: "5000",
        priceAsset: BASE_USDC,
        rawAccepts: [{ scheme: "exact", network: "eip155:8453", amount: "5000", asset: BASE_USDC, payTo: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca" }],
        status: "active",
      });
      await db.insert(schema.x402L0Probes).values({
        endpointId: (await db.select().from(schema.x402Endpoints).where(eq(schema.x402Endpoints.resourceKey, "census-only.example/x")))[0]!.id,
        method: "GET",
        verdict: "pass",
        probedAt: new Date(),
      });
      state.clear();
      const summary = await runSeller({ limit: 100, fetchImpl });
      const sellerEpIds = (
        await db.select({ id: schema.x402Endpoints.id }).from(schema.x402Endpoints).where(eq(schema.x402Endpoints.source, SELLER_RETEST_REQUEST_SOURCE))
      ).map((r) => r.id);
      assert.ok(sellerEpIds.length > 0);
      const censusRows = await db.execute(sql`
        SELECT count(*)::int AS n FROM x402_l1_purchases pu
        JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE pu.raw_response_meta->>'selection' = 'census' AND e.source = ${SELLER_RETEST_REQUEST_SOURCE}
      `);
      const n = Number(rowsOf(censusRows)[0]?.n ?? 0);
      assert.equal(n, 0);
      assert.ok(summary.censusCandidates >= 0);
    });

    await t.test("BLOCK retest: seller_retest rows not in retest candidates", async () => {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_l1_purchases`,
      );
      await db.execute(sql.raw(SELLER_INDEX_SQL));
      await seedSellerEndpointsWithL0Pass();
      await agePurchasesDays(8);
      state.clear();
      const summary = await runSeller({ limit: 100, fetchImpl });
      const rebuy = await db.execute(sql`
        SELECT count(*)::int AS n FROM x402_l1_purchases pu
        JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE e.source = ${SELLER_RETEST_REQUEST_SOURCE}
          AND pu.raw_response_meta->>'selection' IS DISTINCT FROM 'seller_request'
          AND pu.attempted_at > now() - interval '1 hour'
      `);
      const n = Number(rowsOf(rebuy)[0]?.n ?? 0);
      assert.equal(n, 0);
      assert.equal(summary.retestCandidates, 0);
    });

    await t.test("L0 c1 tier excludes seller_retest_request endpoints", async () => {
      await db.execute(sql`TRUNCATE x402_l0_probes`);
      await seedSellerEndpointsWithL0Pass();
      const rows = await db.execute(sql`
        SELECT e.id::text AS id FROM x402_endpoints e WHERE ${l0ProbeTierWhere("c1", false)}
          AND e.source = ${SELLER_RETEST_REQUEST_SOURCE}
      `);
      const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as { id: string }[];
      assert.equal(list.length, 0);
    });

    await t.test("seller request caps at 10 per run when catalog has 11", async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      state.clear();
      const s = await runSeller();
      assert.equal(s.attempted, 10);
    });

    await t.test("expired seller request is not bought via runL1Batch", async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      state.clear();
      await runSeller();
      const bought = await db.execute(sql`
        SELECT count(*)::int AS n FROM x402_l1_purchases
        WHERE raw_response_meta->>'sellerRequestId' = ${"test-seller-retest-expired"}
      `);
      assert.equal(Number(rowsOf(bought)[0]?.n ?? 0), 0);
    });

    await t.test("concurrent runL1Batch: each seller request pays at most once", async () => {
      await db.execute(sql.raw(SELLER_INDEX_SQL));
      const idx = await db.execute(sql`
        SELECT 1 FROM pg_class c
        WHERE c.relname = 'x402_l1_purchases_seller_request_id_auth_unique' AND c.relkind = 'i'
      `);
      assert.equal(rowsOf(idx).length, 1, "seller request auth unique index must exist");
      await seedOnlyPending(catalog[0]!.id);
      state.clear();
      const url0 = resolveSellerRetestUrl(catalog[0]!.url, PAYER);
      let unpaidHits = 0;
      const fetchRace = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
        if (!paid && url === url0) {
          unpaidHits++;
          if (unpaidHits === 1) {
            await new Promise((r) => setTimeout(r, 300));
          }
        }
        return fetchImpl(url, init);
      };
      const [s1, s2] = await Promise.all([
        runSeller({ fetchImpl: fetchRace }),
        runSeller({ fetchImpl: fetchRace }),
      ]);
      assert.ok(s1.attempted + s2.attempted >= 1);
      const rows = await db.execute(sql`
        SELECT count(*)::int AS n FROM x402_l1_purchases
        WHERE raw_response_meta->>'sellerRequestId' = ${catalog[0]!.id}
          AND auth_nonce IS NOT NULL AND auth_nonce NOT LIKE 'presign:%'
      `);
      assert.equal(Number(rowsOf(rows)[0]?.n ?? 0), 1);
    });

    await t.test("no_402 seller request retries next day not same day", async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      await seedOnlyPending(catalog[0]!.id);
      state.clear();
      const url = resolveSellerRetestUrl(catalog[0]!.url, PAYER);
      state.set(url, { paid: false, no402: true });
      await runSeller();
      state.set(url, { paid: false, no402: false });
      const sameDay = await runSeller();
      assert.equal(sameDay.sellerRequestCandidates, 0);
      await db.execute(sql`
        UPDATE x402_l1_purchases SET attempted_at = attempted_at - interval '1 day'
        WHERE raw_response_meta->>'sellerRequestId' = ${catalog[0]!.id}
      `);
      const nextDay = await runSeller();
      assert.equal(nextDay.sellerRequestCandidates, 1);
    });

    for (const off of ["FALSE", "0", "off", "NO"]) {
      await t.test(`OBSERVATORY_SELLER_RETEST_ENABLED=${off} skips lane`, async () => {
        process.env.OBSERVATORY_SELLER_RETEST_ENABLED = off;
        await db.execute(sql`TRUNCATE x402_l1_purchases`);
        state.clear();
        const s = await runSeller();
        assert.equal(s.sellerRequestCandidates, 0);
        assert.equal(s.attempted, 0);
        delete process.env.OBSERVATORY_SELLER_RETEST_ENABLED;
      });
    }

    await t.test("seller request body mismatch is not signed", async () => {
      await seedOnlyPending(catalog[1]!.id);
      state.clear();
      const url = resolveSellerRetestUrl(catalog[1]!.url, PAYER);
      state.set(url, { paid: false, bodyDeclJson: "{}" });
      await runSeller();
      const rows = await db
        .select()
        .from(schema.x402L1Purchases)
        .where(sql`raw_response_meta->>'sellerRequestId' = ${catalog[1]!.id}`);
      assert.ok(rows.some((r) => (r.rawResponseMeta as { reason?: string })?.reason === "seller_request_body_mismatch"));
      assert.ok(rows.every((r) => r.authNonce === null));
    });

    await t.test("public observatory counts exclude seller_retest_request listings", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);
      await ensureSellerRetestEndpoint(db, catalog[0]!, PAYER);
      await db.insert(schema.x402Endpoints).values({
        resourceKey: "listed.example/a",
        resourceUrl: "https://listed.example/a",
        source: "cdp_bazaar",
        method: "GET",
        network: "eip155:8453",
        payTo: "0x2",
        priceAmount: "1000",
        priceAsset: BASE_USDC,
        status: "active",
      });
      const stats = await getObservatoryStats();
      assert.equal(stats.totalEndpoints, 1);
    });

    await t.test("catalog sync does not delist seller_retest_request rows", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_l1_purchases`);
      const ep = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: "mock-seller-retest.example/orphan",
          resourceUrl: "https://mock-seller-retest.example/orphan",
          source: SELLER_RETEST_REQUEST_SOURCE,
          method: "GET",
          network: "eip155:8453",
          payTo: "0x1",
          priceAmount: "5000",
          priceAsset: BASE_USDC,
          status: "active",
        })
        .returning();
      await syncCatalog({
        fetchResult: {
          items: [
            parseCatalogItem({
              resource: "https://only-cdp.example/x",
              accepts: [{ amount: "1000", asset: BASE_USDC, network: "eip155:8453", payTo: "0x2" }],
            }),
          ],
          totalCount: 1,
          fetchedCount: 1,
          complete: true,
        },
        today: "2026-10-30",
      });
      const row = await db.select().from(schema.x402Endpoints).where(eq(schema.x402Endpoints.id, ep[0]!.id));
      assert.equal(row[0]?.status, "active");
      assert.equal(row[0]?.source, SELLER_RETEST_REQUEST_SOURCE);
    });
  });
}
