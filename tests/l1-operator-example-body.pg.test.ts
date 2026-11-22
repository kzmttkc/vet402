// ============================================================
// L1 ランナー: operator の一覧の例の本文（2026-11-22・オーナー承認 21:51）。
//
// 守ること（本文の出どころの順は ①売り手依頼 ②402 の宣言 ③operator の例 ④ `{}`）:
//  1. source = 'operator' の POST で 402 が本文を宣言しなければ、無払いの要求も支払い付きの要求も一覧の例の本文を送り、
//     行の raw_response_meta.requestBody は operator_example、requestBodySha256 は送った本文の SHA-256。
//  2. 402 が本文を宣言していれば、operator の行でも宣言が先（例の本文は支払い付きの要求に使わない）。
//  3. operator 以外の行（同じ一覧に載る URL でも cdp_bazaar の行）は例の本文を使わない（従来どおり `{}`）。
//  4. 上限は今までどおり効く: 売り手の日次上限が 0 なら operator の行にも支払い付きの要求を出さない。
// 一覧の引き当ては本物の OPERATOR_LISTINGS（URL で引く）。ネットワークは差し替えの fetch だけで、外へは出ない。
//
// Run: TEST_DATABASE_URL=postgres:///vet402_test_oplist \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-operator-example-body.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 operator example body (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const payToFor = (n: number) => `0x${String(n).repeat(40).slice(0, 40)}`;

  test("operator の例の本文は、402 の宣言が無い operator の行にだけ使い、上限は今までどおり", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { syncOperatorListings } = await import("@/lib/observatory/operator-sync");
    const { OPERATOR_LISTINGS, operatorExampleBody } = await import("@/lib/observatory/operator-listings");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const saved = {
      l1: process.env.OBSERVATORY_L1_ENABLED,
      pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY,
      cap: process.env.L1_SELLER_DAILY_CAP_USD,
    };
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    t.after(() => {
      restore("OBSERVATORY_L1_ENABLED", saved.l1);
      restore("OBSERVATORY_WALLET_PRIVATE_KEY", saved.pk);
      restore("L1_SELLER_DAILY_CAP_USD", saved.cap);
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    delete process.env.L1_SELLER_DAILY_CAP_USD;

    // 本物の一覧の 3 件の URL。台は Base（このハーネスの署名の経路）に置き換えるが、例の本文は URL で本物の一覧から引く。
    const [IG, TT, XA] = OPERATOR_LISTINGS.map((l) => l.url);
    assert.ok(IG && TT && XA, "一覧に usebuy の 3 件がある");
    const IG_EXAMPLE = operatorExampleBody(IG)!;
    const XA_EXAMPLE = operatorExampleBody(XA)!;
    assert.equal(IG_EXAMPLE, '{"username":"instagram"}');

    const DECLARED = { queryParams: { screen_name: "declared-by-seller" } };
    const nOf = (url: string) => (url === IG ? 1 : url === TT ? 2 : 3);
    const challengeDoc = (url: string) => ({
      x402Version: 2,
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: "3000", asset: BASE_USDC, payTo: payToFor(nOf(url)), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
      // XA だけ、402 が本文を宣言する。
      ...(url === XA ? { extensions: { bazaar: { info: { input: { type: "http", method: "POST", body: DECLARED } } } } } : {}),
    });
    const wall402 = (url: string) =>
      new Response(JSON.stringify({ error: "payment required" }), {
        status: 402,
        headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challengeDoc(url))).toString("base64") },
      });
    type Seen = { url: string; paid: boolean; body: string | null; crossOriginBody: string | null };
    const wall = () => {
      const seen: Seen[] = [];
      const fetchImpl = async (url: string, init?: RequestInit, call?: { crossOriginBody?: string }) => {
        const headers = new Headers(init?.headers);
        const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
        seen.push({ url, paid, body: typeof init?.body === "string" ? init.body : null, crossOriginBody: call?.crossOriginBody ?? null });
        if (!paid) return wall402(url);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({ success: true, transaction: `0x${String(seen.length).padStart(64, "b")}`, network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" }),
            ).toString("base64"),
          },
        });
      };
      return { seen, fetchImpl };
    };

    const operatorRow = (url: string, exampleBody: string) => ({
      url,
      method: "POST" as const,
      network: "eip155:8453",
      payTo: payToFor(nOf(url)),
      asset: BASE_USDC,
      amount: "3000",
      extra: { name: "USD Coin", version: "2" },
      maxTimeoutSeconds: 300,
      exampleBody,
      reason: "test",
      addedOn: "2026-11-22",
    });
    async function seed() {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      // IG・XA は operator の行。TT は同じ一覧に載る URL だが、ここでは cdp_bazaar の行として入れる（operator ではない）。
      await syncOperatorListings({ listings: [operatorRow(IG, IG_EXAMPLE), operatorRow(XA, XA_EXAMPLE)], today: "2026-11-22" });
      const tt = parseCatalogItem({
        resource: TT,
        accepts: [{ amount: "3000", asset: BASE_USDC, network: "eip155:8453", payTo: payToFor(2) }],
        extensions: { bazaar: { info: { input: { method: "POST" } } } },
        quality: { l30DaysTotalCalls: 100, l30DaysUniquePayers: 10 },
      });
      await syncCatalog({ fetchResult: { items: [tt], totalCount: 1, fetchedCount: 1, complete: true }, today: "2026-11-22" });
      await runL0ProbeBatch({ limit: 10, concurrency: 2, fetchImpl: async (url: string) => wall402(url) });
    }
    const rowsOf = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
    const metaFor = async (url: string) =>
      rowsOf(
        await db.execute(sql`
          SELECT e.source, pu.raw_response_meta->>'requestBody' AS request_body, pu.raw_response_meta->>'requestBodySha256' AS sha
          FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id WHERE e.resource_url = ${url}`),
      );
    const FUNDED = async () => 10_000_000n;

    await t.test("出どころの順: 402 の宣言 > operator の例 > {}、operator 以外には使わない", async () => {
      await seed();
      const w = wall();
      await runL1Batch({ limit: 10, fetchImpl: w.fetchImpl, getPayerUsdcBalance: FUNDED });
      const of = (url: string, paid: boolean) => w.seen.filter((s) => s.url === url && s.paid === paid);

      // 1. operator・宣言なし: 無払いも支払い付きも例の本文。
      assert.equal(of(IG, false)[0]?.body, IG_EXAMPLE, "無払いの要求も例の本文");
      assert.equal(of(IG, true).length, 1);
      assert.equal(of(IG, true)[0].body, IG_EXAMPLE, "支払い付きの要求は例の本文");
      assert.equal(of(IG, true)[0].crossOriginBody, "refuse", "例の本文も別オリジンへ運ばない");
      const ig = await metaFor(IG);
      assert.deepEqual(ig.map((r) => [r.source, r.request_body]), [["operator", "operator_example"]]);
      assert.equal(ig[0].sha, createHash("sha256").update(IG_EXAMPLE, "utf8").digest("hex"), "記録の hash は送った本文のもの");

      // 2. operator・宣言あり: 宣言が先。
      assert.equal(of(XA, false)[0]?.body, XA_EXAMPLE, "無払いの要求は宣言を読む前なので例の本文");
      assert.equal(of(XA, true).length, 1);
      assert.deepEqual(JSON.parse(of(XA, true)[0].body ?? "null"), DECLARED, "402 の宣言が例の本文より先");
      assert.deepEqual((await metaFor(XA)).map((r) => r.request_body), ["declared"]);

      // 3. operator 以外（同じ一覧に載る URL の cdp_bazaar の行）: 従来どおり {}。
      assert.equal(of(TT, false)[0]?.body, "{}");
      assert.equal(of(TT, true).length, 1);
      assert.equal(of(TT, true)[0].body, "{}", "operator でない行に例の本文を送らない");
      assert.deepEqual((await metaFor(TT)).map((r) => [r.source, r.request_body]), [["cdp_bazaar", "empty"]]);
    });

    await t.test("上限は今までどおり: 売り手の日次上限 0 なら operator の行にも支払い付きの要求を出さない", async () => {
      await seed();
      process.env.L1_SELLER_DAILY_CAP_USD = "0";
      try {
        const w = wall();
        await runL1Batch({ limit: 10, fetchImpl: w.fetchImpl, getPayerUsdcBalance: FUNDED });
        assert.equal(w.seen.filter((s) => s.paid).length, 0, "支払い付きの要求は 0 本");
        const settledOrClaimed = rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases WHERE status IN ('settled', 'settle_claimed')`));
        assert.equal(Number(settledOrClaimed[0].n), 0);
      } finally {
        delete process.env.L1_SELLER_DAILY_CAP_USD;
      }
    });
  });
}
