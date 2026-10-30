// ============================================================
// 売り手依頼の 1 回きり L1 買い直し（2026-10-30・差し戻し 2 回目）。
//
// テストはすべて最上位の test（--test-name-pattern が 1 本ずつ選べる形。親の中の subtest は親の名前が
// 合わないと 1 本も走らない）。本物の runL1Batch・レーン・L0 の層・解放/掃除/確定/枠取りの関数を DB で通す。
// 一意索引は scripts/sql の本物のファイルを流す（写さない）。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_seller_retest_test \
//   OBSERVATORY_SELLER_RETEST_TEST_LIST=1 \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-seller-retest.pg.test.ts
// 戻すと落ちる確かめ: scripts/dev/mutation-check-seller-retest.sh
// ============================================================
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";
import type * as L1Runner from "@/lib/observatory/l1-runner";
import type * as SellerRetest from "@/lib/observatory/seller-retest";
import type * as SellerRetestRequests from "@/lib/observatory/seller-retest-requests";
import type * as Schema from "@/lib/db/schema";
import type * as Drizzle from "drizzle-orm";

const FUNDED_PAYER = async () => 1_000_000_000n;
const TEST_DB = process.env.TEST_DATABASE_URL;
const INDEX_SQL_FILE = path.join(__dirname, "..", "scripts", "sql", "2026-10-30-seller-retest-request-id-unique.sql");

