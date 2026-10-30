// ============================================================
// 売り手依頼の 1 回きり L1 買い直し（2026-10-30）。
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
    const { sellerRetestRequestCatalog, resolveSellerRetestUrl } = await import("@/lib/observatory/seller-retest-requests");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC, MAX_PER_PURCHASE_UNITS } = await import("@/lib/observatory/x402-payer");
    const { readSellerBoard } = await import("@/lib/sellers/reader");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");

    const db = getDb()!;
    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_l1_purchases`,
    );

    const KEYS = ["OBSERVATORY_L1_ENABLED", "OBSERVATORY_WALLET_PRIVATE_KEY", "OBSERVATORY_L1_CENSUS", "L1_LANE_FLOOR_PER_RUN"] as const;
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

    const catalog = sellerRetestRequestCatalog();
    assert.equal(catalog.length, 9);

    const payToForUrl = (url: string): string => {
      const m = /route\/(?:post-)?(\d+)/.exec(url) ?? /route\/query/.exec(url);
      if (url.includes("/route/query")) return catalog[2]!.payTo;
      const n = m ? Number(m[1]) : 1;
      return catalog[n - 1]!.payTo;
    };

    const challengeDoc = (url: string, payTo: string, amount = "5000") =>
      JSON.stringify({
        x402Version: 2,
        accepts: [
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

    const state = new Map<string, { paid: boolean; wrongPayTo?: boolean; overCap?: boolean }>();

    const txForUrl = (url: string) =>
      `0xabc${createHash("sha256").update(url).digest("hex").slice(0, 58)}`;

    const markCompletedExcept = async (exceptId: string) => {
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      for (const req of catalog) {
        if (req.id === exceptId) continue;
        const endpointId = await ensureSellerRetestEndpoint(db, req, PAYER);
        await db.insert(schema.x402L1Purchases).values({
          endpointId,
          status: "settle_failed",
          payer: PAYER,
          authNonce: "test-nonce",
          spentUnits: "5000",
          rawResponseMeta: { selection: "seller_request", sellerRequestId: req.id },
        });
      }
    };

    const fetchImpl = async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
      const st = state.get(url) ?? { paid: false };
      const payTo = st.wrongPayTo ? "0x9999999999999999999999999999999999999999" : payToForUrl(url);
      const amount = st.overCap ? String(MAX_PER_PURCHASE_UNITS + 1n) : "5000";
      if (!paid) {
        return new Response(challengeDoc(url, payTo, amount), {
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

    await t.test("9 requests: each bought once; second batch buys none", async () => {
      const s1 = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, fetchImpl, limit: 0 });
      assert.equal(s1.sellerRequestCandidates, 9);
      assert.equal(s1.attempted, 9);
      const rows1 = await db.select().from(schema.x402L1Purchases);
      assert.equal(rows1.length, 9);
      assert.ok(rows1.every((r) => (r.rawResponseMeta as { selection?: string })?.selection === "seller_request"));
      assert.ok(rows1.every((r) => typeof (r.rawResponseMeta as { sellerRequestId?: string })?.sellerRequestId === "string"));
      const completed = await completedSellerRequestIds(db);
      assert.equal(completed.size, 9);
      const s2 = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, fetchImpl, limit: 0 });
      assert.equal(s2.sellerRequestCandidates, 0);
      assert.equal(s2.attempted, 0);
    });

    await t.test("payTo mismatch: recorded, not signed", async () => {
      await markCompletedExcept(catalog[0]!.id);
      const url = resolveSellerRetestUrl(catalog[0]!.url, PAYER);
      state.clear();
      state.set(url, { paid: false, wrongPayTo: true });
      const s = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, fetchImpl, limit: 0 });
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
      await markCompletedExcept(catalog[1]!.id);
      state.clear();
      const url = resolveSellerRetestUrl(catalog[1]!.url, PAYER);
      state.set(url, { paid: false, overCap: true });
      await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, fetchImpl, limit: 0 });
      const rows = await db
        .select()
        .from(schema.x402L1Purchases)
        .where(sql`raw_response_meta->>'sellerRequestId' = ${catalog[1]!.id}`);
      assert.ok(rows.some((r) => (r.rawResponseMeta as { reason?: string })?.reason === "seller_request_over_cap"));
      assert.ok(rows.every((r) => r.authNonce === null));
    });

    await t.test("expired request: skipped", async () => {
      const { pendingSellerRetestRequests: pendingFn, utcDateString } = await import("@/lib/observatory/seller-retest");
      const expired = [{ ...catalog[0]!, expiresOn: "2020-01-01" }];
      assert.equal(pendingFn(expired, new Set(), utcDateString()).length, 0);
    });

    await t.test("catalog sync does not delist seller_retest_request rows", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`);
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
          items: [parseCatalogItem({ resource: "https://only-cdp.example/x", accepts: [{ amount: "1000", asset: BASE_USDC, network: "eip155:8453", payTo: "0x2" }] })],
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

    await t.test("public seller board sees purchases like ordinary L1", async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      state.clear();
      const s = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, fetchImpl, limit: 0 });
      assert.equal(s.attempted, 9);
      const board = await readSellerBoard(db, false);
      const host = board.sellers.find((h) => h.host === "mock-seller-retest.example");
      assert.ok(host);
      assert.ok((host?.listings ?? 0) >= 1);
    });

    await t.test("guard: completion filter and payTo gate (mutation sanity)", async () => {
      const gate = {
        id: "x",
        expectedPayTo: catalog[0]!.payTo,
        network: "eip155:8453",
        maxAmountUnits: 5000n,
      };
      const challenge = {
        x402Version: 2 as const,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "5000",
            asset: BASE_USDC,
            payTo: "0xdead000000000000000000000000000000000001",
          },
        ],
      };
      assert.equal(validateSellerRequest402(challenge, gate).ok, false);
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, fetchImpl, limit: 0 });
      const done = await completedSellerRequestIds(db);
      assert.equal(done.size, 9);
      assert.equal(pendingSellerRetestRequests(catalog, done, "2026-10-30").length, 0);
      assert.equal(pendingSellerRetestRequests(catalog, new Set(), "2026-10-30").length, 9);
    });
  });
}
