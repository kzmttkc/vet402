// ============================================================
// L1 の Arc レーン — フラグ・別枠・残高の関門（2026-09-17）。
//
// Arc（Circle のステーブルコイン L1・eip155:5042・メインネット公開 2026-09-16）は
// Base と同じ EOA（OBSERVATORY_WALLET_PRIVATE_KEY）で EIP-3009 に署名する 2 本目の
// EVM レーン。Solana の別枠（l1-solana-daily-cap.pg.test.ts）と同じ規律で守る:
//
//  1. OBSERVATORY_ARC_L1_ENABLED が "true" でなければ、Arc の候補には 1 リクエストも
//     出さず、台帳に行を書かない（SQL の段階で候補から外す）。Base はそのまま買う。
//  2. フラグが on なら、Arc の売り手を PAYMENT-SIGNATURE 付きで買い、行の network は
//     eip155:5042・asset は Arc USDC（0x3600…）。
//  3. その UTC 日の Arc の支出が別枠（既定 $2）に達したら、Arc には 1 リクエストも出さない。
//     別枠の残りが 1 件分に足りないときは予約で断り、**行を書かない**。
//  4. Arc の購入元残高が足りなければ署名せず、行も書かない。Base はそのまま買う
//     （残高はチェーンごとに別。同じ EOA でも Arc の USDC は Base の USDC ではない）。
//
// 402 の壁は api.exa.ai が eip155:5042 に公開している 2 つの accept（実測 2026-09-17・
// raw_accepts）の形: EIP-3009（署名できる）と GatewayWalletBatched（別ドメイン・拒否）。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-arc-lane.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 arc lane (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const payToFor = (n: string | number) => `0x${String(n).repeat(40).slice(0, 40)}`;
  const ARC_CAIP2 = "eip155:5042";
  const ARC_USDC = "0x3600000000000000000000000000000000000000";
  const GATEWAY_CONTRACT = "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee";

  test("L1 Arc lane", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");

    const db = getDb()!;

    const saved = {
      l1: process.env.OBSERVATORY_L1_ENABLED,
      pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY,
      arcOn: process.env.OBSERVATORY_ARC_L1_ENABLED,
      cap: process.env.L1_ARC_DAILY_CAP_USD,
      solOn: process.env.OBSERVATORY_SOLANA_L1_ENABLED,
    };
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    t.after(() => {
      restore("OBSERVATORY_L1_ENABLED", saved.l1);
      restore("OBSERVATORY_WALLET_PRIVATE_KEY", saved.pk);
      restore("OBSERVATORY_ARC_L1_ENABLED", saved.arcOn);
      restore("L1_ARC_DAILY_CAP_USD", saved.cap);
      restore("OBSERVATORY_SOLANA_L1_ENABLED", saved.solOn);
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    delete process.env.OBSERVATORY_SOLANA_L1_ENABLED;
    delete process.env.L1_ARC_DAILY_CAP_USD; // 既定 $2

    /** 残高: Base も Arc も十分（chain を見て別々に返す）。 */
    const FUNDED = async () => 1_000_000_000n;

    const baseItem = (n: number) =>
      parseCatalogItem({
        resource: `https://seller${n}.example/api`,
        accepts: [{ amount: "3000", asset: BASE_USDC, network: "eip155:8453", payTo: payToFor(n) }],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        quality: { l30DaysTotalCalls: 100, l30DaysUniquePayers: 10 },
      });
    /** api.exa.ai と同じ形: 1 endpoint に eip3009 と GatewayWalletBatched の 2 accept。カタログの先頭は eip3009。 */
    const arcItem = (n: number) =>
      parseCatalogItem({
        resource: `https://arcseller${n}.example/search`,
        accepts: [
          { amount: "4000", asset: ARC_USDC, network: ARC_CAIP2, payTo: payToFor(n + 4), extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2", acceptId: "arc-usdc-circle" } },
          { amount: "4000", asset: ARC_USDC, network: ARC_CAIP2, payTo: payToFor(n + 4), extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY_CONTRACT } },
        ],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        // 需要を高くして Base より先に選ばれる並びにする（押し出しの最悪ケース）
        quality: { l30DaysTotalCalls: 5000, l30DaysUniquePayers: 500 },
      });
    const baseChallenge = (url: string) => {
      const n = /seller(\d)/.exec(url)?.[1] ?? "1";
      return JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: "exact", network: "eip155:8453", amount: "3000", asset: BASE_USDC, payTo: payToFor(n), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
      });
    };
    const arcChallenge = (url: string) => {
      const n = Number(/arcseller(\d)/.exec(url)?.[1] ?? "1");
      return JSON.stringify({
        x402Version: 2,
        accepts: [
          // Gateway を先に並べる——選ばれてはいけない方が先頭にあっても eip3009 を選ぶこと。
          { scheme: "exact", network: ARC_CAIP2, amount: "4000", asset: ARC_USDC, payTo: payToFor(n + 4), maxTimeoutSeconds: 300, extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY_CONTRACT, acceptId: "arc-usdc-gateway" } },
          { scheme: "exact", network: ARC_CAIP2, amount: "4000", asset: ARC_USDC, payTo: payToFor(n + 4), maxTimeoutSeconds: 300, extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2", acceptId: "arc-usdc-circle" } },
        ],
      });
    };
    const challengeFor = (url: string) => (url.includes("arcseller") ? arcChallenge(url) : baseChallenge(url));

    /** 402 → 支払い付きリトライは 200。どの URL に支払い付きで来たか・何を送ったかを記録する。 */
    const wall = () => {
      const seen: { url: string; paid: boolean; accepted: Record<string, unknown> | null }[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const sig = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
        const accepted = sig ? ((JSON.parse(Buffer.from(sig, "base64").toString("utf8")) as { accepted?: Record<string, unknown> }).accepted ?? null) : null;
        seen.push({ url, paid: sig !== null, accepted });
        if (!sig) return new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } });
        const isArc = url.includes("arcseller");
        // tx は売り手ごとに一意にする（台帳の UNIQUE (network, lower(tx_hash)) に当たらないため）。
        const n = /seller(\d)/.exec(url)?.[1] ?? "9";
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({
                success: true,
                transaction: `0x${(isArc ? `c${n}` : `a${n}`).repeat(32)}`,
                network: isArc ? ARC_CAIP2 : "eip155:8453",
                payer: "0x0000000000000000000000000000000000000001",
              }),
            ).toString("base64"),
          },
        });
      };
      return { seen, fetchImpl };
    };

    async function seed() {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      await syncCatalog({
        fetchResult: { items: [baseItem(1), arcItem(1), arcItem(2), arcItem(3)], totalCount: 4, fetchedCount: 4, complete: true },
        today: "2026-09-17",
      });
      await runL0ProbeBatch({
        limit: 10,
        concurrency: 2,
        fetchImpl: async (url: string) => new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } }),
      });
    }

    /** その UTC 日の Arc 支出を、arcseller3 の既存行として台帳に置く。 */
    async function spendArcToday(units: number) {
      const rows = await db.execute(sql`SELECT id FROM x402_endpoints WHERE resource_url = 'https://arcseller3.example/search'`);
      const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as { id: string }[];
      await db.insert(schema.x402L1Purchases).values({
        endpointId: list[0].id,
        status: "settle_claimed",
        payer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        network: ARC_CAIP2,
        asset: ARC_USDC,
        payTo: payToFor(7),
        amountUnits: String(units),
        spentUnits: String(units),
      });
    }

    const ledgerFor = async (resourceUrl: string) => {
      const raw = await db.execute(sql`
        SELECT pu.status, pu.network, pu.asset, pu.spent_units FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE e.resource_url = ${resourceUrl}`);
      return ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { status: string; network: string; asset: string; spent_units: string }[]).map(
        (r) => ({ status: r.status, network: r.network, asset: r.asset, spent_units: r.spent_units }),
      );
    };
    const arcRequests = (w: ReturnType<typeof wall>) => w.seen.filter((s) => s.url.includes("arcseller"));

    await t.test("フラグ off: Arc の候補には 1 リクエストも出さず、行も書かない。Base は買う", async () => {
      await seed();
      delete process.env.OBSERVATORY_ARC_L1_ENABLED;
      const w = wall();
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
      assert.equal(arcRequests(w).length, 0, "Arc の売り手へのリクエストは 0 本（無払いも含む）");
      assert.ok(w.seen.some((s) => s.url.includes("seller1.example") && s.paid), "Base の候補は支払い付きで買う");
      assert.ok(summary.settled >= 1);
      for (const n of [1, 2, 3]) assert.deepEqual(await ledgerFor(`https://arcseller${n}.example/search`), [], `arcseller${n} に行を書かない`);
    });

    await t.test("フラグ \"1\" は off（\"true\" だけが on）", async () => {
      await seed();
      process.env.OBSERVATORY_ARC_L1_ENABLED = "1";
      const w = wall();
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
      assert.equal(arcRequests(w).length, 0);
    });

    await t.test("フラグ on: Arc の売り手を eip3009 の accept で支払い付きで買い、行は eip155:5042 / Arc USDC", async () => {
      await seed();
      process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
      const w = wall();
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
      const paidArc = arcRequests(w).filter((s) => s.paid);
      assert.ok(paidArc.length >= 1, "Arc の候補を支払い付きで買う");
      for (const s of paidArc) {
        assert.equal(s.accepted?.network, ARC_CAIP2);
        assert.equal(s.accepted?.asset, ARC_USDC);
        assert.equal((s.accepted?.extra as Record<string, unknown> | undefined)?.acceptId, "arc-usdc-circle", "GatewayWalletBatched は選ばれない");
      }
      assert.ok(w.seen.some((s) => s.url.includes("seller1.example") && s.paid), "Base も買う");
      assert.ok(summary.settled >= 2);
      const rows = await ledgerFor("https://arcseller1.example/search");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].network, ARC_CAIP2);
      assert.equal(rows[0].asset, ARC_USDC.toLowerCase());
      assert.equal(rows[0].spent_units, "4000");
      assert.equal(rows[0].status, "settle_claimed", "決済は照合 cron が確定させる（settled を名乗らない）");
    });

    await t.test("別枠を使い切った日は Arc に 1 リクエストも出さず、Base は買う", async () => {
      await seed();
      process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
      await spendArcToday(2_000_000); // $2 ちょうど
      const w = wall();
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
      assert.equal(arcRequests(w).length, 0, "Arc の候補には触れない");
      assert.ok(w.seen.some((s) => s.url.includes("seller1.example") && s.paid), "Base は買う");
      assert.deepEqual(await ledgerFor("https://arcseller1.example/search"), [], "Arc の売り手に行を書かない");
      assert.deepEqual(await ledgerFor("https://arcseller2.example/search"), []);
    });

    await t.test("別枠の残りが 1 件分に足りない: 予約で断り、行を書かず、支払い付きで出さない", async () => {
      await seed();
      process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
      await spendArcToday(2_000_000 - 1000); // 残り 1000 units < 1 件 4000 units
      const w = wall();
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
      assert.ok(!arcRequests(w).some((s) => s.paid), "Arc へ支払い付きのリクエストは出ない");
      assert.deepEqual(await ledgerFor("https://arcseller1.example/search"), [], "行が無い＝翌日また選ばれる");
      assert.deepEqual(await ledgerFor("https://arcseller2.example/search"), []);
      assert.ok(w.seen.some((s) => s.url.includes("seller1.example") && s.paid), "Base は買う");
    });

    await t.test("別枠の内側なら当日の Arc 支出は $2 以内に収まる（$2 で止まる）", async () => {
      await seed();
      process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
      await spendArcToday(2_000_000 - 4000); // 残りちょうど 1 件分
      const w = wall();
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
      assert.equal(arcRequests(w).filter((s) => s.paid).length, 1, "1 件だけ買える");
      const spent = await db.execute(sql`
        SELECT coalesce(sum(spent_units::numeric), 0)::text AS s FROM x402_l1_purchases WHERE network = ${ARC_CAIP2}`);
      const s = ((Array.isArray(spent) ? spent : (spent as { rows?: unknown[] }).rows ?? []) as { s: string }[])[0].s;
      assert.equal(Number(s), 2_000_000, `Arc の当日支出は別枠ちょうど (${s})`);
    });

    await t.test("L1_ARC_DAILY_CAP_USD=0 は Arc を止める（フラグ on のまま）", async () => {
      await seed();
      process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
      process.env.L1_ARC_DAILY_CAP_USD = "0";
      try {
        const w = wall();
        await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
        assert.equal(arcRequests(w).length, 0);
        assert.ok(w.seen.some((s) => s.url.includes("seller1.example") && s.paid), "Base は買う");
      } finally {
        delete process.env.L1_ARC_DAILY_CAP_USD;
      }
    });

    await t.test("残高の関門: Arc の USDC が足りなければ署名せず行も書かない。Base は買う（残高はチェーンごと）", async () => {
      await seed();
      process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
      const w = wall();
      const seenChains: string[] = [];
      const summary = await runL1Batch({
        limit: 10,
        fetchImpl: w.fetchImpl,
        getPayerUsdcBalance: async ({ chain }) => {
          seenChains.push(chain);
          return chain === "arc" ? 0n : 10_000_000n;
        },
      });
      assert.ok(seenChains.includes("arc"), "Arc の残高を Arc として読む");
      assert.ok(!arcRequests(w).some((s) => s.paid), "Arc へ支払い付きのリクエストは出ない");
      assert.ok(summary.payerUnfunded >= 1);
      for (const n of [1, 2, 3]) assert.deepEqual(await ledgerFor(`https://arcseller${n}.example/search`), [], `arcseller${n} に行を書かない`);
      assert.ok(w.seen.some((s) => s.url.includes("seller1.example") && s.paid), "Base は買う");
    });

    await t.test("残高が読めなければ署名しない（Arc の RPC が落ちていても Base は買う）", async () => {
      await seed();
      process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
      const w = wall();
      await runL1Batch({
        limit: 10,
        fetchImpl: w.fetchImpl,
        getPayerUsdcBalance: async ({ chain }) => {
          if (chain === "arc") throw new Error("arc rpc down");
          return 10_000_000n;
        },
      });
      assert.ok(!arcRequests(w).some((s) => s.paid));
      assert.deepEqual(await ledgerFor("https://arcseller1.example/search"), []);
      assert.ok(w.seen.some((s) => s.url.includes("seller1.example") && s.paid), "Base は買う");
    });
  });
}
