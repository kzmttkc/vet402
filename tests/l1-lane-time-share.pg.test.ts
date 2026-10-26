// ============================================================
// L1 のレーン枠の時間の上限（L1_LANE_TIME_SHARE・2026-10-27）— 購入の挙動。
//
// 本番の実測（2026-10-27・読み取り）: 並びは「レーン枠 → 優先ホスト → retest/census → Base の主候補」。
// レーン枠の合計が 27 件から 45 件に増え、遅いレーン（Stellar 10〜12 秒/件、BNB・XRPL・Avalanche
// ~12 秒/件）が先頭で持ち時間 210 秒を使い切った。Base の試行は 1 日 170〜250 件から 10/26 は 55 件、
// 10/26 02:00 と 17:30 UTC の実行では 0 件。
//
// 守ること:
//  1. 使った時間が持ち時間 × L1_LANE_TIME_SHARE（既定 0.5）を超えたら、レーン候補（laneChain !== null）は
//     402 も取りに行かずに飛ばす（行も書かない）。Base の主候補は買われる。並びは変えない。
//  2. 上限より前なら、レーン候補は今までどおり買われる。
//  3. env が不正なら既定 0.5。
//  4. 主ネットワークがそのチェーンの主候補（laneChain が null）は対象外。
//  5. summary に laneSkippedForTime・setupMs・attemptsByNetwork が出る。
//
// 時計は runL1Batch の now（Test seam）で差し替える。デッドライン（maxDuration の判定）は壁時計のまま。
//
// Run: TEST_DATABASE_URL=postgres:///vet402_test_lane \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-lane-time-share.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const FUNDED_PAYER = async () => 1_000_000_000n;
const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 lane time share (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const payToFor = (n: string | number) => `0x${String(n).padStart(2, "0").repeat(20)}`;
  const BASE_CAIP2 = "eip155:8453";
  const SOL_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const FEE_PAYER = "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd";
  const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
  const BASE_COUNT = 30;
  const SOL_COUNT = 3;
  const BUDGET_MS = 210_000; // L1_BATCH_BUDGET_MS の既定（runL1Batch に batchBudgetMs を渡さない）
  const START = 1_000_000;

  test("L1 lane time share", async (t) => {
    const { Keypair } = await import("@solana/web3.js");
    const { runL1Batch, L1_BATCH_BUDGET_MS } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");

    assert.equal(L1_BATCH_BUDGET_MS, BUDGET_MS, "上限の計算はこの持ち時間が前提");
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
      share: process.env.L1_LANE_TIME_SHARE,
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
      restore("L1_LANE_TIME_SHARE", saved.share);
    });
    const armSolana = () => {
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      process.env.OBSERVATORY_SOLANA_L1_ENABLED = "true";
      process.env.OBSERVATORY_SOLANA_SECRET_KEY = Buffer.from(solKeypair.secretKey).toString("base64");
      delete process.env.OBSERVATORY_ARC_L1_ENABLED;
      delete process.env.L1_SOLANA_DAILY_CAP_USD; // 既定 $2
      delete process.env.L1_LANE_FLOOR_PER_RUN; // 既定 5
      delete process.env.L1_LANE_TIME_SHARE; // 既定 0.5
    };

    const baseItem = (n: number) =>
      parseCatalogItem({
        resource: `https://seller${n}.example/api`,
        accepts: [{ amount: "3000", asset: BASE_USDC, network: BASE_CAIP2, payTo: payToFor(n) }],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        quality: { l30DaysTotalCalls: 5000 + n, l30DaysUniquePayers: 500 + n },
      });
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
        accepts: [{ scheme: "exact", network: BASE_CAIP2, amount: "3000", asset: BASE_USDC, payTo: payToFor(sellerNo(url)), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
      });
    const solChallenge = (url: string) =>
      JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: "exact", network: SOL_CAIP2, amount: "4000", asset: SOL_USDC, payTo: solPayTo(sellerNo(url)), maxTimeoutSeconds: 60, extra: { feePayer: FEE_PAYER } }],
      });
    const isSol = (url: string) => url.includes("solseller");
    const challengeFor = (url: string) => (isSol(url) ? solChallenge(url) : baseChallenge(url));
    const solTxFor = (n: number) => `5SoLSig${"abcdefghjkmnpqrstuvwxyz"[n % 23].repeat(4)}${"ABCDEFGHJKLMNPQRSTUVWXYZ".repeat(4)}`.slice(0, 88);
    const baseTxFor = (n: number) => `0x${`a${n.toString(16).padStart(3, "0")}`.repeat(16)}`;

    /**
     * 402 → 支払い付きリトライは 200。支払い付きの 1 本ごとに、差し替えた時計を stepMs 進める
     * （遅いレーンの 1 件が持ち時間を食う様子を模す）。
     */
    const wall = (clock: { ms: number }, stepMs: number) => {
      const seen: { url: string; paid: boolean }[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
        seen.push({ url, paid });
        if (!paid) return new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } });
        clock.ms += stepMs;
        const n = sellerNo(url);
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify(
                isSol(url)
                  ? { success: true, transaction: solTxFor(n), network: SOL_CAIP2, payer: FEE_PAYER }
                  : { success: true, transaction: baseTxFor(n), network: BASE_CAIP2, payer: "0x0000000000000000000000000000000000000001" },
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
        today: "2026-10-27",
      });
      await runL0ProbeBatch({
        limit: 100,
        concurrency: 4,
        fetchImpl: async (url: string) => new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } }),
      });
    }

    const rowsByNetwork = async () => {
      const raw = await db.execute(sql`SELECT network, count(*)::int AS n FROM x402_l1_purchases GROUP BY network`);
      const list = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { network: string | null; n: number }[];
      return Object.fromEntries(list.map((r) => [r.network ?? "null", Number(r.n)]));
    };
    const run = (w: ReturnType<typeof wall>, clock: { ms: number }) =>
      runL1Batch({
        getPayerUsdcBalance: FUNDED_PAYER,
        limit: 10,
        getSolanaBlockhash: async () => BLOCKHASH,
        fetchImpl: w.fetchImpl,
        now: () => clock.ms,
      });

    await t.test("上限より前: レーン候補は今までどおり買われる（Solana 3 件が先頭・Base 10 件）", async () => {
      armSolana();
      await seed();
      const clock = { ms: START };
      const w = wall(clock, 0); // 時計は止まったまま
      const summary = await run(w, clock);
      const paid = w.paidUrls();
      assert.deepEqual(paid.slice(0, SOL_COUNT).map(isSol), [true, true, true], "先頭 3 件は Solana のまま（並びは変えない）");
      assert.equal(paid.filter(isSol).length, SOL_COUNT);
      assert.equal(paid.filter((u) => !isSol(u)).length, 10);
      assert.equal(summary.laneSkippedForTime, 0);
      assert.equal(summary.attempted, 13);
      assert.equal(summary.setupMs, 0, "差し替えた時計が止まっていれば準備は 0 ms");
      // 準備の内訳（2026-10-27）: 主候補の取得とレーンごとの取得。時計が止まっていれば 0。問い合わせたレーンだけ載る。
      assert.equal(summary.primaryFetchMs, 0);
      assert.equal(summary.laneFetchMs.solana, 0);
      assert.ok(Object.values(summary.laneFetchMs).every((v) => v === 0));
      assert.deepEqual(summary.attemptsByNetwork, { [SOL_CAIP2]: 3, [BASE_CAIP2]: 10 });
      assert.deepEqual(await rowsByNetwork(), { [SOL_CAIP2]: 3, [BASE_CAIP2]: 10 });
    });

    await t.test("使った時間が上限（210 秒 × 0.5 = 105 秒）を超えたら、残りのレーン候補は飛ばし、Base の主候補は買う", async () => {
      armSolana();
      await seed();
      const clock = { ms: START };
      // 支払い付き 1 本ごとに 60 秒。Solana の 1 件目は 0 秒、2 件目は 60 秒で始まり（上限前）、3 件目は 120 秒（上限超）。
      const w = wall(clock, 60_000);
      const summary = await run(w, clock);
      const solSeen = w.seen.filter((s) => isSol(s.url));
      assert.equal(new Set(solSeen.map((s) => s.url)).size, 2, "3 件目の Solana には 402 も取りに行かない");
      assert.equal(w.paidUrls().filter(isSol).length, 2);
      assert.equal(w.paidUrls().filter((u) => !isSol(u)).length, 10, "Base の主候補は時間の上限の対象外で、10 件とも買う");
      assert.equal(summary.laneSkippedForTime, 1);
      assert.equal(summary.attempted, 12);
      assert.deepEqual(summary.attemptsByNetwork, { [SOL_CAIP2]: 2, [BASE_CAIP2]: 10 });
      assert.deepEqual(await rowsByNetwork(), { [SOL_CAIP2]: 2, [BASE_CAIP2]: 10 }, "飛ばした候補の行は書かない");
      assert.equal(summary.stoppedForDeadline, false, "デッドラインは壁時計のまま（差し替えた時計では止まらない）");
    });

    await t.test("準備だけで上限を超えた実行: レーン候補は 1 件も買わず、Base は買う・setupMs は準備の時間", async () => {
      armSolana();
      await seed();
      let calls = 0;
      // 1 回目（実行の開始）だけ START、以後は 106 秒後。
      const clock = {
        get ms() {
          calls++;
          return calls === 1 ? START : START + 106_000;
        },
        set ms(_v: number) {},
      };
      const w = wall(clock, 0);
      const summary = await run(w, clock);
      assert.ok(w.seen.every((s) => !isSol(s.url)), "Solana の候補には触れない");
      assert.equal(w.paidUrls().length, 10, "Base は 10 件買う");
      assert.equal(summary.laneSkippedForTime, SOL_COUNT);
      assert.equal(summary.laneFloor.solana, SOL_COUNT, "レーン枠の候補は並びに入ったまま（時間で飛ばしただけ）");
      assert.equal(summary.setupMs, 106_000);
      assert.equal(summary.primaryFetchMs, 0, "開始の後の時計は止まっている（主候補の取得の前後は同じ時刻）");
      assert.deepEqual(summary.attemptsByNetwork, { [BASE_CAIP2]: 10 });
      assert.deepEqual(await rowsByNetwork(), { [BASE_CAIP2]: 10 });
    });

    await t.test("env が不正なら既定 0.5、正しい値ならその割合", async () => {
      armSolana();
      process.env.L1_LANE_TIME_SHARE = "abc";
      await seed();
      let clock = { ms: START };
      let w = wall(clock, 60_000);
      let summary = await run(w, clock);
      assert.equal(summary.laneSkippedForTime, 1, "不正な値は既定 0.5 = 105 秒（3 件目の 120 秒で飛ばす）");
      assert.equal(w.paidUrls().filter(isSol).length, 2);

      process.env.L1_LANE_TIME_SHARE = "1.5";
      await seed();
      clock = { ms: START };
      w = wall(clock, 60_000);
      summary = await run(w, clock);
      assert.equal(summary.laneSkippedForTime, 1, "範囲外の 1.5 も既定 0.5");

      // 0.9 = 189 秒。3 件目は 120 秒で始まるので買われる。
      process.env.L1_LANE_TIME_SHARE = "0.9";
      await seed();
      clock = { ms: START };
      w = wall(clock, 60_000);
      summary = await run(w, clock);
      assert.equal(summary.laneSkippedForTime, 0);
      assert.equal(w.paidUrls().filter(isSol).length, SOL_COUNT);
      assert.equal(w.paidUrls().filter((u) => !isSol(u)).length, 10);
    });

    await t.test("主ネットワークが Solana の主候補（laneChain が null）は上限の対象外", async () => {
      armSolana();
      process.env.L1_LANE_FLOOR_PER_RUN = "0"; // レーン枠なし: 需要の高い Solana は主候補として並ぶ
      await seed("high");
      const clock = { ms: START + 0 };
      const w = wall(clock, 120_000); // 1 件目の後でもう上限超
      const summary = await run(w, clock);
      assert.equal(w.paidUrls().filter(isSol).length, SOL_COUNT, "主候補の Solana は時間で飛ばさない");
      assert.equal(summary.laneSkippedForTime, 0);
      assert.equal(summary.attempted, 10);
    });

    await t.test("summary に新しい欄が出る（実時計の既定経路）", async () => {
      armSolana();
      await seed();
      const w = wall({ ms: 0 }, 0);
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 10, getSolanaBlockhash: async () => BLOCKHASH, fetchImpl: w.fetchImpl });
      assert.equal(typeof summary.laneSkippedForTime, "number");
      assert.equal(summary.laneSkippedForTime, 0);
      assert.equal(typeof summary.setupMs, "number");
      assert.ok(summary.setupMs !== null && summary.setupMs >= 0 && summary.setupMs < BUDGET_MS);
      assert.deepEqual(summary.attemptsByNetwork, { [SOL_CAIP2]: 3, [BASE_CAIP2]: 10 });
      const sum = Object.values(summary.attemptsByNetwork).reduce((a, b) => a + b, 0);
      assert.equal(sum, summary.attempted, "ネットワーク別の合計は attempted と一致する");
    });

    await t.test("旗 off で候補ループに入らない実行は setupMs が null・他の新しい欄は 0 / 空", async () => {
      armSolana();
      delete process.env.OBSERVATORY_L1_ENABLED;
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER });
      assert.equal(summary.disabledReason, "l1_disabled");
      assert.equal(summary.setupMs, null);
      assert.equal(summary.laneSkippedForTime, 0);
      assert.deepEqual(summary.attemptsByNetwork, {});
    });
  });
}
