// ============================================================
// L1 レーンの accept 優先 — Base 先頭・Arc 2 番目のエンドポイント（2026-09-17）。
//
// 本番の事実: Arc を主ネットワークにする稼働中エンドポイントは 0 件。api.exa.ai の 2 件
// （/contents・/search）は e.network = eip155:8453 で、Arc の accept は raw_accepts の 2 番目以降。
// 従来は並び順で Base が勝ち、レーン枠も e.network LIKE だったので、Arc レーンは旗 ON でも
// 1 件も買えなかった。
//
// 守ること:
//  1. Arc の旗 ON: exa 相当の行で Arc の eip3009 accept が選ばれ、台帳の行は network = eip155:5042・
//     asset = Arc USDC・別枠 arc（当日 Arc 支出に載る）・残高は arc として読む。
//  2. その行が Arc で settled した後の 2 回目（掃引窓の外）は従来の並びに戻り Base が選ばれる。
//  3. レーン枠（summary.laneFloor.arc）に secondary-accept のエンドポイントが載る（settled 後は載らない）。
//  4. 旗 OFF: Base のまま・レーン枠 0・Arc の行 0。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-lane-accept-preference.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 lane accept preference (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const ARC_CAIP2 = "eip155:5042";
  const ARC_USDC = "0x3600000000000000000000000000000000000000";
  const GATEWAY_CONTRACT = "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee";
  const EXA_PAYTO = "0xb98ef29eb2be19ae646a8fc0248255b90a332dbc";
  const PLAIN_PAYTO = "0x2222222222222222222222222222222222222222";

  test("L1 lane accept preference", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const saved = {
      l1: process.env.OBSERVATORY_L1_ENABLED,
      pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY,
      arcOn: process.env.OBSERVATORY_ARC_L1_ENABLED,
      solOn: process.env.OBSERVATORY_SOLANA_L1_ENABLED,
      floor: process.env.L1_LANE_FLOOR_PER_RUN,
    };
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    t.after(() => {
      restore("OBSERVATORY_L1_ENABLED", saved.l1);
      restore("OBSERVATORY_WALLET_PRIVATE_KEY", saved.pk);
      restore("OBSERVATORY_ARC_L1_ENABLED", saved.arcOn);
      restore("OBSERVATORY_SOLANA_L1_ENABLED", saved.solOn);
      restore("L1_LANE_FLOOR_PER_RUN", saved.floor);
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    delete process.env.OBSERVATORY_SOLANA_L1_ENABLED;
    delete process.env.L1_LANE_FLOOR_PER_RUN;

    /** exa.ai /search と同じ形: Base 先頭（宣言 3000）・Arc eip3009（4000）・Arc Gateway。 */
    const EXA_ACCEPTS = [
      { scheme: "exact", network: "eip155:8453", amount: "3000", asset: BASE_USDC, payTo: EXA_PAYTO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } },
      { scheme: "exact", network: ARC_CAIP2, amount: "4000", asset: ARC_USDC, payTo: EXA_PAYTO, maxTimeoutSeconds: 300, extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2", acceptId: "arc-usdc-circle" } },
      { scheme: "exact", network: ARC_CAIP2, amount: "4000", asset: ARC_USDC, payTo: EXA_PAYTO, maxTimeoutSeconds: 300, extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY_CONTRACT, acceptId: "arc-usdc-gateway" } },
    ];
    const PLAIN_ACCEPTS = [{ scheme: "exact", network: "eip155:8453", amount: "3000", asset: BASE_USDC, payTo: PLAIN_PAYTO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }];
    const EXA_URL = "https://api.exa.example/search";
    const PLAIN_URL = "https://plain.example/api";
    const acceptsFor = (url: string) => (url === EXA_URL ? EXA_ACCEPTS : PLAIN_ACCEPTS);
    const challengeFor = (url: string) => JSON.stringify({ x402Version: 2, accepts: acceptsFor(url) });

    const items = () => [
      // exa は需要を低くして、主候補の並びでは plain の後ろに来るようにする（枠が効いていることを見る）。
      parseCatalogItem({ resource: EXA_URL, accepts: EXA_ACCEPTS, extensions: { bazaar: { info: { input: { method: "GET" } } } }, quality: { l30DaysTotalCalls: 10, l30DaysUniquePayers: 1 } }),
      parseCatalogItem({ resource: PLAIN_URL, accepts: PLAIN_ACCEPTS, extensions: { bazaar: { info: { input: { method: "GET" } } } }, quality: { l30DaysTotalCalls: 5000, l30DaysUniquePayers: 500 } }),
    ];

    let txSeq = 0;
    const wall = () => {
      const seen: { url: string; paid: boolean; accepted: Record<string, unknown> | null }[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const sig = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
        const accepted = sig ? ((JSON.parse(Buffer.from(sig, "base64").toString("utf8")) as { accepted?: Record<string, unknown> }).accepted ?? null) : null;
        seen.push({ url, paid: sig !== null, accepted });
        if (!sig) return new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } });
        txSeq += 1;
        const network = String(accepted?.network ?? "eip155:8453");
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({ success: true, transaction: `0x${txSeq.toString(16).padStart(4, "0").repeat(16)}`, network, payer: "0x0000000000000000000000000000000000000001" }),
            ).toString("base64"),
          },
        });
      };
      const paidTo = (url: string) => seen.filter((s) => s.paid && s.url === url).map((s) => s.accepted);
      return { seen, fetchImpl, paidTo };
    };

    async function seed() {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      const list = items();
      await syncCatalog({ fetchResult: { items: list, totalCount: list.length, fetchedCount: list.length, complete: true }, today: "2026-09-17" });
      await runL0ProbeBatch({ limit: 10, concurrency: 2, fetchImpl: async (url: string) => new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } }) });
    }
    const rowsFor = async (url: string) => {
      const raw = await db.execute(sql`
        SELECT pu.status, pu.network, pu.asset, pu.spent_units, pu.attempted_at FROM x402_l1_purchases pu
        JOIN x402_endpoints e ON e.id = pu.endpoint_id WHERE e.resource_url = ${url} ORDER BY pu.attempted_at ASC`);
      return ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { status: string; network: string; asset: string; spent_units: string }[]).map(
        (r) => ({ status: r.status, network: r.network, asset: r.asset, spent_units: r.spent_units }),
      );
    };
    const arcSpentToday = async () => {
      const raw = await db.execute(sql`SELECT coalesce(sum(spent_units::numeric), 0)::text AS s FROM x402_l1_purchases WHERE network = ${ARC_CAIP2}`);
      return Number(((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { s: string }[])[0].s);
    };
    const run = async (w: ReturnType<typeof wall>, chains: string[] = []) =>
      await runL1Batch({
        limit: 10,
        fetchImpl: w.fetchImpl,
        getPayerUsdcBalance: async ({ chain }) => {
          chains.push(chain);
          return 1_000_000_000n;
        },
      });

    await t.test("旗 OFF: exa は Base の accept で買われ、レーン枠は 0・Arc の行は 0", async () => {
      await seed();
      delete process.env.OBSERVATORY_ARC_L1_ENABLED;
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.laneFloor.arc ?? 0, 0);
      const paid = w.paidTo(EXA_URL);
      assert.equal(paid.length, 1);
      assert.equal(paid[0]?.network, "eip155:8453");
      assert.deepEqual(await rowsFor(EXA_URL), [{ status: "settle_claimed", network: "eip155:8453", asset: BASE_USDC, spent_units: "3000" }]);
      assert.equal(await arcSpentToday(), 0);
    });

    await t.test("旗 ON: exa はレーン枠に載り、Arc の eip3009 accept で買われ、行は eip155:5042・Arc USDC・別枠 arc・残高 arc", async () => {
      await seed();
      process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
      const w = wall();
      const chains: string[] = [];
      const summary = await run(w, chains);
      assert.equal(summary.laneFloor.arc, 1, "secondary accept のエンドポイントがレーン枠に載る");
      assert.equal(w.seen[0]?.url, EXA_URL, "需要が低くても枠で先頭に来る");
      const paid = w.paidTo(EXA_URL);
      assert.equal(paid.length, 1);
      assert.equal(paid[0]?.network, ARC_CAIP2);
      assert.equal(paid[0]?.asset, ARC_USDC);
      assert.equal((paid[0]?.extra as Record<string, unknown>)?.acceptId, "arc-usdc-circle", "Gateway ではなく eip3009");
      assert.deepEqual(await rowsFor(EXA_URL), [{ status: "settle_claimed", network: ARC_CAIP2, asset: ARC_USDC, spent_units: "4000" }]);
      assert.equal(await arcSpentToday(), 4000, "別枠 arc に載る（reserveSpend の cappedChainFor は accept の network）");
      assert.ok(chains.includes("arc"), "残高は arc として読む");
      // plain（Base だけの売り手）は従来どおり Base。
      assert.equal(w.paidTo(PLAIN_URL)[0]?.network, "eip155:8453");
    });

    await t.test("Arc で settled した後の 2 回目（掃引窓の外）: レーン枠に載らず、従来の並びで Base が選ばれる", async () => {
      // 直前の subtest の台帳を使う。exa の Arc 行を settled にし、掃引窓（6 日）の外へずらす。
      await db.execute(sql`
        UPDATE x402_l1_purchases SET status = 'settled', settlement_verified = true, attempted_at = now() - interval '8 days'
        WHERE network = ${ARC_CAIP2}`);
      await db.execute(sql`UPDATE x402_l1_purchases SET attempted_at = now() - interval '8 days' WHERE network = 'eip155:8453'`);
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.laneFloor.arc ?? 0, 0, "そのチェーンで settled 済みの行はレーン枠に入らない");
      const paid = w.paidTo(EXA_URL);
      assert.equal(paid.length, 1, "主候補として買い直される");
      assert.equal(paid[0]?.network, "eip155:8453", "レーンの実績は 1 回でよい——以後は Base");
      const rows = await rowsFor(EXA_URL);
      assert.equal(rows.length, 2);
      assert.equal(rows[1].network, "eip155:8453");
    });

    await t.test("Arc の行が settle_claimed 止まり（未照合）でも決済主張として数え、次の掃引は Base に戻る（レビュー C4）", async () => {
      await seed();
      process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
      await run(wall());
      await db.execute(sql`UPDATE x402_l1_purchases SET attempted_at = now() - interval '8 days'`);
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.laneFloor.arc ?? 0, 0, "settle_claimed の行がある endpoint は secondary の枠に入らない");
      assert.equal(w.paidTo(EXA_URL)[0]?.network, "eip155:8453");
    });
  });
}
