// ============================================================
// L1 ランナー: POST の本文（B）と購入元残高の関門（C の再発防止）— Issue #29・2026-09-17。
//
// 守ること:
//  1. 無払いの 402 応答が extensions.bazaar.info.input.body を宣言していれば、支払い付き
//     POST の本文はその宣言そのもの。行の raw_response_meta.requestBody に "declared" を残す。
//     宣言が無ければ従来どおり `{}`（"empty"）。無払いの要求の本文は `{}` のまま。
//  2. 購入元の USDC 残高が今回の額に足りなければ**署名しない**（支払い付きリクエスト 0 本）。
//     台帳に行を書かない——その売り手は翌バッチでまた選ばれる。
//  3. 残高を読めなければ署名しない。RPC は 1 バッチでチェーンごとに 1 回。
//  4. Solana も同じ関門を通る（Base は買える）。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_prep_0917 \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-body-and-funds.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 body and funds (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const payToFor = (n: string | number) => `0x${String(n).repeat(40).slice(0, 40)}`;
  const SOL_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const FEE_PAYER = "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd";
  const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";

  test("L1 body and payer funds", async (t) => {
    const { Keypair } = await import("@solana/web3.js");
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const solPayTo = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(60 + n)).publicKey.toBase58();
    const solKeypair = Keypair.fromSeed(new Uint8Array(32).fill(11));

    const saved = {
      l1: process.env.OBSERVATORY_L1_ENABLED,
      pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY,
      solOn: process.env.OBSERVATORY_SOLANA_L1_ENABLED,
      solKey: process.env.OBSERVATORY_SOLANA_SECRET_KEY,
    };
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    t.after(() => {
      restore("OBSERVATORY_L1_ENABLED", saved.l1);
      restore("OBSERVATORY_WALLET_PRIVATE_KEY", saved.pk);
      restore("OBSERVATORY_SOLANA_L1_ENABLED", saved.solOn);
      restore("OBSERVATORY_SOLANA_SECRET_KEY", saved.solKey);
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;

    /** Douglas（api.insumermodel.com /v1/attest）と同じ形の宣言。 */
    const DECLARED = {
      wallet: "0x0000000000000000000000000000000000000001",
      conditions: [{ type: "token_balance", chainId: 8453, contractAddress: BASE_USDC, threshold: 1 }],
    };

    const baseItem = (n: number, method: "GET" | "POST") =>
      parseCatalogItem({
        resource: `https://seller${n}.example/api`,
        accepts: [{ amount: "3000", asset: BASE_USDC, network: "eip155:8453", payTo: payToFor(n) }],
        extensions: { bazaar: { info: { input: { method } } } },
        quality: { l30DaysTotalCalls: 100 * n, l30DaysUniquePayers: 10 },
      });
    const solItem = (n: number) =>
      parseCatalogItem({
        resource: `https://solseller${n}.example/api`,
        accepts: [{ amount: "4000", asset: SOL_USDC, network: SOL_CAIP2, payTo: solPayTo(n) }],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        quality: { l30DaysTotalCalls: 5000, l30DaysUniquePayers: 500 },
      });
    /** seller1 は POST・宣言あり（ヘッダ）、seller2 は POST・宣言なし、seller3 は GET。 */
    const challengeDoc = (url: string) => {
      if (url.includes("solseller")) {
        const n = Number(/solseller(\d)/.exec(url)?.[1] ?? "1");
        return {
          x402Version: 2,
          accepts: [{ scheme: "exact", network: SOL_CAIP2, amount: "4000", asset: SOL_USDC, payTo: solPayTo(n), maxTimeoutSeconds: 60, extra: { feePayer: FEE_PAYER } }],
        };
      }
      const n = /seller(\d)/.exec(url)?.[1] ?? "1";
      return {
        x402Version: 2,
        accepts: [{ scheme: "exact", network: "eip155:8453", amount: "3000", asset: BASE_USDC, payTo: payToFor(n), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
        ...(n === "1" ? { extensions: { bazaar: { info: { input: { type: "http", method: "POST", body: DECLARED } } } } } : {}),
      };
    };
    const wall402 = (url: string) =>
      new Response(JSON.stringify({ error: "payment required" }), {
        status: 402,
        headers: {
          "content-type": "application/json",
          "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challengeDoc(url))).toString("base64"),
        },
      });

    type Seen = { url: string; paid: boolean; method: string; body: string | null; crossOriginBody: string | null };
    const wall = () => {
      const seen: Seen[] = [];
      const fetchImpl = async (url: string, init?: RequestInit, call?: { crossOriginBody?: string }) => {
        const headers = new Headers(init?.headers);
        const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
        seen.push({
          url,
          paid,
          method: String(init?.method ?? "GET"),
          body: typeof init?.body === "string" ? init.body : null,
          crossOriginBody: call?.crossOriginBody ?? null,
        });
        if (!paid) return wall402(url);
        const isSol = url.includes("solseller");
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify(
                isSol
                  ? { success: true, transaction: "5SoLSigBase58abcdefghijkmnopqrstuvwxyzabcdefghijkmnopqrstuvwxyzabcdefghijkmnopqrstuvwxyz", network: SOL_CAIP2, payer: FEE_PAYER }
                  : { success: true, transaction: `0x${String(seen.length).padStart(64, "a")}`, network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" },
              ),
            ).toString("base64"),
          },
        });
      };
      return { seen, fetchImpl };
    };

    async function seed(items: ReturnType<typeof parseCatalogItem>[]) {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      await syncCatalog({ fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true }, today: "2026-09-17" });
      await runL0ProbeBatch({ limit: 10, concurrency: 2, fetchImpl: async (url: string) => wall402(url) });
    }
    const rowsFor = async (resourceUrl: string) => {
      const raw = await db.execute(sql`
        SELECT pu.status, pu.raw_response_meta->>'requestBody' AS request_body
        FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE e.resource_url = ${resourceUrl}`);
      return ((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { status: string; request_body: string | null }[]).map(
        (r) => ({ status: r.status, request_body: r.request_body }),
      );
    };
    const FUNDED = async () => 10_000_000n; // 10 USDC

    await t.test("B: 宣言ありの POST は支払い付き本文が宣言そのもの・宣言なしは {}・無払いは {}", async () => {
      await seed([baseItem(1, "POST"), baseItem(2, "POST"), baseItem(3, "GET")]);
      const w = wall();
      await runL1Batch({ limit: 10, fetchImpl: w.fetchImpl, getPayerUsdcBalance: FUNDED });
      const paid1 = w.seen.filter((s) => s.url.includes("seller1") && s.paid);
      const unpaid1 = w.seen.filter((s) => s.url.includes("seller1") && !s.paid);
      assert.equal(paid1.length, 1);
      assert.deepEqual(JSON.parse(paid1[0].body ?? "null"), DECLARED, "支払い付き POST の本文は宣言そのもの");
      assert.equal(unpaid1[0].body, "{}", "無払いの要求は宣言を読む前なので {}");
      assert.equal(paid1[0].crossOriginBody, "refuse", "宣言本文を運ぶ要求は別オリジンの転送に従わない");
      assert.equal(unpaid1[0].crossOriginBody, null, "{} の無払いの要求は従来どおり");
      const paid2 = w.seen.filter((s) => s.url.includes("seller2") && s.paid);
      assert.equal(paid2.length, 1);
      assert.equal(paid2[0].body, "{}", "宣言が無ければ従来どおり {}");
      assert.equal(paid2[0].crossOriginBody, null, "{} の支払い付き要求の転送は従来どおり");
      const paid3 = w.seen.filter((s) => s.url.includes("seller3") && s.paid);
      assert.equal(paid3[0].body, null, "GET に本文は付けない");
      assert.deepEqual(await rowsFor("https://seller1.example/api"), [{ status: "settle_claimed", request_body: "declared" }]);
      assert.deepEqual(await rowsFor("https://seller2.example/api"), [{ status: "settle_claimed", request_body: "empty" }]);
      // 2026-09-20: POST 以外にも "none" を残す（行はメソッドを持たないので、記録が無いと「本文なし」と
      // 「記録なし」を後から分けられない）。宣言本文の行には、送ったバイト列の SHA-256 が付く。
      assert.equal((await rowsFor("https://seller3.example/api"))[0].request_body, "none");
      const shaRaw = await db.execute(sql`
        SELECT e.resource_url, pu.raw_response_meta->>'requestBodySha256' AS sha
        FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id`);
      const shaBy = new Map(
        ((Array.isArray(shaRaw) ? shaRaw : ((shaRaw as { rows?: unknown[] }).rows ?? [])) as { resource_url: string; sha: string | null }[]).map(
          (r) => [r.resource_url, r.sha],
        ),
      );
      const { createHash } = await import("node:crypto");
      assert.equal(
        shaBy.get("https://seller1.example/api"),
        createHash("sha256").update(paid1[0].body ?? "", "utf8").digest("hex"),
        "hash は実際に送った本文のもの",
      );
      assert.equal(shaBy.get("https://seller2.example/api"), null, "{} の行に hash は付けない");
      assert.equal(shaBy.get("https://seller3.example/api"), null);
    });

    await t.test("残高不足: 署名 0・行を書かない・翌バッチ（補充後）にまた選ばれて買う", async () => {
      await seed([baseItem(1, "POST"), baseItem(2, "POST")]);
      const w = wall();
      let reads = 0;
      const summary = await runL1Batch({
        limit: 10,
        fetchImpl: w.fetchImpl,
        getPayerUsdcBalance: async () => {
          reads++;
          return 275n; // 2026-09-16 実測 0.000275 USDC
        },
      });
      assert.equal(w.seen.filter((s) => s.paid).length, 0, "支払い付きリクエスト（署名）は 0 本");
      assert.equal(reads, 1, "RPC はバッチで 1 回");
      assert.equal(summary.attempted, 0);
      assert.equal(summary.payerUnfunded, 2);
      assert.deepEqual(summary.payerFundsUnreadable, [], "残高不足は『読めない』ではない");
      assert.deepEqual(await rowsFor("https://seller1.example/api"), [], "台帳に行を書かない（settle_failed にしない）");
      assert.deepEqual(await rowsFor("https://seller2.example/api"), []);

      const w2 = wall();
      await runL1Batch({ limit: 10, fetchImpl: w2.fetchImpl, getPayerUsdcBalance: FUNDED });
      assert.ok(w2.seen.some((s) => s.url.includes("seller1") && s.paid), "補充後のバッチでまた選ばれて買う");
      assert.ok(w2.seen.some((s) => s.url.includes("seller2") && s.paid));
    });

    await t.test("残高はバッチ内の署名額を差し引いて比べる（1 件分しか無ければ 1 件だけ）", async () => {
      await seed([baseItem(1, "POST"), baseItem(2, "POST")]);
      const w = wall();
      const summary = await runL1Batch({ limit: 10, fetchImpl: w.fetchImpl, getPayerUsdcBalance: async () => 5000n });
      assert.equal(w.seen.filter((s) => s.paid).length, 1);
      assert.equal(summary.payerUnfunded, 1);
    });

    await t.test("残高を読めない: 署名 0・行を書かない", async () => {
      await seed([baseItem(1, "POST"), baseItem(2, "GET")]);
      const w = wall();
      let reads = 0;
      const summary = await runL1Batch({
        limit: 10,
        fetchImpl: w.fetchImpl,
        getPayerUsdcBalance: async () => {
          reads++;
          throw new Error("rpc 503");
        },
      });
      assert.equal(w.seen.filter((s) => s.paid).length, 0);
      assert.equal(reads, 1, "失敗もキャッシュする（候補ごとに RPC を叩かない）");
      assert.equal(summary.payerUnfunded, 2);
      // 2026-09-20: 「足りない」と「読めない」を summary で分ける。読めなかったチェーンは 1 回だけ名前で出る
      // （cron の応答は 200 のままなので、監視が拾える鍵はこれ）。
      assert.deepEqual(summary.payerFundsUnreadable, ["base"]);
      assert.deepEqual(await rowsFor("https://seller1.example/api"), []);
    });

    await t.test("Solana も同じ関門: Solana の残高不足で Solana に署名せず、Base は買う", async () => {
      process.env.OBSERVATORY_SOLANA_L1_ENABLED = "true";
      process.env.OBSERVATORY_SOLANA_SECRET_KEY = Buffer.from(solKeypair.secretKey).toString("base64");
      try {
        await seed([baseItem(1, "GET"), solItem(1)]);
        const w = wall();
        const asked: string[] = [];
        await runL1Batch({
          limit: 10,
          fetchImpl: w.fetchImpl,
          getSolanaBlockhash: async () => BLOCKHASH,
          getPayerUsdcBalance: async ({ chain, owner }) => {
            asked.push(`${chain}:${owner}`);
            return chain === "solana" ? 0n : 10_000_000n;
          },
        });
        assert.ok(!w.seen.some((s) => s.url.includes("solseller") && s.paid), "Solana には署名しない");
        assert.ok(w.seen.some((s) => s.url.includes("seller1.example") && s.paid), "Base は買う");
        assert.deepEqual(await rowsFor("https://solseller1.example/api"), []);
        assert.ok(asked.includes(`solana:${solKeypair.publicKey.toBase58()}`), "Solana の購入元の残高を読む");
      } finally {
        restore("OBSERVATORY_SOLANA_L1_ENABLED", saved.solOn);
        restore("OBSERVATORY_SOLANA_SECRET_KEY", saved.solKey);
      }
    });
  });
}
