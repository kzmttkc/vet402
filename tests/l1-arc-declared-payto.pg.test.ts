// ============================================================
// L1 Arc レーン — カタログが Arc の accept を「先頭と別の payTo」で宣言しているエンドポイント（2026-09-19）。
//
// 本番の事実（2026-09-18T18:00Z のバッチ）: https://api.exa.ai/search（e.network = eip155:8453・
// pay_to = 0x6d6e…9192・price_amount = 7000）は Arc のレーン枠で先頭に載ったが、Base の legacy accept で
// 買われた。raw_accepts は Arc の accept を payTo 0xB98e…2dbC で宣言している。selectAccept が先頭 accept の
// pay_to としか照合しなかったので、Arc の accept は payTo の関門で必ず落ちていた。
// （tests/l1-lane-accept-preference.pg.test.ts の fixture は全 accept が同じ payTo で、この形を見ていなかった。）
//
// 守ること:
//  1. Arc の旗 ON: レーン枠の exa は Arc の eip3009 accept で買われ、行は network = eip155:5042・asset = Arc USDC・
//     pay_to = カタログが宣言した Arc の payTo（0xb98e…）・別枠 arc・残高 arc。
//  2. 壁が Arc の accept にカタログに無い payTo を出したら、Arc では買わず Base（legacy の payTo）で買う。
//  3. 自己取引の関門は選んだ accept の payTo に掛かる（Arc の payTo が運用者のものなら payto_operator_self・支出 0）。
//  4. 旗 OFF: 従来どおり Base。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_arc4_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-arc-declared-payto.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 arc declared payTo (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const ARC_CAIP2 = "eip155:5042";
  const BASE_CAIP2 = "eip155:8453";
  const ARC_USDC = "0x3600000000000000000000000000000000000000";
  const GATEWAY_CONTRACT = "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee";
  const LEGACY_PAYTO = "0x6d6E695b09861467c7d462f5AAF31cF3540B9192";
  const CIRCLE_PAYTO = "0xB98eF29eb2be19Ae646A8FC0248255B90A332dbC";
  const ROGUE_PAYTO = "0x1111111111111111111111111111111111111111";

  test("L1 Arc lane: catalog-declared Arc payTo", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { resetDerivedOperatorAddresses } = await import("@/lib/observatory/operator");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const saved = {
      l1: process.env.OBSERVATORY_L1_ENABLED,
      pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY,
      arcOn: process.env.OBSERVATORY_ARC_L1_ENABLED,
      solOn: process.env.OBSERVATORY_SOLANA_L1_ENABLED,
      floor: process.env.L1_LANE_FLOOR_PER_RUN,
      operator: process.env.VET402_OPERATOR_PAYTO,
    };
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    t.after(() => {
      restore("OBSERVATORY_L1_ENABLED", saved.l1);
      restore("OBSERVATORY_WALLET_PRIVATE_KEY", saved.pk);
      restore("OBSERVATORY_ARC_L1_ENABLED", saved.arcOn);
      restore("OBSERVATORY_SOLANA_L1_ENABLED", saved.solOn);
      restore("L1_LANE_FLOOR_PER_RUN", saved.floor);
      restore("VET402_OPERATOR_PAYTO", saved.operator);
      resetDerivedOperatorAddresses();
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    delete process.env.OBSERVATORY_SOLANA_L1_ENABLED;
    delete process.env.L1_LANE_FLOOR_PER_RUN;
    delete process.env.VET402_OPERATOR_PAYTO;

    /** exa.ai /search の実物の形: 先頭は Base legacy（カタログの pay_to になる）、Base circle、Arc eip3009、Arc Gateway。 */
    const exaAccepts = (arcPayTo: string) => [
      { scheme: "exact", network: BASE_CAIP2, amount: "7000", asset: BASE_USDC, payTo: LEGACY_PAYTO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2", acceptId: "legacy" } },
      { scheme: "exact", network: BASE_CAIP2, amount: "7000", asset: BASE_USDC, payTo: CIRCLE_PAYTO, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2", acceptId: "base-usdc-circle", assetTransferMethod: "eip3009" } },
      { scheme: "exact", network: ARC_CAIP2, amount: "7000", asset: ARC_USDC, payTo: arcPayTo, maxTimeoutSeconds: 300, extra: { name: "USDC", version: "2", acceptId: "arc-usdc-circle", assetTransferMethod: "eip3009" } },
      { scheme: "exact", network: ARC_CAIP2, amount: "7000", asset: ARC_USDC, payTo: arcPayTo, maxTimeoutSeconds: 300, extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: GATEWAY_CONTRACT, acceptId: "arc-usdc-gateway" } },
    ];
    const CATALOG_ACCEPTS = exaAccepts(CIRCLE_PAYTO);
    const EXA_URL = "https://api.exa.example/search";

    let txSeq = 0;
    /** 壁。無払いの 402 と支払い後の応答。wallAccepts がカタログと違えば「壁が別の payTo を出した」の再現になる。 */
    const wall = (wallAccepts: unknown[]) => {
      const seen: { paid: boolean; accepted: Record<string, unknown> | null }[] = [];
      const fetchImpl = async (_url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const sig = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
        const accepted = sig ? ((JSON.parse(Buffer.from(sig, "base64").toString("utf8")) as { accepted?: Record<string, unknown> }).accepted ?? null) : null;
        seen.push({ paid: sig !== null, accepted });
        if (!sig) return new Response(JSON.stringify({ x402Version: 2, accepts: wallAccepts }), { status: 402, headers: { "content-type": "application/json" } });
        txSeq += 1;
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({ success: true, transaction: `0x${txSeq.toString(16).padStart(4, "0").repeat(16)}`, network: String(accepted?.network ?? BASE_CAIP2), payer: "0x0000000000000000000000000000000000000001" }),
            ).toString("base64"),
          },
        });
      };
      const paid = () => seen.filter((s) => s.paid).map((s) => s.accepted);
      return { fetchImpl, paid };
    };

    async function seed() {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      const list = [
        parseCatalogItem({ resource: EXA_URL, accepts: CATALOG_ACCEPTS, extensions: { bazaar: { info: { input: { method: "GET" } } } }, quality: { l30DaysTotalCalls: 10, l30DaysUniquePayers: 1 } }),
      ];
      await syncCatalog({ fetchResult: { items: list, totalCount: list.length, fetchedCount: list.length, complete: true }, today: "2026-09-19" });
      await runL0ProbeBatch({
        limit: 10,
        concurrency: 1,
        fetchImpl: async () => new Response(JSON.stringify({ x402Version: 2, accepts: CATALOG_ACCEPTS }), { status: 402, headers: { "content-type": "application/json" } }),
      });
      // seed の前提を固定する: カタログの先頭 pay_to は legacy（本番の exa と同じ）。
      const raw = await db.execute(sql`SELECT pay_to, network, price_amount FROM x402_endpoints WHERE resource_url = ${EXA_URL}`);
      const row = ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { pay_to: string; network: string; price_amount: string }[])[0];
      assert.deepEqual({ ...row }, { pay_to: LEGACY_PAYTO.toLowerCase(), network: BASE_CAIP2, price_amount: "7000" });
    }
    const rows = async () => {
      const raw = await db.execute(sql`
        SELECT pu.status, pu.network, pu.asset, pu.pay_to, pu.spent_units FROM x402_l1_purchases pu
        JOIN x402_endpoints e ON e.id = pu.endpoint_id WHERE e.resource_url = ${EXA_URL} ORDER BY pu.attempted_at ASC`);
      return ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<string, string>[]).map((r) => ({
        status: r.status,
        network: r.network,
        asset: r.asset,
        pay_to: r.pay_to,
        spent_units: r.spent_units,
      }));
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

    await t.test("旗 ON: Arc の accept（payTo は先頭と別・カタログが宣言）で買われ、行は eip155:5042・Arc USDC・pay_to 0xb98e…・別枠 arc・残高 arc", async () => {
      await seed();
      process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
      const w = wall(CATALOG_ACCEPTS);
      const chains: string[] = [];
      const summary = await run(w, chains);
      assert.equal(summary.laneFloor.arc, 1, "レーン枠に載る");
      const paid = w.paid();
      assert.equal(paid.length, 1);
      assert.equal(paid[0]?.network, ARC_CAIP2);
      assert.equal(paid[0]?.payTo, CIRCLE_PAYTO, "署名の宛先は壁の原文（カタログの Arc の宣言と一致）");
      assert.equal((paid[0]?.extra as Record<string, unknown>)?.acceptId, "arc-usdc-circle", "Gateway ではなく eip3009");
      assert.deepEqual(await rows(), [
        { status: "settle_claimed", network: ARC_CAIP2, asset: ARC_USDC, pay_to: CIRCLE_PAYTO.toLowerCase(), spent_units: "7000" },
      ]);
      assert.equal(await arcSpentToday(), 7000, "別枠 arc に載る");
      assert.ok(chains.includes("arc"), "残高は arc として読む");
      assert.ok(!chains.includes("base"), "Base の残高は読まない（Base では買っていない）");
    });

    await t.test("壁が Arc の accept にカタログに無い payTo を出したら Arc では買わず、Base の legacy で買う", async () => {
      await seed();
      process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
      const w = wall(exaAccepts(ROGUE_PAYTO));
      const summary = await run(w);
      assert.equal(summary.laneFloor.arc, 1, "枠には載る（カタログは Arc を宣言している）");
      const paid = w.paid();
      assert.equal(paid.length, 1);
      assert.equal(paid[0]?.network, BASE_CAIP2);
      assert.equal(paid[0]?.payTo, LEGACY_PAYTO);
      assert.deepEqual(await rows(), [
        { status: "settle_claimed", network: BASE_CAIP2, asset: BASE_USDC, pay_to: LEGACY_PAYTO.toLowerCase(), spent_units: "7000" },
      ]);
      assert.equal(await arcSpentToday(), 0);
    });

    await t.test("自己取引の関門は選んだ accept の payTo に掛かる: Arc の payTo が運用者のものなら払わない", async () => {
      await seed();
      process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
      // 候補 SQL の自己除外は先頭 pay_to（legacy）しか見ない。Arc の payTo を運用者として登録する。
      process.env.VET402_OPERATOR_PAYTO = CIRCLE_PAYTO;
      try {
        const w = wall(CATALOG_ACCEPTS);
        await run(w);
        assert.equal(w.paid().length, 0, "署名しない");
        const r = await rows();
        assert.equal(r.length, 1);
        assert.equal(r[0].status, "payto_operator_self");
        assert.equal(r[0].network, ARC_CAIP2);
        assert.equal(r[0].pay_to, CIRCLE_PAYTO.toLowerCase());
        assert.equal(await arcSpentToday(), 0);
      } finally {
        delete process.env.VET402_OPERATOR_PAYTO;
      }
    });

    await t.test("旗 OFF: 従来どおり Base の legacy で買われ、Arc の行は 0", async () => {
      await seed();
      delete process.env.OBSERVATORY_ARC_L1_ENABLED;
      const w = wall(CATALOG_ACCEPTS);
      const summary = await run(w);
      assert.equal(summary.laneFloor.arc ?? 0, 0);
      const paid = w.paid();
      assert.equal(paid.length, 1);
      assert.equal(paid[0]?.network, BASE_CAIP2);
      assert.equal(paid[0]?.payTo, LEGACY_PAYTO);
      assert.equal(await arcSpentToday(), 0);
    });
  });
}
