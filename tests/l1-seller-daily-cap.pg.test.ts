// ============================================================
// L1 の売り手ごとの日次上限（2026-09-29 監査 5 周目・高・お金のコード）。
//
// 攻撃の形: 同じ payTo で $1 の出品を多数載せ、鍵なしの判定 API で「問い合わせ多」の最優先枠に入れると、
// 主候補にも予約にも payTo・ホスト単位の上限が無く、1 人の売り手が日次 $25 を毎日取れた。
//
// 守ること:
//  1. 同じ受取先（payTo）への当日の支出は SELLER_DAILY_CAP_USD（既定 $2）まで。3 件目は予約で断り、
//     **台帳に行を書かず**、支払い付きの要求を出さない（翌日また候補になる）。
//  2. 上限ちょうどは通す（<=）。1 単位でも超える予約は断る。
//  3. 受取先が違っても同じホスト（ポート無視）なら同じ上限。
//  4. 当日もう上限に届いた受取先の出品には、402 を取りに行く要求も出さない（候補 SQL）。
//  5. 別のバッチを同時に走らせても、超えるのは互いの INSERT が見えないほぼ同時の 2 文の 1 件ぶんまで
//     （reserveSpend の既知の境界・日次 $25 と同じ）。
//  6. http の出品・カタログに pay_to が無い出品には 1 リクエストも出さず、行も書かない（監査 5 周目・中）。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-seller-daily-cap.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const FUNDED_PAYER = async () => 1_000_000_000n;
const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 seller daily cap (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const ATTACKER = "0x" + "a1".repeat(20);
  const HONEST = "0x" + "b2".repeat(20);
  const payToFor = (n: number) => `0x${String(n).repeat(40).slice(0, 40)}`;

  test("L1 seller daily cap", async (t) => {
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
    delete process.env.L1_SELLER_DAILY_CAP_USD; // 既定 $2

    let txCounter = 0; // 決済レシートの tx は購入ごとに別（tx_hash の一意制約）
    type Listing = { url: string; payTo: string | null; amount: string; calls?: number };
    const rows = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];

    /** 出品の宣言と同じ 402 を返し、支払い付きは 200 + 決済レシート。どの URL に何を出したかを記録する。 */
    const wall = (listings: Listing[]) => {
      const seen: { url: string; paid: boolean }[] = [];
      const byUrl = new Map(listings.map((l) => [l.url, l]));
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
        seen.push({ url, paid });
        const l = byUrl.get(url);
        if (!l) return new Response("nope", { status: 404 });
        if (!paid) {
          return new Response(
            JSON.stringify({
              x402Version: 2,
              accepts: [{ scheme: "exact", network: "eip155:8453", amount: l.amount, asset: BASE_USDC, payTo: l.payTo ?? ATTACKER, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
            }),
            { status: 402, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({ success: true, transaction: `0x${(++txCounter).toString(16).padStart(64, "0")}`, network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" }),
            ).toString("base64"),
          },
        });
      };
      return { seen, fetchImpl };
    };

    async function seed(listings: Listing[]) {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      await syncCatalog({
        fetchResult: {
          items: listings.map((l) =>
            parseCatalogItem({
              resource: l.url,
              accepts: [{ amount: l.amount, asset: BASE_USDC, network: "eip155:8453", ...(l.payTo ? { payTo: l.payTo } : {}) }],
              extensions: { bazaar: { info: { input: { method: "GET" } } } },
              quality: { l30DaysTotalCalls: l.calls ?? 100, l30DaysUniquePayers: 10 },
            }),
          ),
          totalCount: listings.length,
          fetchedCount: listings.length,
          complete: true,
        },
        today: "2026-09-29",
      });
      const w = wall(listings);
      await runL0ProbeBatch({ limit: 50, concurrency: 2, fetchImpl: w.fetchImpl });
    }

    const spentBy = async (where: "payto" | "host", key: string) => {
      const raw =
        where === "payto"
          ? await db.execute(sql`SELECT coalesce(sum(spent_units::numeric), 0)::text AS s FROM x402_l1_purchases WHERE lower(pay_to) = ${key.toLowerCase()}`)
          : await db.execute(sql`
              SELECT coalesce(sum(pu.spent_units::numeric), 0)::text AS s FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
              WHERE e.resource_url LIKE ${`https://${key}%`}`);
      return BigInt(String(rows(raw)[0].s).split(".")[0]);
    };
    const ledgerFor = async (url: string) =>
      rows(
        await db.execute(sql`
          SELECT pu.status FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id WHERE e.resource_url = ${url}`),
      ).map((r) => String(r.status));
    const run = (w: ReturnType<typeof wall>, limit = 50) =>
      runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit, fetchImpl: w.fetchImpl });

    await t.test("同じ受取先の $1 の出品 5 件: 2 件（$2）で止まり、3 件目以降は支払い付きで出さず行も書かない", async () => {
      const listings: Listing[] = [1, 2, 3, 4, 5].map((n) => ({ url: `https://atk${n}.example/api`, payTo: ATTACKER, amount: "1000000", calls: 5000 }));
      listings.push({ url: "https://honest.example/api", payTo: HONEST, amount: "3000" });
      await seed(listings);
      const w = wall(listings);
      const summary = await run(w);
      assert.equal(await spentBy("payto", ATTACKER), 2_000_000n, "同じ受取先への当日の支出は $2 ちょうど");
      const paidAtk = w.seen.filter((s) => s.paid && s.url.includes("atk"));
      assert.equal(paidAtk.length, 2, "支払い付きの要求は 2 回だけ");
      const unwritten = [];
      for (const l of listings.filter((x) => x.payTo === ATTACKER)) {
        if ((await ledgerFor(l.url)).length === 0) unwritten.push(l.url);
      }
      assert.equal(unwritten.length, 3, "上限で断った出品には行を書かない（翌日また候補になる）");
      assert.ok(summary.sellerCapped >= 1, `summary.sellerCapped=${summary.sellerCapped}`);
      // 同じバッチの残り（同じ受取先）は 402 も取りに行かない: 断った 1 件の後は無償の要求も出ない。
      const unpaidAtk = w.seen.filter((s) => !s.paid && s.url.includes("atk"));
      assert.equal(unpaidAtk.length, 3, `無償の要求は買えた 2 件＋断った 1 件だけ（${unpaidAtk.length}）`);
      assert.ok(w.seen.some((s) => s.paid && s.url === "https://honest.example/api"), "他の売り手は買う");
    });

    await t.test("翌バッチ（同じ UTC 日）: 上限に届いた受取先の出品には無償の要求も出さない（候補 SQL）", async () => {
      const listings: Listing[] = [1, 2, 3].map((n) => ({ url: `https://atk${n}.example/api`, payTo: ATTACKER, amount: "1000000" }));
      await seed(listings);
      await run(wall(listings));
      assert.equal(await spentBy("payto", ATTACKER), 2_000_000n);
      const w2 = wall(listings);
      const s2 = await run(w2);
      assert.equal(w2.seen.length, 0, `上限の受取先には 1 リクエストも出さない: ${JSON.stringify(w2.seen)}`);
      assert.equal(s2.attempted, 0);
      assert.equal(await spentBy("payto", ATTACKER), 2_000_000n);
    });

    await t.test("上限ちょうどは通す・1 単位でも超えれば断る", async () => {
      const listings: Listing[] = [
        { url: "https://edge1.example/api", payTo: ATTACKER, amount: "1500000", calls: 900 },
        { url: "https://edge2.example/api", payTo: ATTACKER, amount: "500000", calls: 800 },
        { url: "https://edge3.example/api", payTo: ATTACKER, amount: "1", calls: 700 },
      ];
      await seed(listings);
      // 1 件目だけ既存の支出として置く（並び順に依存しない）
      const ep = rows(await db.execute(sql`SELECT id FROM x402_endpoints WHERE resource_url = 'https://edge1.example/api'`))[0].id as string;
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep,
        status: "settled",
        payer: "0x0000000000000000000000000000000000000001",
        network: "eip155:8453",
        asset: BASE_USDC,
        payTo: ATTACKER,
        amountUnits: "1500000",
        spentUnits: "1500000",
      });
      const w = wall(listings);
      await run(w);
      assert.equal(await spentBy("payto", ATTACKER), 2_000_000n, "1.5 + 0.5 = 上限ちょうどは通る");
      assert.deepEqual(await ledgerFor("https://edge3.example/api"), [], "上限ちょうどの後の 1 単位は断る（行なし）");
      assert.ok(!w.seen.some((s) => s.paid && s.url.includes("edge3")));
    });

    await t.test("受取先が違っても同じホスト（ポート違いを含む）なら同じ上限", async () => {
      const listings: Listing[] = [1, 2, 3, 4].map((n) => ({ url: `https://multi.example${n % 2 === 0 ? ":8443" : ""}/api/${n}`, payTo: payToFor(n), amount: "1000000" }));
      await seed(listings);
      const w = wall(listings);
      await run(w);
      const raw = await db.execute(sql`SELECT coalesce(sum(spent_units::numeric), 0)::text AS s FROM x402_l1_purchases`);
      assert.equal(BigInt(String(rows(raw)[0].s).split(".")[0]), 2_000_000n, "ホスト単位で $2");
      assert.equal(w.seen.filter((s) => s.paid).length, 2);
    });

    await t.test("別のバッチを同時に走らせても、超えるのは同時の 1 件ぶんまで", async () => {
      const listings: Listing[] = [1, 2, 3, 4, 5, 6].map((n) => ({ url: `https://race${n}.example/api`, payTo: ATTACKER, amount: "1000000" }));
      await seed(listings);
      const [a, b] = [wall(listings), wall(listings)];
      await Promise.all([run(a), run(b)]);
      const spent = await spentBy("payto", ATTACKER);
      assert.ok(spent <= 3_000_000n, `同時実行でも $2 + 1 件（$1）まで: ${spent}`);
      // 次のバッチでは上限の受取先には触れない。
      const c = wall(listings);
      await run(c);
      assert.equal(c.seen.filter((s) => s.paid).length, 0, "同時実行の後のバッチは払わない");
    });

    await t.test("上限は環境変数で変えられる（0 で誰にも払わない）", async () => {
      process.env.L1_SELLER_DAILY_CAP_USD = "0";
      try {
        const listings: Listing[] = [{ url: "https://zero.example/api", payTo: HONEST, amount: "3000" }];
        await seed(listings);
        const w = wall(listings);
        await run(w);
        assert.equal(w.seen.filter((s) => s.paid).length, 0);
        assert.deepEqual(await ledgerFor("https://zero.example/api"), []);
      } finally {
        delete process.env.L1_SELLER_DAILY_CAP_USD;
      }
    });

    await t.test("http の出品・pay_to の無い出品には 1 リクエストも出さず、行も書かない", async () => {
      const listings: Listing[] = [
        { url: "http://plain.example/api", payTo: HONEST, amount: "3000", calls: 9000 },
        { url: "https://nopayto.example/api", payTo: null, amount: "3000", calls: 9000 },
        { url: "https://ok.example/api", payTo: HONEST, amount: "3000" },
      ];
      await seed(listings);
      const w = wall(listings);
      await run(w);
      assert.ok(!w.seen.some((s) => s.url.startsWith("http://plain.example")), "http の出品には出さない");
      assert.ok(!w.seen.some((s) => s.url.includes("nopayto")), "pay_to の無い出品には出さない");
      assert.deepEqual(await ledgerFor("http://plain.example/api"), []);
      assert.deepEqual(await ledgerFor("https://nopayto.example/api"), []);
      assert.ok(w.seen.some((s) => s.paid && s.url === "https://ok.example/api"), "https で pay_to のある出品は買う");
    });

    await t.test("1 件指定（onlyEndpointId）でも http・pay_to 無しには署名しない（purchaseOne の二重防御）", async () => {
      const listings: Listing[] = [{ url: "https://nopayto2.example/api", payTo: null, amount: "3000" }];
      await seed(listings);
      const id = rows(await db.execute(sql`SELECT id FROM x402_endpoints WHERE resource_url = 'https://nopayto2.example/api'`))[0].id as string;
      const w = wall(listings);
      await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 5, fetchImpl: w.fetchImpl, onlyEndpointId: id });
      assert.equal(w.seen.length, 0);
      assert.deepEqual(await ledgerFor("https://nopayto2.example/api"), []);
    });
  });
}
