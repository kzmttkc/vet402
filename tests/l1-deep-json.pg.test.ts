// ============================================================
// 深く入れ子にした 402 を返す売り手（2026-11-02 資金経路の監査 M-1・L-1）。
//
// 守ること:
//  1. 額を変えた深い 402 でも行が残る（読めない 402 = no_eligible_accept）。行が無いと窓にも冷却にも入らず毎回選ばれ、
//     購入バッチの持ち時間を使い切れる。2 回目のバッチは同じ出品を取りに行かない。
//  2. 署名できる形の 402 でも深ければ署名しない。
//  3. ヘッダーで読める 402 の本文が深い形は、買えて、証拠の 2 列が印だけにならない。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_deep_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-deep-json.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const FUNDED_PAYER = async () => 1_000_000_000n;
const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 deep json (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;
  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const PAY_TO = `0x${"ab".repeat(20)}`;

  test("L1 deep 402", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const saved = { l1: process.env.OBSERVATORY_L1_ENABLED, pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY };
    t.after(() => {
      if (saved.l1 === undefined) delete process.env.OBSERVATORY_L1_ENABLED;
      else process.env.OBSERVATORY_L1_ENABLED = saved.l1;
      if (saved.pk === undefined) delete process.env.OBSERVATORY_WALLET_PRIVATE_KEY;
      else process.env.OBSERVATORY_WALLET_PRIVATE_KEY = saved.pk;
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;

    const rows = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
    const deepText = (n: number) => `${"[".repeat(n)}${"]".repeat(n)}`;
    const URL_ = "https://deep.sellerone.io/x";
    const accept = (amount: string, extra: string) =>
      `{"scheme":"exact","network":"eip155:8453","amount":"${amount}","asset":"${BASE_USDC}","payTo":"${PAY_TO}","maxTimeoutSeconds":300,"extra":${extra}}`;
    const NORMAL_EXTRA = `{"name":"USD Coin","version":"2"}`;
    const doc = (a: string) => `{"x402Version":2,"accepts":[${a}]}`;

    async function seed() {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases, x402_l1_spend_pool_daily`);
      await syncCatalog({
        fetchResult: {
          items: [
            parseCatalogItem({
              resource: URL_,
              accepts: [{ amount: "1000", asset: BASE_USDC, network: "eip155:8453", payTo: PAY_TO }],
              extensions: { bazaar: { info: { input: { method: "GET" } } } },
              quality: { l30DaysTotalCalls: 100, l30DaysUniquePayers: 10 },
            }),
          ],
          totalCount: 1,
          fetchedCount: 1,
          complete: true,
        },
        today: "2026-11-02",
      });
      const probe = async () => new Response(doc(accept("1000", NORMAL_EXTRA)), { status: 402, headers: { "content-type": "application/json" } });
      await runL0ProbeBatch({ limit: 5, concurrency: 1, fetchImpl: probe as never });
    }
    const paidResponse = () =>
      new Response(JSON.stringify({ data: "goods" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: true, transaction: `0x${"77".repeat(32)}`, network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" })).toString("base64"),
        },
      });
    const run = (fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) =>
      runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 10, fetchImpl: fetchImpl as never });
    const ledger = async () => rows(await db.execute(sql`SELECT status, spent_units, challenge_402, payment_payload FROM x402_l1_purchases`));

    for (const depth of [3000, 5000]) {
      await t.test(`額を変えた深さ ${depth} の 402: 行が残り、2 回目のバッチは取りに行かない`, async () => {
        await seed();
        let calls = 0;
        const fetchImpl = async () => {
          calls++;
          return new Response(doc(accept("2000", deepText(depth))), { status: 402, headers: { "content-type": "application/json" } });
        };
        await run(fetchImpl);
        const after1 = await ledger();
        assert.equal(after1.length, 1, "a row is written");
        assert.equal(after1[0].status, "no_eligible_accept");
        assert.equal(String(after1[0].spent_units ?? "0"), "0");
        assert.equal(calls, 1);
        await run(fetchImpl);
        assert.equal(calls, 1, "the next batch does not fetch it again");
      });
    }

    await t.test("署名できる形でも深ければ署名しない", async () => {
      await seed();
      let paid = 0;
      await run(async (_url, init) => {
        const h = new Headers(init?.headers);
        if (h.has("PAYMENT-SIGNATURE") || h.has("X-PAYMENT")) {
          paid++;
          return paidResponse();
        }
        return new Response(doc(accept("1000", `{"name":"USD Coin","version":"2","deep":${deepText(3000)}}`)), { status: 402 });
      });
      assert.equal(paid, 0);
      const r = await ledger();
      assert.equal(r.length, 1);
      assert.equal(r[0].status, "no_eligible_accept");
    });

    await t.test("ヘッダーで読める 402 の本文が深い形: 買えて、証拠の 2 列が印だけにならない", async () => {
      await seed();
      await run(async (_url, init) => {
        const h = new Headers(init?.headers);
        if (h.has("PAYMENT-SIGNATURE") || h.has("X-PAYMENT")) return paidResponse();
        return new Response(deepText(3000), {
          status: 402,
          headers: { "PAYMENT-REQUIRED": Buffer.from(doc(accept("1000", NORMAL_EXTRA)), "utf8").toString("base64") },
        });
      });
      const r = await ledger();
      assert.equal(r.length, 1);
      assert.notEqual(r[0].status, "no_eligible_accept");
      const challenge = r[0].challenge_402 as Record<string, unknown>;
      assert.equal(challenge.error, undefined, "challenge_402 is not a marker");
      assert.equal(challenge.source, "header");
      const payload = r[0].payment_payload as Record<string, unknown>;
      assert.equal(payload.error, undefined, "payment_payload is not a marker");
    });
  });
}