if (!TEST_DB) {
  test("l1 seller retest (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;
  process.env.OBSERVATORY_SELLER_RETEST_TEST_LIST = "1";

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const PAYER = "0xf39Fd6e51aad88F6F4ce6bBFCB3678f9CF0C731".toLowerCase();

  type Db = NonNullable<ReturnType<typeof import("@/lib/db/client").getDb>>;
  let db!: Db;
  let sql!: typeof Drizzle.sql;
  let eq!: typeof Drizzle.eq;
  let schema!: typeof Schema;
  let l1!: typeof L1Runner;
  let sr!: typeof SellerRetest;
  let srq!: typeof SellerRetestRequests;
  let catalog!: readonly SellerRetestRequests.SellerRetestRequest[];
  let BASE_USDC = "";
  let MAX_PER_PURCHASE_UNITS = 0n;
  let ARBITRUM_CAIP2 = "";
  let ARBITRUM_USDC = "";

  const rowsOf = (raw: unknown): Record<string, unknown>[] =>
    (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];

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

  /** 模擬の売り手の状態（URL ごと）。 */
  const state = new Map<
    string,
    { paid: boolean; wrongPayTo?: boolean; overCap?: boolean; no402?: boolean; bodyDeclJson?: string }
  >();
  /** URL ごとの無払い／支払い付きの要求の数。 */
  const unpaidHits = new Map<string, number>();
  const paidHits = new Map<string, number>();

  const payToForUrl = (url: string): string => {
    if (url.includes("/route/query")) return catalog[2]!.payTo;
    const m = /route\/(?:post-)?(\d+)/.exec(url);
    const n = m ? Number(m[1]) : 1;
    return catalog[n - 1]!.payTo;
  };

  const challengeDoc = (
    payTo: string,
    amount = "5000",
    extraAccepts: { scheme: string; network: string; amount: string; asset: string; payTo: string }[] = [],
    baseAccept = true,
  ) =>
    JSON.stringify({
      x402Version: 2,
      accepts: [
        ...extraAccepts,
        ...(baseAccept
          ? [
              {
                scheme: "exact",
                network: "eip155:8453",
                amount,
                asset: BASE_USDC,
                payTo,
                maxTimeoutSeconds: 300,
                extra: { name: "USD Coin", version: "2" },
              },
            ]
          : []),
      ],
    });

  const txForUrl = (url: string) => `0xabc${createHash("sha256").update(url).digest("hex").slice(0, 58)}`;

  const fetchImpl = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
    const st = state.get(url) ?? { paid: false };
    const payTo = st.wrongPayTo ? "0x9999999999999999999999999999999999999999" : payToForUrl(url);
    const amount = st.overCap ? String(MAX_PER_PURCHASE_UNITS + 1n) : "5000";
    if (!paid) {
      unpaidHits.set(url, (unpaidHits.get(url) ?? 0) + 1);
      if (st.no402) return new Response("nope", { status: 503 });
      const body =
        st.bodyDeclJson !== undefined
          ? challengeDoc(payTo, amount).replace(
              '"accepts":',
              `"extensions":{"bazaar":{"info":{"input":{"body":${st.bodyDeclJson}}}}},"accepts":`,
            )
          : challengeDoc(payTo, amount);
      return new Response(body, { status: 402, headers: { "content-type": "application/json" } });
    }
    paidHits.set(url, (paidHits.get(url) ?? 0) + 1);
    st.paid = true;
    state.set(url, st);
    return new Response(JSON.stringify({ ok: true, route: url }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-goldsky-x402-balance": "12345",
        "PAYMENT-RESPONSE": Buffer.from(
          JSON.stringify({ success: true, transaction: txForUrl(url), network: "eip155:8453", payer: PAYER }),
        ).toString("base64"),
      },
    });
  };

  const runSeller = (extra: Parameters<typeof L1Runner.runL1Batch>[0] = {}) =>
    l1.runL1Batch({
      getPayerUsdcBalance: FUNDED_PAYER,
      fetchImpl,
      limit: 0,
      batchBudgetMs: 900_000,
      timeoutMs: 5_000,
      ...extra,
    });

  const applyIndexSqlFile = async () => {
    await db.execute(sql.raw(readFileSync(INDEX_SQL_FILE, "utf8")));
  };

  const truncateAll = async () => {
    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_l1_purchases RESTART IDENTITY`,
    );
  };

  const clearPurchases = async () => {
    await db.execute(sql`TRUNCATE x402_l1_purchases RESTART IDENTITY`);
  };

  /** 依頼 1 件だけ未完了にする（ほかの依頼は本物の nonce の行で「済み」にする）。 */
  const seedOnlyPending = async (exceptIds: readonly string[]) => {
    await clearPurchases();
    for (const req of catalog) {
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
    const done = await sr.completedSellerRequestIds(db);
    for (const id of exceptIds) assert.equal(done.has(id), false, `${id} must stay pending`);
  };

  const seedSellerEndpointsWithL0Pass = async () => {
    for (const req of catalog) {
      const endpointId = await sr.ensureSellerRetestEndpoint(db, req, PAYER);
      await db.insert(schema.x402L0Probes).values({ endpointId, method: "GET", verdict: "pass", probedAt: new Date() });
    }
  };

  const insertOrdinaryListing = async (key: string, payTo: string, network = "eip155:8453") => {
    const ep = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: key,
        resourceUrl: `https://${key}`,
        source: "cdp_bazaar",
        method: "GET",
        network,
        payTo,
        priceAmount: "5000",
        priceAsset: BASE_USDC,
        rawAccepts: [{ scheme: "exact", network, amount: "5000", asset: BASE_USDC, payTo }],
        status: "active",
      })
      .returning();
    return ep[0]!.id;
  };

  /** 依頼の行の、本物の nonce（presign: でない）を持つ支払いの行の数。 */
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

  const rowsForRequest = async (requestId: string) =>
    db
      .select()
      .from(schema.x402L1Purchases)
      .where(sql`raw_response_meta->>'sellerRequestId' = ${requestId}`)
      .orderBy(schema.x402L1Purchases.attemptedAt);

  const dropTestTriggers = async () => {
    await db.execute(sql.raw(`
      SET client_min_messages TO warning;
      DROP TRIGGER IF EXISTS test_sr_halt_on_presign ON x402_l1_purchases;
      DROP TRIGGER IF EXISTS test_sr_block_release ON x402_l1_purchases;
      DROP TRIGGER IF EXISTS test_sr_block_nonce_write ON x402_l1_purchases;
      DROP TRIGGER IF EXISTS test_sr_slow_claim ON x402_l1_purchases;
      DELETE FROM runtime_flags WHERE name = 'l1_spending_halt';
    `));
  };

  /** 枠の印（presign:）が書かれた直後に停止スイッチを入れる（署名直前の haltGate が止める）。 */
  const installHaltOnPresign = async () => {
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION test_sr_halt_on_presign_fn() RETURNS trigger AS $$
      BEGIN
        IF NEW.auth_nonce LIKE 'presign:%' AND OLD.auth_nonce IS DISTINCT FROM NEW.auth_nonce THEN
          INSERT INTO runtime_flags (name, enabled, reason, updated_by)
          VALUES ('l1_spending_halt', true, 'test_b2_after_claim', 'test')
          ON CONFLICT (name) DO UPDATE SET enabled = true, reason = 'test_b2_after_claim';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_sr_halt_on_presign AFTER UPDATE ON x402_l1_purchases
        FOR EACH ROW EXECUTE FUNCTION test_sr_halt_on_presign_fn();
    `));
  };

  before(async () => {
    l1 = await import("@/lib/observatory/l1-runner");
    sr = await import("@/lib/observatory/seller-retest");
    srq = await import("@/lib/observatory/seller-retest-requests");
    schema = await import("@/lib/db/schema");
    ({ sql, eq } = await import("drizzle-orm"));
    const payer = await import("@/lib/observatory/x402-payer");
    BASE_USDC = payer.BASE_USDC;
    MAX_PER_PURCHASE_UNITS = payer.MAX_PER_PURCHASE_UNITS;
    ARBITRUM_CAIP2 = payer.ARBITRUM_CAIP2;
    ARBITRUM_USDC = payer.ARBITRUM_CHAIN.usdc;
    const { getDb } = await import("@/lib/db/client");
    db = getDb()!;
    catalog = srq.sellerRetestRequestCatalog();
    assert.equal(catalog.length, 12);
    await truncateAll();
    await applyIndexSqlFile();
  });

  after(async () => {
    await dropTestTriggers();
    for (const k of KEYS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(async () => {
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    delete process.env.OBSERVATORY_L1_CENSUS;
    delete process.env.L1_LANE_FLOOR_PER_RUN;
    delete process.env.OBSERVATORY_ARBITRUM_L1_ENABLED;
    delete process.env.OBSERVATORY_SELLER_RETEST_ENABLED;
    delete process.env.ARBITRUM_RPC_URL;
    state.clear();
    unpaidHits.clear();
    paidHits.clear();
    await dropTestTriggers();
    await clearPurchases();
  });

  test("arbitrum lane on: seller request signs on the request network (Base)", async () => {
    await seedOnlyPending([catalog[0]!.id]);
    // Arbitrum のレーンを本当に ON にする（旗 + RPC の URL。ダミーでよい——署名も残高もこの経路では RPC を読まない）。
    process.env.OBSERVATORY_ARBITRUM_L1_ENABLED = "true";
    process.env.ARBITRUM_RPC_URL = "https://arbitrum-rpc.invalid";
    const url0 = srq.resolveSellerRetestUrl(catalog[0]!.url, PAYER);
    const fetchArbFirst = async (u: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (!headers.has("PAYMENT-SIGNATURE") && !headers.has("X-PAYMENT") && u === url0) {
        unpaidHits.set(u, (unpaidHits.get(u) ?? 0) + 1);
        return new Response(
          challengeDoc(payToForUrl(u), "5000", [
            { scheme: "exact", network: ARBITRUM_CAIP2, amount: "5000", asset: ARBITRUM_USDC, payTo: payToForUrl(u) },
          ]),
          { status: 402, headers: { "content-type": "application/json" } },
        );
      }
      return fetchImpl(u, init);
    };
    const s = await runSeller({ fetchImpl: fetchArbFirst });
    assert.equal(s.attempted, 1, JSON.stringify(s));
    const rows = await rowsForRequest(catalog[0]!.id);
    const signed = rows.filter((r) => r.authNonce !== null);
    assert.equal(signed.length, 1, JSON.stringify(rows.map((r) => [r.status, r.network])));
    assert.equal(signed[0]!.network, "eip155:8453");
  });

  test("network accept missing: seller request is not signed and the reason is recorded", async () => {
    await seedOnlyPending([catalog[0]!.id]);
    const url0 = srq.resolveSellerRetestUrl(catalog[0]!.url, PAYER);
    const fetchNoBase = async (u: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      if (!headers.has("PAYMENT-SIGNATURE") && !headers.has("X-PAYMENT") && u === url0) {
        return new Response(
          challengeDoc(
            payToForUrl(u),
            "5000",
            [{ scheme: "exact", network: ARBITRUM_CAIP2, amount: "5000", asset: ARBITRUM_USDC, payTo: payToForUrl(u) }],
            false,
          ),
          { status: 402, headers: { "content-type": "application/json" } },
        );
      }
      return fetchImpl(u, init);
    };
    const s = await runSeller({ fetchImpl: fetchNoBase });
    assert.equal(s.attempted, 0);
    const rows = await rowsForRequest(catalog[0]!.id);
    assert.equal(rows.length, 1);
    assert.equal((rows[0]!.rawResponseMeta as { reason?: string })?.reason, "seller_request_network_missing");
    assert.equal(rows[0]!.authNonce, null);
  });

  test("catalog: up to 10 bought per run then remainder", async () => {
    const s1 = await runSeller();
    assert.equal(s1.sellerRequestCandidates, srq.SELLER_RETEST_MAX_PER_RUN);
    assert.equal(s1.attempted, srq.SELLER_RETEST_MAX_PER_RUN);
    const s2 = await runSeller();
    assert.equal(s2.attempted, 1);
    const s3 = await runSeller();
    assert.equal(s3.attempted, 0);
  });

  test("payTo mismatch: recorded, not signed", async () => {
    await seedOnlyPending([catalog[0]!.id]);
    state.set(srq.resolveSellerRetestUrl(catalog[0]!.url, PAYER), { paid: false, wrongPayTo: true });
    const s = await runSeller();
    assert.equal(s.attempted, 0);
    const rows = await rowsForRequest(catalog[0]!.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "no_eligible_accept");
    assert.equal((rows[0]!.rawResponseMeta as { reason?: string })?.reason, "seller_request_payto_mismatch");
    assert.equal(rows[0]!.authNonce, null);
  });

  test("over per-purchase cap: not signed", async () => {
    await seedOnlyPending([catalog[1]!.id]);
    state.set(srq.resolveSellerRetestUrl(catalog[1]!.url, PAYER), { paid: false, overCap: true });
    await runSeller();
    const rows = await rowsForRequest(catalog[1]!.id);
    assert.ok(rows.some((r) => (r.rawResponseMeta as { reason?: string })?.reason === "seller_request_over_cap"));
    assert.ok(rows.every((r) => r.authNonce === null));
  });

  test("public seller board sees purchases like ordinary L1", async () => {
    const { readSellerBoard } = await import("@/lib/sellers/reader");
    const s = await runSeller();
    assert.ok(s.attempted >= 1, JSON.stringify(s));
    const board = await readSellerBoard(db, false);
    const host = board.sellers.find((h) => h.host === "mock-seller-retest.example");
    assert.ok(host, board.sellers.map((h) => h.host).join(", "));
    assert.ok((host?.listings ?? 0) >= 1);
  });

  test("BLOCK: ordinary L1 walk does not rebuy seller_retest endpoints", async () => {
    await truncateAll();
    for (let i = 0; i < 3; i++) await runSeller();
    await seedSellerEndpointsWithL0Pass();
    await db.execute(sql`UPDATE x402_l1_purchases SET attempted_at = now() - interval '8 days'`);
    await db.execute(sql`
      UPDATE x402_l1_purchases SET raw_response_meta = coalesce(raw_response_meta, '{}'::jsonb) - 'selection'
    `);
    const summary = await runSeller({ limit: 100 });
    assert.equal(summary.attempted, 0);
    assert.equal(summary.settled, 0);
  });

  test("census only: seller_retest rows are not census candidates", async () => {
    await truncateAll();
    // 主候補（limit 0）と依頼のレーンを止め、census の旗だけを立てる。
    process.env.OBSERVATORY_L1_CENSUS = "on";
    process.env.OBSERVATORY_SELLER_RETEST_ENABLED = "false";
    await seedSellerEndpointsWithL0Pass();
    const ordinary = await insertOrdinaryListing("census-only.example/x", catalog[0]!.payTo);
    await db.insert(schema.x402L0Probes).values({ endpointId: ordinary, method: "GET", verdict: "pass", probedAt: new Date() });
    const summary = await runSeller({ limit: 0 });
    assert.equal(summary.sellerRequestCandidates, 0);
    assert.equal(summary.censusCandidates, 1, JSON.stringify(summary));
    const onSeller = rowsOf(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE e.source = ${srq.SELLER_RETEST_REQUEST_SOURCE}
      `),
    )[0]?.n;
    assert.equal(Number(onSeller), 0);
    const census = rowsOf(
      await db.execute(sql`
        SELECT count(*)::int AS n FROM x402_l1_purchases
        WHERE endpoint_id = ${ordinary}::uuid AND raw_response_meta->>'selection' = 'census'
      `),
    )[0]?.n;
    assert.equal(Number(census), 1);
  });

  test("retest only: seller_retest rows are not retest candidates", async () => {
    await truncateAll();
    process.env.OBSERVATORY_L1_CENSUS = "on";
    process.env.OBSERVATORY_SELLER_RETEST_ENABLED = "false";
    await seedSellerEndpointsWithL0Pass();
    const ordinary = await insertOrdinaryListing("retest-only.example/x", catalog[0]!.payTo);
    await db.insert(schema.x402L0Probes).values({ endpointId: ordinary, method: "GET", verdict: "pass", probedAt: new Date() });
    const sellerEp = await sr.ensureSellerRetestEndpoint(db, catalog[0]!, PAYER);
    // 両ホストの最新の行を「こちらの資金切れ」（delivery.ts PAYER_UNFUNDED_WINDOWS の内側・settle_failed・tx なし・402）にする。
    // どちらのホストにも購入行があるので census は 0 件、retest だけが候補を出す。
    for (const endpointId of [ordinary, sellerEp]) {
      await db.insert(schema.x402L1Purchases).values({
        endpointId,
        status: "settle_failed",
        payer: PAYER,
        network: "eip155:8453",
        httpStatusPaid: 402,
        authNonce: `unfunded-${endpointId}`,
        spentUnits: "5000",
        attemptedAt: new Date("2026-09-14T00:00:00Z"),
      });
    }
    const summary = await runSeller({ limit: 0 });
    assert.equal(summary.censusCandidates, 0, JSON.stringify(summary));
    assert.equal(summary.retestCandidates, 1, JSON.stringify(summary));
    const fresh = rowsOf(
      await db.execute(sql`
        SELECT e.source, count(*)::int AS n FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE pu.attempted_at > now() - interval '1 hour'
        GROUP BY e.source
      `),
    );
    assert.deepEqual(
      fresh.map((r) => [r.source, Number(r.n)]),
      [["cdp_bazaar", 1]],
    );
  });

  test("L0 c1 tier excludes seller_retest_request endpoints", async () => {
    const { l0ProbeTierWhere } = await import("@/lib/observatory/coverage");
    await db.execute(sql`TRUNCATE x402_l0_probes`);
    await seedSellerEndpointsWithL0Pass();
    const rows = await db.execute(sql`
      SELECT e.id::text AS id FROM x402_endpoints e WHERE ${l0ProbeTierWhere("c1", false)}
        AND e.source = ${srq.SELLER_RETEST_REQUEST_SOURCE}
    `);
    assert.equal(rowsOf(rows).length, 0);
  });

  test("seller request caps at 10 per run when catalog has 11", async () => {
    const s = await runSeller();
    assert.equal(s.attempted, 10);
  });

  test("expired seller request is not bought via runL1Batch", async () => {
    // 期限切れの 1 件だけが未完了（ほかの 11 件は済み）。期限の判定を外すと、この 1 件が候補に入る。
    await seedOnlyPending([srq.SELLER_RETEST_TEST_EXPIRED.id]);
    const s = await runSeller();
    assert.equal(s.sellerRequestCandidates, 0, JSON.stringify(s));
    assert.equal(s.attempted, 0);
    assert.equal((await rowsForRequest(srq.SELLER_RETEST_TEST_EXPIRED.id)).length, 0);
  });

  test("concurrent claim: two auth-slot claims for one seller request, only one wins", async () => {
    await applyIndexSqlFile();
    const req = catalog[0]!;
    const endpointId = await sr.ensureSellerRetestEndpoint(db, req, PAYER);
    const reserved = [] as string[];
    for (let i = 0; i < 2; i++) {
      const row = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId,
          status: "in_flight",
          payer: PAYER,
          network: "eip155:8453",
          spentUnits: "5000",
          amountUnits: "5000",
          rawResponseMeta: { selection: "seller_request", sellerRequestId: req.id },
        })
        .returning();
      reserved.push(row[0]!.id);
    }
    // 2 本の UPDATE が互いの書き込みを見る前に WHERE（NOT EXISTS）を通るよう、行を書く直前で 0.3 秒待たせる。
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION test_sr_slow_claim_fn() RETURNS trigger AS $$
      BEGIN
        IF NEW.auth_nonce LIKE 'presign:%' THEN PERFORM pg_sleep(0.3); END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_sr_slow_claim BEFORE UPDATE ON x402_l1_purchases
        FOR EACH ROW EXECUTE FUNCTION test_sr_slow_claim_fn();
    `));
    try {
      const results = await Promise.all(reserved.map((id) => sr.claimSellerRequestAuthSlot(db, id, req.id)));
      assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
      const claimed = rowsOf(
        await db.execute(sql`
          SELECT count(*)::int AS n FROM x402_l1_purchases
          WHERE raw_response_meta->>'sellerRequestId' = ${req.id} AND auth_nonce IS NOT NULL
        `),
      )[0]?.n;
      assert.equal(Number(claimed), 1);
    } finally {
      await dropTestTriggers();
    }
  });

  test("no_402 seller request: same day does not refetch, next day actually buys", async () => {
    await seedOnlyPending([catalog[0]!.id]);
    const url0 = srq.resolveSellerRetestUrl(catalog[0]!.url, PAYER);
    state.set(url0, { paid: false, no402: true });
    const day1 = await runSeller();
    assert.equal(day1.attempted, 0);
    assert.equal(unpaidHits.get(url0), 1);
    // 売り手が直した。同じ UTC 日の 2 回目は取りに行かない（前の行が「取りに行った」記録）。
    state.set(url0, { paid: false });
    const sameDay = await runSeller();
    assert.equal(sameDay.sellerRequestCandidates, 0);
    assert.equal(unpaidHits.get(url0), 1, "same UTC day must not fetch the 402 again");
    // 翌日: 前日の失敗の行は 6 日の窓に数えず、実際に買う。
    await db.execute(sql`
      UPDATE x402_l1_purchases SET attempted_at = attempted_at - interval '1 day'
      WHERE raw_response_meta->>'sellerRequestId' = ${catalog[0]!.id}
    `);
    const nextDay = await runSeller();
    assert.equal(nextDay.sellerRequestCandidates, 1);
    assert.equal(unpaidHits.get(url0), 2);
    assert.equal(await paidRowsFor(catalog[0]!.id), 1, JSON.stringify(nextDay));
  });

  for (const off of ["FALSE", "0", "off", "NO"]) {
    test(`OBSERVATORY_SELLER_RETEST_ENABLED=${off} skips lane`, async () => {
      process.env.OBSERVATORY_SELLER_RETEST_ENABLED = off;
      const s = await runSeller();
      assert.equal(s.sellerRequestCandidates, 0);
      assert.equal(s.attempted, 0);
    });
  }

  test("seller request body mismatch is not signed", async () => {
    await seedOnlyPending([catalog[1]!.id]);
    state.set(srq.resolveSellerRetestUrl(catalog[1]!.url, PAYER), { paid: false, bodyDeclJson: "{}" });
    await runSeller();
    const rows = await rowsForRequest(catalog[1]!.id);
    assert.ok(rows.some((r) => (r.rawResponseMeta as { reason?: string })?.reason === "seller_request_body_mismatch"));
    assert.ok(rows.every((r) => r.authNonce === null));
  });

  test("public observatory counts exclude seller_retest_request listings", async () => {
    const { getObservatoryStats } = await import("@/lib/observatory/reader");
    await truncateAll();
    await sr.ensureSellerRetestEndpoint(db, catalog[0]!, PAYER);
    await insertOrdinaryListing("listed.example/a", "0x2");
    const stats = await getObservatoryStats();
    assert.equal(stats.totalEndpoints, 1);
  });

  test("observatory overview list and count exclude seller_retest_request listings", async () => {
    const { getObservatoryOverview } = await import("@/lib/observatory/reader");
    await truncateAll();
    await sr.ensureSellerRetestEndpoint(db, catalog[0]!, PAYER);
    await insertOrdinaryListing("listed.example/a", "0x2");
    const overview = await getObservatoryOverview({});
    assert.equal(overview.totalEndpoints, 1);
    assert.equal(overview.rows.length, 1);
    assert.equal(overview.rows.some((r) => JSON.stringify(r).includes("mock-seller-retest")), false);
  });

  test("chain scope counts exclude seller_retest_request listings", async () => {
    const { getChainScope } = await import("@/lib/observatory/reader");
    await truncateAll();
    // テストネットの行で数える（mainnet の行は getChainScope が数えないので除外の有無が見えない）。
    await db.insert(schema.x402Endpoints).values({
      resourceKey: "mock-seller-retest.example/testnet",
      resourceUrl: "https://mock-seller-retest.example/testnet",
      source: srq.SELLER_RETEST_REQUEST_SOURCE,
      method: "GET",
      network: "eip155:84532",
      payTo: "0x1",
      priceAmount: "5000",
      priceAsset: BASE_USDC,
      status: "active",
    });
    await insertOrdinaryListing("listed.example/testnet", "0x2", "eip155:84532");
    const scope = await getChainScope();
    assert.equal(scope.testnetEndpoints, 1);
  });

  test("L0 priority reprobe excludes seller_retest_request listings", async () => {
    const { selectReprobePriority } = await import("@/lib/observatory/reprobe-priority");
    await truncateAll();
    // c1 の窓の外（40 日前）で、公開 fail の宣言（10000）と今の掲載（20000）が違う出品 = 宣言の変化の組。
    const ids: Record<string, string> = {};
    for (const [key, source] of [
      ["drift-seller.example/why", srq.SELLER_RETEST_REQUEST_SOURCE],
      ["drift-ordinary.example/why", "cdp_bazaar"],
    ] as const) {
      const row = rowsOf(
        await db.execute(sql`
          INSERT INTO x402_endpoints (resource_key, resource_url, source, method, network, pay_to, price_amount, price_asset, status, last_seen_at, first_seen_at)
          VALUES (${key}, ${`https://${key}`}, ${source}, 'GET', 'eip155:8453', '0xpay', '20000', '0xusdc', 'active',
                  now() - interval '40 days', now() - interval '40 days')
          RETURNING id::text AS id`),
      )[0]!;
      ids[source] = String(row.id);
      for (const hoursAgo of [400, 300]) {
        await db.execute(sql`
          INSERT INTO x402_l0_probes (endpoint_id, probed_at, method, verdict, http_status, fail_reason, raw_response_meta)
          VALUES (${String(row.id)}::uuid, now() - make_interval(hours => ${hoursAgo}), 'GET', 'fail', 402, 'price_mismatch',
                  ${JSON.stringify({ declared: { amount: "10000", asset: "0xusdc", payTo: "0xpay", network: "eip155:8453" } })}::jsonb)`);
      }
    }
    const picked = await selectReprobePriority(db, 50, false);
    const pickedIds = picked.map((c) => c.id);
    assert.ok(pickedIds.includes(ids.cdp_bazaar!), JSON.stringify(picked));
    assert.equal(pickedIds.includes(ids[srq.SELLER_RETEST_REQUEST_SOURCE]!), false);
  });

  test("L0 rule-change reprobe excludes seller_retest_request listings", async () => {
    const { selectRuleChangeTargets } = await import("@/lib/observatory/l0-rule-change-reprobe");
    await truncateAll();
    // 旧規則の公開 fail（POST が 400 で no_402 を 2 回）。
    const ids: Record<string, string> = {};
    for (const [key, source] of [
      ["rule-seller.example/post", srq.SELLER_RETEST_REQUEST_SOURCE],
      ["rule-ordinary.example/post", "cdp_bazaar"],
    ] as const) {
      const row = rowsOf(
        await db.execute(sql`
          INSERT INTO x402_endpoints (resource_key, resource_url, source, method, network, pay_to, price_amount, price_asset, status, first_seen_at)
          VALUES (${key}, ${`https://${key}`}, ${source}, 'POST', 'eip155:8453', '0xpay', '1000', '0xusdc', 'active', now() - interval '20 days')
          RETURNING id::text AS id`),
      )[0]!;
      ids[source] = String(row.id);
      for (const hoursAgo of [30, 50]) {
        await db.execute(sql`
          INSERT INTO x402_l0_probes (endpoint_id, probed_at, method, verdict, http_status, fail_reason, raw_response_meta)
          VALUES (${String(row.id)}::uuid, now() - make_interval(hours => ${hoursAgo}), 'POST', 'fail', 400, 'no_402',
                  ${JSON.stringify({ status: 400, bodyHead: '{"error":"missing field"}' })}::jsonb)`);
      }
    }
    const targets = await selectRuleChangeTargets(100);
    const targetIds = targets.map((t) => t.id);
    assert.ok(targetIds.includes(ids.cdp_bazaar!), JSON.stringify(targets));
    assert.equal(targetIds.includes(ids[srq.SELLER_RETEST_REQUEST_SOURCE]!), false);
  });

  test("B2 halt after claim: presign row released as halted, sweep leaves it, next run buys", async () => {
    await seedOnlyPending([catalog[0]!.id]);
    const url0 = srq.resolveSellerRetestUrl(catalog[0]!.url, PAYER);
    await installHaltOnPresign();
    const run1 = await runSeller();
    assert.equal(run1.halted, true, JSON.stringify(run1));
    assert.equal(paidHits.get(url0) ?? 0, 0, "nothing signed may leave");
    const [row] = await rowsForRequest(catalog[0]!.id);
    assert.ok(row);
    assert.equal(row.status, "halted");
    assert.equal(row.spentUnits, "0");
    assert.equal(row.authNonce, null);
    await dropTestTriggers();
    // 孤児の掃除が走っても settle_failed（署名したことになる）にならない。
    await l1.sweepOrphanedInFlight(db, 0);
    const [afterSweep] = await rowsForRequest(catalog[0]!.id);
    assert.equal(afterSweep!.status, "halted");
    assert.equal(afterSweep!.authNonce, null);
    // 次の実行（同じ日）でその依頼を買える。
    const run2 = await runSeller();
    assert.equal(run2.sellerRequestCandidates, 1, JSON.stringify(run2));
    assert.equal(await paidRowsFor(catalog[0]!.id), 1, JSON.stringify(run2));
  });

  test("B2 orphan sweep: stale presign row becomes unsigned request_error, next run buys", async () => {
    await seedOnlyPending([catalog[0]!.id]);
    const url0 = srq.resolveSellerRetestUrl(catalog[0]!.url, PAYER);
    // 停止スイッチ + 解放の UPDATE を落とす（実行が死んだのと同じ: 行は in_flight・presign: のまま残る）。
    await installHaltOnPresign();
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION test_sr_block_release_fn() RETURNS trigger AS $$
      BEGIN
        IF OLD.status = 'in_flight' AND NEW.status <> 'in_flight' AND OLD.auth_nonce LIKE 'presign:%' THEN
          RAISE EXCEPTION 'test: runner died before releasing';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_sr_block_release BEFORE UPDATE ON x402_l1_purchases
        FOR EACH ROW EXECUTE FUNCTION test_sr_block_release_fn();
    `));
    const run1 = await runSeller();
    assert.equal(run1.halted, true, JSON.stringify(run1));
    const [stuck] = await rowsForRequest(catalog[0]!.id);
    assert.equal(stuck!.status, "in_flight");
    assert.ok(String(stuck!.authNonce).startsWith("presign:"), String(stuck!.authNonce));
    await dropTestTriggers();
    await db.execute(sql`
      UPDATE x402_l1_purchases SET attempted_at = now() - interval '1 hour'
      WHERE raw_response_meta->>'sellerRequestId' = ${catalog[0]!.id}
    `);
    // 次の実行: 最初に孤児の掃除（本物の sweepOrphanedInFlight）が印の行を未署名として戻し、続けてその依頼を買う。
    const run2 = await runSeller();
    assert.equal(run2.orphansResolved, 1, JSON.stringify(run2));
    const rows = await rowsForRequest(catalog[0]!.id);
    const swept = rows.find((r) => (r.rawResponseMeta as { reason?: string })?.reason === "orphaned_in_flight");
    assert.ok(swept, JSON.stringify(rows.map((r) => [r.status, r.authNonce])));
    assert.equal(swept.status, "request_error");
    assert.equal(swept.spentUnits, "0");
    assert.equal(swept.authNonce, null);
    assert.equal((swept.rawResponseMeta as { credentialSent?: boolean }).credentialSent, false);
    assert.equal(paidHits.get(url0), 1);
    assert.equal(await paidRowsFor(catalog[0]!.id), 1);
  });

  test("B2 resolve: exception after claim before the paid request releases the presign row, next run buys", async () => {
    await seedOnlyPending([catalog[0]!.id]);
    const url0 = srq.resolveSellerRetestUrl(catalog[0]!.url, PAYER);
    // 署名の直後の nonce の書き込みを落とす（有料の要求の前の例外 → resolveReservationAsFailed）。
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION test_sr_block_nonce_write_fn() RETURNS trigger AS $$
      BEGIN
        IF OLD.auth_nonce LIKE 'presign:%' AND NEW.auth_nonce IS NOT NULL AND NEW.auth_nonce NOT LIKE 'presign:%' THEN
          RAISE EXCEPTION 'test: nonce write failed';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_sr_block_nonce_write BEFORE UPDATE ON x402_l1_purchases
        FOR EACH ROW EXECUTE FUNCTION test_sr_block_nonce_write_fn();
    `));
    await runSeller();
    assert.equal(paidHits.get(url0) ?? 0, 0, "the paid request must not go out");
    const [row] = await rowsForRequest(catalog[0]!.id);
    assert.ok(row);
    assert.equal(row.status, "request_error", JSON.stringify(row.rawResponseMeta));
    assert.equal(row.spentUnits, "0");
    assert.equal(row.authNonce, null);
    assert.equal((row.rawResponseMeta as { credentialSent?: boolean }).credentialSent, false);
    assert.equal((row.rawResponseMeta as { reason?: string }).reason, "threw_after_reservation");
    await dropTestTriggers();
    const run2 = await runSeller();
    assert.equal(run2.sellerRequestCandidates, 1, JSON.stringify(run2));
    assert.equal(await paidRowsFor(catalog[0]!.id), 1, JSON.stringify(run2));
  });

  test("catalog sync does not delist seller_retest_request rows", async () => {
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    await truncateAll();
    const ep = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "mock-seller-retest.example/orphan",
        resourceUrl: "https://mock-seller-retest.example/orphan",
        source: srq.SELLER_RETEST_REQUEST_SOURCE,
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
    assert.equal(row[0]?.source, srq.SELLER_RETEST_REQUEST_SOURCE);
  });
}
