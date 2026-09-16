// ============================================================
// L1 の Solana 別枠 — 予約と候補選び（2026-09-15・グラント戦略の発注②の前提）。
//
// 守ること:
//  1. その UTC 日の Solana の支出が別枠（既定 $2）に達したら、Solana の候補には
//     1 リクエストも出さない。Base の候補はそのまま買える（Base の定期購入を押し出さない）。
//  2. 別枠の残りが 1 件分に足りないときは、予約で断り、**台帳に行を書かない**。
//     行を書くと、その売り手はスイープ窓（6 日）のあいだ再選択されず、掃引が終わらない。
//  3. 支払い付きのリクエスト（PAYMENT-SIGNATURE）は Solana の売り手へ一度も出ない。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-solana-daily-cap.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

// 2026-09-17 Issue #29: runL1Batch は署名の前に購入元の USDC 残高を読む（既定は RPC）。
// このファイルは残高の関門の検査ではないので、十分な残高を返す読み手を渡す。
const FUNDED_PAYER = async () => 1_000_000_000n;
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 solana daily cap (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const payToFor = (n: string | number) => `0x${String(n).repeat(40).slice(0, 40)}`;
  const SOL_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const FEE_PAYER = "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd";
  const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";

  test("L1 Solana daily cap", async (t) => {
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
      cap: process.env.L1_SOLANA_DAILY_CAP_USD,
    };
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    t.after(() => {
      restore("OBSERVATORY_L1_ENABLED", saved.l1);
      restore("OBSERVATORY_WALLET_PRIVATE_KEY", saved.pk);
      restore("OBSERVATORY_SOLANA_L1_ENABLED", saved.solOn);
      restore("OBSERVATORY_SOLANA_SECRET_KEY", saved.solKey);
      restore("L1_SOLANA_DAILY_CAP_USD", saved.cap);
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    process.env.OBSERVATORY_SOLANA_L1_ENABLED = "true";
    process.env.OBSERVATORY_SOLANA_SECRET_KEY = Buffer.from(solKeypair.secretKey).toString("base64");
    delete process.env.L1_SOLANA_DAILY_CAP_USD; // 既定 $2

    const baseItem = (n: number) =>
      parseCatalogItem({
        resource: `https://seller${n}.example/api`,
        accepts: [{ amount: "3000", asset: BASE_USDC, network: "eip155:8453", payTo: payToFor(n) }],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        quality: { l30DaysTotalCalls: 100, l30DaysUniquePayers: 10 },
      });
    const solItem = (n: number) =>
      parseCatalogItem({
        resource: `https://solseller${n}.example/api`,
        accepts: [{ amount: "4000", asset: SOL_USDC, network: SOL_CAIP2, payTo: solPayTo(n) }],
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
    const solChallenge = (url: string) => {
      const n = Number(/solseller(\d)/.exec(url)?.[1] ?? "1");
      return JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: "exact", network: SOL_CAIP2, amount: "4000", asset: SOL_USDC, payTo: solPayTo(n), maxTimeoutSeconds: 60, extra: { feePayer: FEE_PAYER } }],
      });
    };
    const challengeFor = (url: string) => (url.includes("solseller") ? solChallenge(url) : baseChallenge(url));

    /** 402 → 支払い付きリトライは 200。どの URL に支払い付きで来たかを記録する。 */
    const wall = () => {
      const seen: { url: string; paid: boolean }[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
        seen.push({ url, paid });
        if (!paid) return new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } });
        const isSol = url.includes("solseller");
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify(
                isSol
                  ? { success: true, transaction: "5SoLSigBase58abcdefghijkmnopqrstuvwxyzabcdefghijkmnopqrstuvwxyzabcdefghijkmnopqrstuvwxyz", network: SOL_CAIP2, payer: FEE_PAYER }
                  : { success: true, transaction: `0x${"ab".repeat(32)}`, network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" },
              ),
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
        fetchResult: { items: [baseItem(1), solItem(1), solItem(2), solItem(3)], totalCount: 4, fetchedCount: 4, complete: true },
        today: "2026-09-17",
      });
      await runL0ProbeBatch({
        limit: 10,
        concurrency: 2,
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

    const ledgerFor = async (resourceUrl: string) => {
      const raw = await db.execute(sql`
        SELECT pu.status FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE e.resource_url = ${resourceUrl}`);
      return ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { status: string }[]).map((r) => r.status);
    };

    await t.test("別枠を使い切った日は Solana に 1 リクエストも出さず、Base は買う", async () => {
      await seed();
      await spendSolanaToday(2_000_000); // $2 ちょうど
      const w = wall();
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 10, getSolanaBlockhash: async () => BLOCKHASH, fetchImpl: w.fetchImpl });
      assert.ok(
        w.seen.every((s) => !s.url.includes("solseller1") && !s.url.includes("solseller2")),
        "Solana の候補には触れない",
      );
      assert.ok(w.seen.some((s) => s.url.includes("seller1.example") && s.paid), "Base の候補は支払い付きで買う");
      assert.ok(summary.settled >= 1);
      assert.deepEqual(await ledgerFor("https://solseller1.example/api"), [], "Solana の売り手に行を書かない");
      assert.deepEqual(await ledgerFor("https://solseller2.example/api"), []);
    });

    await t.test("別枠の残りが 1 件分に足りない: 予約で断り、行を書かず、支払い付きで出さない", async () => {
      await seed();
      await spendSolanaToday(2_000_000 - 1000); // 残り 1000 units < 1 件 4000 units
      const w = wall();
      await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 10, getSolanaBlockhash: async () => BLOCKHASH, fetchImpl: w.fetchImpl });
      assert.ok(!w.seen.some((s) => s.url.includes("solseller") && s.paid), "Solana へ支払い付きのリクエストは出ない");
      assert.deepEqual(await ledgerFor("https://solseller1.example/api"), [], "行が無い＝翌日また選ばれる");
      assert.deepEqual(await ledgerFor("https://solseller2.example/api"), []);
      assert.ok(w.seen.some((s) => s.url.includes("seller1.example") && s.paid), "Base は買う");
    });

    await t.test("別枠の内側なら Solana も買う（別枠は止めるためだけの仕組みではない）", async () => {
      await seed();
      const w = wall();
      await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 10, getSolanaBlockhash: async () => BLOCKHASH, fetchImpl: w.fetchImpl });
      assert.ok(w.seen.some((s) => s.url.includes("solseller") && s.paid), "Solana の候補を支払い付きで買う");
      const spent = await db.execute(sql`
        SELECT coalesce(sum(spent_units::numeric), 0)::text AS s FROM x402_l1_purchases WHERE network LIKE 'solana:%'`);
      const s = ((Array.isArray(spent) ? spent : (spent as { rows?: unknown[] }).rows ?? []) as { s: string }[])[0].s;
      assert.ok(Number(s) <= 2_000_000, `Solana の当日支出は別枠以内 (${s})`);
    });
  });
}
