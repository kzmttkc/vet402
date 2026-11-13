// ============================================================
// 売り手依頼レーンの飛ばし理由（2026-11-13）と dupSellerRequestId の結合試験。
// ============================================================
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
const INDEX_SQL_FILE = path.join(__dirname, "..", "scripts", "sql", "2026-10-30-seller-retest-request-id-unique.sql");
const L1_RUNNER_FILE = path.join(__dirname, "..", "src", "lib", "observatory", "l1-runner.ts");

if (!TEST_DB) {
  test("l1 seller retest skips (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;
  process.env.OBSERVATORY_SELLER_RETEST_TEST_LIST = "1";

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const PAYER = "0xf39Fd6e51aad88F6F4ce6bBFCB3678f9CF0C731".toLowerCase();

  type Db = NonNullable<ReturnType<typeof import("@/lib/db/client").getDb>>;
  let db!: Db;
  let sql!: typeof import("drizzle-orm").sql;
  let schema!: typeof import("@/lib/db/schema");
  let l1!: typeof import("@/lib/observatory/l1-runner");
  let sr!: typeof import("@/lib/observatory/seller-retest");
  let srq!: typeof import("@/lib/observatory/seller-retest-requests");
  let payerMod!: typeof import("@/lib/observatory/x402-payer");
  let catalog!: readonly import("@/lib/observatory/seller-retest-requests").SellerRetestRequest[];
  let CELO_USDC = "";
  let ARC_USDC = "";
  let ARC_CAIP2 = "";
  let CELO_CAIP2 = "";

  const rowsOf = (raw: unknown): Record<string, unknown>[] =>
    (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];

  const BLOCKSCOUT_1112 = "blockscout-2026-11-12-celo-addresses";
  const BLOCKSCOUT_1113 = "blockscout-2026-11-13-celo-addresses-noquery";
  const PAYTO_CELO = "0x242ba6d68ffeb4a098b591b32d370f973ff882b7";

  const state = new Map<string, { paid: boolean; no402?: boolean }>();
  let BASE_USDC = "";

  const payToForUrl = (url: string): string => {
    const hit = catalog.find((r) => srq.resolveSellerRetestUrl(r.url, PAYER) === url);
    return hit?.payTo ?? catalog[0]!.payTo;
  };

  const baseChallenge = (payTo: string, amount = "5000") =>
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

  const fetchImplBase = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
    const st = state.get(url) ?? { paid: false };
    if (!paid) {
      if (st.no402) return new Response("nope", { status: 503 });
      return new Response(baseChallenge(payToForUrl(url)), { status: 402, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "PAYMENT-RESPONSE": Buffer.from(
          JSON.stringify({
            success: true,
            transaction: `0xabc${createHash("sha256").update(url).digest("hex").slice(0, 58)}`,
            network: "eip155:8453",
            payer: PAYER,
          }),
        ).toString("base64"),
      },
    });
  };

  const txForUrl = (url: string) => `0xabc${createHash("sha256").update(url).digest("hex").slice(0, 58)}`;

  const celoChallenge = (payTo: string, amount = "2000") =>
    JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: CELO_CAIP2,
          amount,
          asset: CELO_USDC,
          payTo,
          maxTimeoutSeconds: 300,
          extra: { name: "USDC", version: "2" },
        },
        {
          scheme: "exact",
          network: ARC_CAIP2,
          amount,
          asset: ARC_USDC,
          payTo,
          maxTimeoutSeconds: 300,
          extra: { name: "USDC", version: "2" },
        },
      ],
    });

  const fetchImplCelo = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
    const st = state.get(url) ?? { paid: false };
    if (!paid) {
      if (st.no402) return new Response("nope", { status: 503 });
      return new Response(celoChallenge(PAYTO_CELO), { status: 402, headers: { "content-type": "application/json" } });
    }
    st.paid = true;
    state.set(url, st);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "PAYMENT-RESPONSE": Buffer.from(
          JSON.stringify({ success: true, transaction: txForUrl(url), network: CELO_CAIP2, payer: PAYER }),
        ).toString("base64"),
      },
    });
  };

  const runSeller = (extra: Parameters<typeof l1.runL1Batch>[0] = {}) =>
    l1.runL1Batch({
      getPayerUsdcBalance: async () => 1_000_000_000n,
      fetchImpl: fetchImplBase,
      limit: 0,
      batchBudgetMs: 900_000,
      timeoutMs: 5_000,
      ...extra,
    });

  const purchaseCount = async () =>
    Number(rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases`))[0]?.n ?? 0);

  const paidRowsFor = async (requestId: string) =>
    Number(
      rowsOf(
        await db.execute(sql`
          SELECT count(*)::int AS n FROM x402_l1_purchases
          WHERE raw_response_meta->>'sellerRequestId' = ${requestId}
            AND auth_nonce IS NOT NULL AND auth_nonce NOT LIKE 'presign:%'
        `),
      )[0]?.n ?? 0,
    );

  const truncateAll = async () => {
    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_l1_purchases RESTART IDENTITY`,
    );
  };

  const applyIndexSqlFile = async () => {
    await db.execute(sql.raw(readFileSync(INDEX_SQL_FILE, "utf8")));
  };

  const seedL0For = async (req: import("@/lib/observatory/seller-retest-requests").SellerRetestRequest) => {
    const endpointId = await sr.ensureSellerRetestEndpoint(db, req, PAYER);
    await db.insert(schema.x402L0Probes).values({ endpointId, method: "GET", verdict: "pass", probedAt: new Date() });
    return endpointId;
  };

  const markCompletedExcept = async (exceptIds: readonly string[]) => {
    const all = srq.SELLER_RETEST_REQUESTS;
    for (const req of all) {
      if (exceptIds.includes(req.id)) continue;
      const endpointId = await sr.ensureSellerRetestEndpoint(db, req, PAYER);
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

  before(async () => {
    l1 = await import("@/lib/observatory/l1-runner");
    sr = await import("@/lib/observatory/seller-retest");
    srq = await import("@/lib/observatory/seller-retest-requests");
    payerMod = await import("@/lib/observatory/x402-payer");
    schema = await import("@/lib/db/schema");
    ({ sql } = await import("drizzle-orm"));
    BASE_USDC = payerMod.BASE_USDC;
    CELO_USDC = payerMod.CELO_USDC;
    ARC_USDC = payerMod.ARC_CHAIN.usdc;
    ARC_CAIP2 = payerMod.ARC_CAIP2;
    CELO_CAIP2 = payerMod.CELO_CAIP2;
    const { getDb } = await import("@/lib/db/client");
    db = getDb()!;
    catalog = srq.sellerRetestRequestCatalog();
    await truncateAll();
    await applyIndexSqlFile();
  });

  beforeEach(async () => {
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    delete process.env.OBSERVATORY_L1_CENSUS;
    process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
    process.env.CELO_RPC_URL = "https://celo-rpc.invalid";
    state.clear();
    await db.execute(sql`TRUNCATE x402_l1_purchases RESTART IDENTITY`);
  });

  after(() => {
    delete process.env.OBSERVATORY_CELO_L1_ENABLED;
    delete process.env.CELO_RPC_URL;
  });

  test("celo same endpoint: blockscout noquery is bought after the 11-12 request settled on the same endpoint", async () => {
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    process.env.OBSERVATORY_L1_ENABLED = "true";
    const req1112 = srq.SELLER_RETEST_REQUESTS.find((r) => r.id === BLOCKSCOUT_1112)!;
    const req1113 = srq.SELLER_RETEST_REQUESTS.find((r) => r.id === BLOCKSCOUT_1113)!;
    await markCompletedExcept([BLOCKSCOUT_1112, BLOCKSCOUT_1113]);
    await seedL0For(req1112);
    await seedL0For(req1113);
    const endpointId = await sr.ensureSellerRetestEndpoint(db, req1113, PAYER);
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db.insert(schema.x402L1Purchases).values({
      endpointId,
      status: "settled",
      payer: PAYER,
      network: CELO_CAIP2,
      httpStatusPaid: 422,
      authNonce: "blockscout-1112-settled-nonce",
      spentUnits: "2000",
      attemptedAt: dayAgo,
      rawResponseMeta: { selection: "seller_request", sellerRequestId: BLOCKSCOUT_1112 },
    });
    const url1113 = srq.resolveSellerRetestUrl(req1113.url, PAYER);
    state.set(url1113, { paid: false });
    const s = await runSeller({
      sellerRetestCatalog: [req1113],
      fetchImpl: fetchImplCelo,
    });
    assert.equal(await paidRowsFor(BLOCKSCOUT_1113), 1, JSON.stringify(s));
    const rows = await db
      .select()
      .from(schema.x402L1Purchases)
      .where(sql`raw_response_meta->>'sellerRequestId' = ${BLOCKSCOUT_1113}`);
    assert.equal(rows[0]!.network, CELO_CAIP2);
    assert.deepEqual(s.sellerRequestSkips, []);
  });

  test("every skip in the request lane leaves one reason", async () => {
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    process.env.OBSERVATORY_L1_ENABLED = "true";
    const collected: { id: string; reason: string }[] = [];

    const slice11 = catalog.slice(0, 11);
    await markCompletedExcept(slice11.map((r) => r.id));
    for (const req of slice11) await seedL0For(req);
    const runLimitSummary = await runSeller({ sellerRetestCatalog: slice11 });
    const runLimit = runLimitSummary.sellerRequestSkips.filter((x) => x.reason === "run_limit");
    assert.equal(runLimit.length, 1);
    collected.push(runLimit[0]!);

    await db.execute(sql`TRUNCATE x402_l1_purchases RESTART IDENTITY`);
    const no402Req = catalog[1]!;
    await markCompletedExcept([no402Req.id]);
    await seedL0For(no402Req);
    const urlNo402 = srq.resolveSellerRetestUrl(no402Req.url, PAYER);
    state.set(urlNo402, { paid: false, no402: true });
    const no402Summary = await runSeller({ sellerRetestCatalog: [no402Req] });
    const no402Rows = await db
      .select()
      .from(schema.x402L1Purchases)
      .where(sql`raw_response_meta->>'sellerRequestId' = ${no402Req.id}`);
    assert.equal(no402Rows.length, 1);
    const no402 = no402Summary.sellerRequestSkips.filter((x) => x.reason === "no_402");
    assert.equal(no402.length, 1);
    collected.push(no402[0]!);

    await db.execute(sql`TRUNCATE x402_l1_purchases RESTART IDENTITY`);
    const capReq = catalog[0]!;
    await seedL0For(capReq);
    await db.insert(schema.x402L1Purchases).values({
      endpointId: await sr.ensureSellerRetestEndpoint(db, capReq, PAYER),
      status: "delivered",
      payer: PAYER,
      network: "eip155:8453",
      payTo: capReq.payTo,
      authNonce: "cap-seed",
      spentUnits: "2000000",
      attemptedAt: new Date(),
      rawResponseMeta: { selection: "seller_request", sellerRequestId: "cap-seed-id" },
    });
    const capSummary = await runSeller({ sellerRetestCatalog: [capReq] });
    const capReqRows = await db
      .select()
      .from(schema.x402L1Purchases)
      .where(sql`raw_response_meta->>'sellerRequestId' = ${capReq.id}`);
    assert.equal(capReqRows.length, 0);
    const capSkip = capSummary.sellerRequestSkips.find((x) => x.id === capReq.id);
    assert.ok(capSkip, JSON.stringify(capSummary.sellerRequestSkips));
    assert.ok(
      capSkip.reason.startsWith("reservation_seller_daily_cap") || capSkip.reason === "seller_capped_in_batch",
    );
    collected.push(capSkip);

    await db.execute(sql`TRUNCATE x402_l1_purchases RESTART IDENTITY`);
    const unfundedReq = catalog[3]!;
    await seedL0For(unfundedReq);
    const unfundedSummary = await runSeller({
      sellerRetestCatalog: [unfundedReq],
      getPayerUsdcBalance: async () => 0n,
    });
    const unfundedRows = await db
      .select()
      .from(schema.x402L1Purchases)
      .where(sql`raw_response_meta->>'sellerRequestId' = ${unfundedReq.id}`);
    assert.equal(
      unfundedRows.filter((r) => r.authNonce !== null && !String(r.authNonce).startsWith("presign:")).length,
      0,
    );
    assert.equal(await purchaseCount(), 0, "payer_unfunded must not add a ledger row");
    const unfunded = unfundedSummary.sellerRequestSkips.filter((x) => x.reason.startsWith("payer_unfunded"));
    assert.equal(unfunded.length, 1, JSON.stringify(unfundedSummary));
    collected.push(unfunded[0]!);

    await db.execute(sql`TRUNCATE x402_l1_purchases RESTART IDENTITY`);
    const deadlineSlice = catalog.slice(0, 3);
    for (const req of deadlineSlice) await seedL0For(req);
    let clock = 0;
    const deadlineSummary = await runSeller({
      sellerRetestCatalog: deadlineSlice,
      batchBudgetMs: 50,
      now: () => {
        clock += 200;
        return clock;
      },
    });
    assert.equal(await purchaseCount(), 0, "deadline must not add a ledger row");
    const deadline = deadlineSummary.sellerRequestSkips.filter((x) => x.reason === "deadline");
    assert.ok(deadline.length >= 1);
    collected.push(deadline[0]!);

    assert.equal(new Set(collected.map((x) => x.reason)).size, collected.length);
    for (const row of collected) {
      assert.ok(row.id.length > 0 && row.reason.length > 0);
    }
  });

  test("source: every non-attempted return in purchaseOne carries skipReason", () => {
    const text = readFileSync(L1_RUNNER_FILE, "utf8");
    const start = text.indexOf("async function purchaseOne");
    const end = text.indexOf("/** 例外（undici は cause に包む）", start);
    assert.ok(start > 0 && end > start);
    const body = text.slice(start, end);
    const re = /return\s*\{[\s\S]*?kind:\s*["'](\w+)["'][\s\S]*?\};/g;
    let m: RegExpExecArray | null;
    const missing: string[] = [];
    while ((m = re.exec(body))) {
      if (m[1] === "attempted") continue;
      if (!m[0].includes("skipReason")) missing.push(m[0].slice(0, 120));
    }
    assert.deepEqual(missing, []);
  });

  test("source: every continue and break in the request lane pushes a reason", () => {
    const text = readFileSync(L1_RUNNER_FILE, "utf8");
    const start = text.indexOf("// BEGIN seller_request_lane");
    const end = text.indexOf("// END seller_request_lane");
    assert.ok(start > 0 && end > start);
    const lane = text.slice(start, end);
    const lines = lane.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i]!.trim();
      if (t === "continue;" || t === "break;") {
        const window = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
        assert.ok(
          window.includes("summary.sellerRequestSkips.push(") || window.includes("pushSellerRequestSkips("),
          `line ${i + start}: ${t}\n${window}`,
        );
      }
    }
  });

  test("public summary omits sellerRequestSkips", async () => {
    const full: import("@/lib/observatory/l1-runner").L1BatchSummary = {
      attempted: 0,
      settled: 0,
      settleFailed: 0,
      deliveredNoReceipt: 0,
      skipped: 0,
      budgetDenied: 0,
      spentUnitsTotal: "0",
      stoppedForDeadline: false,
      notAttempted: 0,
      orphansResolved: 0,
      halted: false,
      haltReason: null,
      disabledReason: null,
      payerUnfunded: 0,
      sellerCapped: 0,
      unprovenCapped: 0,
      unprovenPriceExcluded: null,
      unprovenPoolClosed: false,
      overDimeCapped: 0,
      overDimePoolClosed: false,
      payerFundsUnreadable: [],
      payerUnfundedChains: [],
      laneFloor: {},
      laneFloorHostCapped: {},
      xrplFeeOverCap: 0,
      xrplLaneClosed: null,
      censusCandidates: 0,
      retestCandidates: 0,
      sellerRequestCandidates: 0,
      sellerRequestSkips: [{ id: "x", reason: "run_limit" }],
      censusRemaining: null,
      laneSkippedForTime: 0,
      gatewayPostBodyUnknownActive: null,
      gatewayPostBodyUnknownSignSkipped: 0,
      setupMs: null,
      attemptsByNetwork: {},
      primaryFetchMs: null,
      laneFetchMs: {},
      arkivRulingBlocked: 0,
      arkivRulingUnread: 0,
      arkivRulingThrew: 0,
    };
    const pub = l1.publicL1Summary(full);
    assert.equal("sellerRequestSkips" in pub, false);
  });
}
