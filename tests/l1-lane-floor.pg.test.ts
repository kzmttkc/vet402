// ============================================================
// L1 のチェーンごとの候補の最低枠（per-lane floor・2026-09-17）— 並びと購入。
//
// 本番の実測（2026-09-17）: 候補 SQL は需要順で 1 回 LIMIT 100、cron が 1 回に処理できるのは
// 20〜30 件。Solana は候補 204（未購入 192）あっても EVM の未購入 7,898 件に負け、$2 の別枠を
// 一度も使い切れずに 1 件/日（9/17 は 0 件）。Arc も同じ。
//
// 守ること:
//  1. 別枠を持つレーン（Solana・Arc）の候補は、需要が低くても LIMIT laneFloorPerRun() 件が
//     主候補の**先頭**に置かれ、支払い付きのリクエストになる。Base はそのまま続けて買われる。
//  2. レーンの旗が off の日は、そのレーンの候補は入らない（行も書かない・従来どおり除外）。
//  3. 別枠を使い切った日も入らない（従来どおり除外）。
//  4. 主候補の LIMIT は減らない——Base の候補は毎回 20 件以上残る（9/25 21:00 JST の Tokyo の
//     デモは Base の購入が決済されることに乗っている）。
//  5. 主候補にも入るレーン候補は id で重複排除（同じ売り手を 1 回のバッチで 2 度買わない）。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-lane-floor.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const FUNDED_PAYER = async () => 1_000_000_000n;
const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 lane floor (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const payToFor = (n: string | number) => `0x${String(n).padStart(2, "0").repeat(20)}`;
  const SOL_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const FEE_PAYER = "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd";
  const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
  const BASE_COUNT = 30;
  const SOL_COUNT = 3;

  test("L1 lane floor", async (t) => {
    const { Keypair } = await import("@solana/web3.js");
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");

    const db = getDb()!;
    const solPayTo = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(40 + n)).publicKey.toBase58();
    const solKeypair = Keypair.fromSeed(new Uint8Array(32).fill(9));

    const saved = {
      l1: process.env.OBSERVATORY_L1_ENABLED,
      pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY,
      solOn: process.env.OBSERVATORY_SOLANA_L1_ENABLED,
      solKey: process.env.OBSERVATORY_SOLANA_SECRET_KEY,
      arcOn: process.env.OBSERVATORY_ARC_L1_ENABLED,
      cap: process.env.L1_SOLANA_DAILY_CAP_USD,
      floor: process.env.L1_LANE_FLOOR_PER_RUN,
    };
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    t.after(() => {
      restore("OBSERVATORY_L1_ENABLED", saved.l1);
      restore("OBSERVATORY_WALLET_PRIVATE_KEY", saved.pk);
      restore("OBSERVATORY_SOLANA_L1_ENABLED", saved.solOn);
      restore("OBSERVATORY_SOLANA_SECRET_KEY", saved.solKey);
      restore("OBSERVATORY_ARC_L1_ENABLED", saved.arcOn);
      restore("L1_SOLANA_DAILY_CAP_USD", saved.cap);
      restore("L1_LANE_FLOOR_PER_RUN", saved.floor);
    });
    const armSolana = () => {
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      process.env.OBSERVATORY_SOLANA_L1_ENABLED = "true";
      process.env.OBSERVATORY_SOLANA_SECRET_KEY = Buffer.from(solKeypair.secretKey).toString("base64");
      delete process.env.OBSERVATORY_ARC_L1_ENABLED;
      delete process.env.L1_SOLANA_DAILY_CAP_USD; // 既定 $2
      delete process.env.L1_LANE_FLOOR_PER_RUN; // 既定 5
    };

    /** 需要の高い Base（本番の EVM 未購入 7,898 件の側）。 */
    const baseItem = (n: number) =>
      parseCatalogItem({
        resource: `https://seller${n}.example/api`,
        accepts: [{ amount: "3000", asset: BASE_USDC, network: "eip155:8453", payTo: payToFor(n) }],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        quality: { l30DaysTotalCalls: 5000 + n, l30DaysUniquePayers: 500 + n },
      });
    /** 需要の低い Solana（需要順では Base 30 件の後ろ＝LIMIT 10 の主候補には入らない）。 */
    const solItem = (n: number, demand: "low" | "high" = "low") =>
      parseCatalogItem({
        resource: `https://solseller${n}.example/api`,
        accepts: [{ amount: "4000", asset: SOL_USDC, network: SOL_CAIP2, payTo: solPayTo(n) }],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        quality: demand === "low" ? { l30DaysTotalCalls: 10, l30DaysUniquePayers: 1 } : { l30DaysTotalCalls: 90_000, l30DaysUniquePayers: 9_000 },
      });
    const sellerNo = (url: string) => Number(/seller(\d+)\.example/.exec(url)?.[1] ?? "0");
    const baseChallenge = (url: string) =>
      JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: "exact", network: "eip155:8453", amount: "3000", asset: BASE_USDC, payTo: payToFor(sellerNo(url)), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
      });
    const solChallenge = (url: string) =>
      JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: "exact", network: SOL_CAIP2, amount: "4000", asset: SOL_USDC, payTo: solPayTo(sellerNo(url)), maxTimeoutSeconds: 60, extra: { feePayer: FEE_PAYER } }],
      });
    const isSol = (url: string) => url.includes("solseller");
    const challengeFor = (url: string) => (isSol(url) ? solChallenge(url) : baseChallenge(url));
    // base58 の英数字だけで、売り手ごとに一意な署名（台帳の UNIQUE (network, lower(tx_hash)) に当たらないため）。
    const solTxFor = (n: number) => `5SoLSig${"abcdefghjkmnpqrstuvwxyz"[n % 23].repeat(4)}${"ABCDEFGHJKLMNPQRSTUVWXYZ".repeat(4)}`.slice(0, 88);
    const baseTxFor = (n: number) => `0x${`a${n.toString(16).padStart(3, "0")}`.repeat(16)}`;

    /** 402 → 支払い付きリトライは 200。どの URL に支払い付きで来たか（順序つき）を記録する。 */
    const wall = () => {
      const seen: { url: string; paid: boolean }[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
        seen.push({ url, paid });
        if (!paid) return new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } });
        const n = sellerNo(url);
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify(
                isSol(url)
                  ? { success: true, transaction: solTxFor(n), network: SOL_CAIP2, payer: FEE_PAYER }
                  : { success: true, transaction: baseTxFor(n), network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" },
              ),
            ).toString("base64"),
          },
        });
      };
      const paidUrls = () => seen.filter((s) => s.paid).map((s) => s.url);
      return { seen, fetchImpl, paidUrls };
    };

    async function seed(solDemand: "low" | "high" = "low") {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      const items = [
        ...Array.from({ length: BASE_COUNT }, (_, i) => baseItem(i + 1)),
        ...Array.from({ length: SOL_COUNT }, (_, i) => solItem(i + 1, solDemand)),
      ];
      await syncCatalog({
        fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true },
        today: "2026-09-17",
      });
      await runL0ProbeBatch({
        limit: 100,
        concurrency: 4,
        fetchImpl: async (url: string) => new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } }),
      });
    }

    /** その UTC 日の Solana 支出を、solseller3 の既存行として台帳に置く。 */
    async function spendSolanaToday(units: number) {
      const rows = await db.execute(sql`SELECT id FROM x402_endpoints WHERE resource_url = 'https://solseller3.example/api'`);
      const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as { id: string }[];
      await db.insert(schema.x402L1Purchases).values({
        endpointId: list[0].id,
        status: "settle_claimed",
        payer: solKeypair.publicKey.toBase58(),
        network: SOL_CAIP2,
        asset: SOL_USDC,
        payTo: solPayTo(3),
        amountUnits: String(units),
        spentUnits: String(units),
      });
    }

    const solanaRows = async () => {
      const raw = await db.execute(sql`SELECT count(*)::text AS n FROM x402_l1_purchases WHERE network LIKE 'solana:%'`);
      return Number(((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { n: string }[])[0].n);
    };

    await t.test("需要の低い Solana 3 件が先頭で支払い付きになり、Base も続けて買われる（limit 10）", async () => {
      armSolana();
      await seed();
      const w = wall();
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 10, getSolanaBlockhash: async () => BLOCKHASH, fetchImpl: w.fetchImpl });
      const paid = w.paidUrls();
      assert.deepEqual(
        paid.slice(0, SOL_COUNT).map(isSol),
        [true, true, true],
        `先頭 3 件の支払い付きリクエストは Solana: ${paid.slice(0, 4).join(", ")}`,
      );
      assert.equal(paid.filter(isSol).length, SOL_COUNT, "Solana は 3 件ちょうど（重複しない）");
      assert.equal(paid.filter((u) => !isSol(u)).length, 10, "主候補の LIMIT 10 は減らない（Base 10 件）");
      assert.equal(summary.attempted, 13);
      // Tempo レーン（2026-09-17・MPP）と XRPL レーン（feat/xrpl-lane）は旗 off なので 0（レーンの表に居るぶん、鍵だけは出る）。
      assert.deepEqual(summary.laneFloor, { solana: 3, arc: 0, tempo: 0, xrpl: 0 });
      assert.equal(await solanaRows(), SOL_COUNT);
    });

    await t.test("Solana の旗が off の日: Solana は 0 件・行 0・laneFloor は 0", async () => {
      armSolana();
      delete process.env.OBSERVATORY_SOLANA_L1_ENABLED;
      await seed();
      const w = wall();
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 10, getSolanaBlockhash: async () => BLOCKHASH, fetchImpl: w.fetchImpl });
      assert.ok(w.seen.every((s) => !isSol(s.url)), "Solana の候補には触れない");
      assert.equal(summary.laneFloor.solana, 0);
      assert.equal(await solanaRows(), 0);
      assert.equal(w.paidUrls().length, 10, "Base は従来どおり買う");
    });

    await t.test("別枠を使い切った日: レーン候補は入らない（従来どおり除外）・Base は買う", async () => {
      armSolana();
      await seed();
      await spendSolanaToday(2_000_000); // $2 ちょうど
      const w = wall();
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 10, getSolanaBlockhash: async () => BLOCKHASH, fetchImpl: w.fetchImpl });
      assert.ok(w.seen.every((s) => !isSol(s.url)), "Solana の候補には触れない");
      assert.equal(summary.laneFloor.solana, 0);
      assert.equal(await solanaRows(), 1, "置いた既存行だけ（新しい行を書かない）");
      assert.equal(w.paidUrls().length, 10, "Base は従来どおり買う");
    });

    await t.test("Base の候補は 20 件以上残る（limit 25 で Base が 25 件処理され、Solana 3 件は追加）", async () => {
      armSolana();
      await seed();
      const w = wall();
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 25, getSolanaBlockhash: async () => BLOCKHASH, fetchImpl: w.fetchImpl });
      const paid = w.paidUrls();
      assert.ok(paid.filter((u) => !isSol(u)).length >= 20, `Base の支払い付きは 20 件以上 (${paid.filter((u) => !isSol(u)).length})`);
      assert.equal(paid.filter((u) => !isSol(u)).length, 25);
      assert.equal(paid.filter(isSol).length, SOL_COUNT);
      assert.equal(summary.attempted, 28);
      assert.equal(summary.stoppedForDeadline, false);
    });

    await t.test("主候補にも入るレーン候補は id で重複排除（需要の高い Solana を 2 度買わない）", async () => {
      armSolana();
      await seed("high");
      const w = wall();
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 10, getSolanaBlockhash: async () => BLOCKHASH, fetchImpl: w.fetchImpl });
      const paid = w.paidUrls();
      assert.deepEqual(paid.slice(0, SOL_COUNT).map(isSol), [true, true, true]);
      assert.equal(paid.filter(isSol).length, SOL_COUNT, "Solana は 3 件ちょうど");
      assert.equal(new Set(paid).size, paid.length, "同じ売り手に 2 度支払わない");
      assert.equal(summary.laneFloor.solana, SOL_COUNT);
      assert.equal(summary.attempted, 10, "主候補 10 件のうち 3 件が Solana と重なるので合計は 10");
    });

    await t.test("L1_LANE_FLOOR_PER_RUN=1 なら先頭は 1 件、0 なら枠なし（従来の並び）", async () => {
      armSolana();
      process.env.L1_LANE_FLOOR_PER_RUN = "1";
      await seed();
      let w = wall();
      let summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 10, getSolanaBlockhash: async () => BLOCKHASH, fetchImpl: w.fetchImpl });
      assert.equal(w.paidUrls().filter(isSol).length, 1);
      assert.ok(isSol(w.paidUrls()[0]));
      assert.equal(summary.laneFloor.solana, 1);

      process.env.L1_LANE_FLOOR_PER_RUN = "0";
      await seed();
      w = wall();
      summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 10, getSolanaBlockhash: async () => BLOCKHASH, fetchImpl: w.fetchImpl });
      assert.equal(w.paidUrls().filter(isSol).length, 0, "枠なし＝需要順で Base 10 件だけ");
      assert.equal(summary.laneFloor.solana, 0);
      assert.equal(summary.attempted, 10);
    });
  });
}
