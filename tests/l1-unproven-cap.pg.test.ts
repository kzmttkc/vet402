// ============================================================
// 実績のない売り手の上限（2026-11-02 資金経路の監査 H-1）。
//
// 守ること（お金）:
//  1. 無料のサブドメインと別々の payTo を 40 組並べても、実績のない売り手への署名は 1 件の上限（既定 $0.10）と
//     全体の日次合計（既定 $3）で止まる。止まった候補は行を書かず、有料の要求も出さない。cron の応答に数が出る。
//  2. 同時の複数バッチでも日次合計を超えない（台帳の行の合計と、数の行の両方で確かめる）。
//  3. 1 回の配達・同じ日の配達の山・14 日に満たない配達では実績にならない。配達でない行は数えない。
//  4. 受取先か登録ドメインの片方に実績があれば、既存の上限（1 件 $1・$2・$3）だけで買える。
//  5. 環境変数で下げられる。0 で実績のない売り手には払わない。
//  6. 公開の demo/verify の要約に数を出さない。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_unproven_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-unproven-cap.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const FUNDED_PAYER = async () => 1_000_000_000n;
const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 unproven cap (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const payToFor = (n: number) => `0x${(n + 16).toString(16).padStart(4, "0").repeat(10)}`;

  test("L1 unproven seller caps", async (t) => {
    const { runL1Batch, publicL1Summary } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const KEYS = [
      "OBSERVATORY_L1_ENABLED",
      "OBSERVATORY_WALLET_PRIVATE_KEY",
      "L1_SELLER_DAILY_CAP_USD",
      "L1_DOMAIN_DAILY_CAP_USD",
      "L1_UNPROVEN_PURCHASE_CAP_USD",
      "L1_UNPROVEN_DAILY_CAP_USD",
      "L1_OVER_DIME_DAILY_CAP_USD",
    ] as const;
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    t.after(() => {
      for (const k of KEYS) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    const resetCaps = () => {
      delete process.env.L1_SELLER_DAILY_CAP_USD;
      delete process.env.L1_DOMAIN_DAILY_CAP_USD;
      delete process.env.L1_UNPROVEN_PURCHASE_CAP_USD;
      delete process.env.L1_UNPROVEN_DAILY_CAP_USD;
      delete process.env.L1_OVER_DIME_DAILY_CAP_USD;
    };

    type Listing = { url: string; payTo: string; amount: string };
    const rows = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
    let txCounter = 0;
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
              accepts: [{ scheme: "exact", network: "eip155:8453", amount: l.amount, asset: BASE_USDC, payTo: l.payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
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
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases, x402_l1_spend_pool_daily`,
      );
      await syncCatalog({
        fetchResult: {
          items: listings.map((l) =>
            parseCatalogItem({
              resource: l.url,
              accepts: [{ amount: l.amount, asset: BASE_USDC, network: "eip155:8453", payTo: l.payTo }],
              extensions: { bazaar: { info: { input: { method: "GET" } } } },
              quality: { l30DaysTotalCalls: 100, l30DaysUniquePayers: 10 },
            }),
          ),
          totalCount: listings.length,
          fetchedCount: listings.length,
          complete: true,
        },
        today: "2026-11-02",
      });
      await runL0ProbeBatch({ limit: 100, concurrency: 8, fetchImpl: wall(listings).fetchImpl });
    }

    /** 過去の行を 1 件足す。既定は delivered（settled・200・本文あり）。 */
    async function history(input: {
      url: string;
      payTo: string;
      daysAgo: number;
      status?: string;
      http?: number;
      nonEmpty?: boolean;
    }) {
      const ep = rows(await db.execute(sql`SELECT id FROM x402_endpoints WHERE resource_url = ${input.url}`))[0];
      assert.ok(ep, `no endpoint ${input.url}`);
      await db.execute(sql`
        INSERT INTO x402_l1_purchases (endpoint_id, status, payer, network, asset, pay_to, amount_units, spent_units, http_status_paid, payload_non_empty, attempted_at)
        VALUES (${ep.id as string}::uuid, ${input.status ?? "settled"}, 'seed', 'eip155:8453', ${BASE_USDC}, ${input.payTo}, '1000', '1000',
                ${input.http ?? 200}, ${input.nonEmpty ?? true}, now() - make_interval(days => ${input.daysAgo}))`);
    }

    const ledger = async () => {
      const r = rows(
        await db.execute(sql`
          SELECT coalesce(sum(spent_units::numeric), 0)::text AS s, count(*)::int AS n,
                 count(*) FILTER (WHERE spent_units::numeric > 0)::int AS paid,
                 count(DISTINCT pay_to) FILTER (WHERE spent_units::numeric > 0)::int AS payees
          FROM x402_l1_purchases WHERE attempted_at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`),
      )[0];
      return { spent: BigInt(String(r.s).split(".")[0]), rows: Number(r.n), paid: Number(r.paid), payees: Number(r.payees) };
    };
    const poolSpent = async () => {
      const r = rows(await db.execute(sql`SELECT spent_units::text AS s FROM x402_l1_spend_pool_daily WHERE pool = 'unproven'`));
      return r.length === 0 ? 0n : BigInt(String(r[0].s).split(".")[0]);
    };
    const run = (w: ReturnType<typeof wall>, limit = 100) =>
      runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit, fetchImpl: w.fetchImpl, batchBudgetMs: 120_000 });

    const subdomainListings = (n: number, amount: string): Listing[] =>
      Array.from({ length: n }, (_, i) => ({ url: `https://atk${i}.vercel.app/x`, payTo: payToFor(i), amount }));

    await t.test("監査の再現: *.vercel.app の $1 を 40 組。1 件も署名せず、行も書かず、応答に数が出る", async () => {
      resetCaps();
      const listings = subdomainListings(40, "1000000");
      await seed(listings);
      const w = wall(listings);
      const s = await run(w);
      const l = await ledger();
      assert.equal(l.spent, 0n, "no signed spend");
      assert.equal(l.rows, 0, "no failure row");
      assert.equal(s.attempted, 0);
      assert.equal(w.seen.filter((c) => c.paid).length, 0, "no paid request");
      assert.equal(s.unprovenPriceExcluded, 40, "cron response names the listings left out");
    });

    await t.test("*.vercel.app の $0.10 を 40 組: 日次合計 $3 で止まり、残りは行を書かない", async () => {
      resetCaps();
      const listings = subdomainListings(40, "100000");
      await seed(listings);
      const w = wall(listings);
      const s = await run(w);
      const l = await ledger();
      assert.equal(l.spent, 3_000_000n, "pool ends at $3");
      assert.equal(l.paid, 30);
      assert.equal(l.rows, 30, "refused candidates leave no row");
      assert.equal(await poolSpent(), 3_000_000n, "counter row matches the ledger");
      assert.equal(w.seen.filter((c) => c.paid).length, 30);
      assert.equal(s.attempted, 30);
      assert.ok(s.unprovenCapped >= 1, `unprovenCapped=${s.unprovenCapped}`);
      assert.equal(s.sellerCapped, 0, "not counted as a per-seller cap");
      assert.equal(s.settleFailed, 0);
      assert.equal(s.budgetDenied, 0);
      // 開いた枠が尽きたら、同じバッチの残りには 402 も取りに行かない（プローブ 1 回 + 署名ぶん + 断られた 1 件）。
      assert.equal(w.seen.filter((c) => !c.paid).length, 31, "no 402 fetch after the pool closed");
      // 次のバッチは候補の段で外す。
      const w2 = wall(listings);
      const s2 = await run(w2);
      assert.equal(w2.seen.length, 0, "the next batch fetches nothing");
      assert.equal(s2.attempted, 0);
      assert.equal(s2.unprovenPoolClosed, true);
    });

    for (const batches of [2, 6]) {
      await t.test(`同時の ${batches} バッチでも $3 を超えない`, async () => {
        resetCaps();
        const listings = subdomainListings(60, "100000");
        await seed(listings);
        const w = wall(listings);
        await Promise.all(Array.from({ length: batches }, () => run(w)));
        const l = await ledger();
        assert.ok(l.spent <= 3_000_000n, `ledger spent ${l.spent}`);
        assert.equal(await poolSpent(), l.spent, "counter row equals the ledger under concurrency");
      });
    }

    // バッチは同時に始まるので、最初の予約どうしが重なる。枠を小さくすると、その重なりがちょうど上限の境目に来る。
    // 同じ文のスナップショットで読むだけの作りは、ここで上限を超える（この試験はそれを落とすためにある）。
    for (const [batches, cap, units] of [[2, "0.1", 100_000n], [6, "0.3", 300_000n], [12, "0.5", 500_000n]] as const) {
      await t.test(`枠の境目で同時の ${batches} バッチ: $${cap} を超えない（5 回）`, async () => {
        for (let round = 0; round < 5; round++) {
          resetCaps();
          process.env.L1_UNPROVEN_DAILY_CAP_USD = cap;
          const listings = subdomainListings(30, "100000");
          await seed(listings);
          const w = wall(listings);
          await Promise.all(Array.from({ length: batches }, () => run(w)));
          const l = await ledger();
          assert.ok(l.spent <= units, `round ${round}: ledger spent ${l.spent}`);
          assert.equal(await poolSpent(), l.spent, `round ${round}: counter row equals the ledger`);
        }
        resetCaps();
      });
    }

    await t.test("1 回の配達では抜けられない: 翌日の $1 は買わない", async () => {
      resetCaps();
      const listings: Listing[] = [
        { url: "https://solo.vercel.app/old", payTo: payToFor(1), amount: "1000" },
        { url: "https://solo.vercel.app/one-dollar", payTo: payToFor(1), amount: "1000000" },
      ];
      await seed(listings);
      await history({ url: listings[0].url, payTo: payToFor(1), daysAgo: 1 });
      const w = wall(listings);
      await run(w);
      assert.equal((await ledger()).spent, 0n);
      assert.equal(w.seen.filter((c) => c.paid).length, 0);
    });

    const provenCases: { name: string; days: number[]; proven: boolean; bad?: { status?: string; http?: number; nonEmpty?: boolean } }[] = [
      { name: "同じ日に 5 件は実績にならない", days: [20, 20, 20, 20, 20], proven: false },
      { name: "別々の 3 日でも最初から 14 日に満たない", days: [13, 7, 1], proven: false },
      { name: "14 日たっていても 2 日ぶんだけ", days: [30, 29], proven: false },
      { name: "別々の 3 日・最初から 14 日以上で実績になる", days: [20, 10, 1], proven: true },
      { name: "202 は配達に数えない", days: [20, 10, 1], proven: false, bad: { http: 202 } },
      { name: "5xx は配達に数えない", days: [20, 10, 1], proven: false, bad: { http: 500 } },
      { name: "本文が空は配達に数えない", days: [20, 10, 1], proven: false, bad: { nonEmpty: false } },
      { name: "決済が確かめられていない行は数えない", days: [20, 10, 1], proven: false, bad: { status: "settle_claimed" } },
    ];
    for (const c of provenCases) {
      await t.test(`実績の定義: ${c.name}`, async () => {
        resetCaps();
        const listings: Listing[] = [
          { url: "https://hist.example.org/old", payTo: payToFor(2), amount: "1000" },
          { url: "https://hist.example.org/one-dollar", payTo: payToFor(2), amount: "1000000" },
        ];
        await seed(listings);
        for (const d of c.days) await history({ url: listings[0].url, payTo: payToFor(2), daysAgo: d, ...(c.bad ?? {}) });
        const w = wall(listings);
        await run(w);
        const paid = w.seen.filter((x) => x.paid).map((x) => x.url);
        assert.equal(paid.includes(listings[1].url), c.proven, `paid: ${JSON.stringify(paid)}`);
      });
    }

    await t.test("受取先の実績は別のホストにも効く・登録ドメインの実績は別の受取先にも効く", async () => {
      resetCaps();
      const listings: Listing[] = [
        { url: "https://seed-a.vercel.app/x", payTo: payToFor(3), amount: "1000" },
        { url: "https://new-host.vercel.app/x", payTo: payToFor(3), amount: "1000000" },
        { url: "https://a.owned-domain.io/x", payTo: payToFor(4), amount: "1000" },
        { url: "https://b.owned-domain.io/x", payTo: payToFor(5), amount: "1000000" },
        { url: "https://stranger.vercel.app/x", payTo: payToFor(6), amount: "1000000" },
      ];
      await seed(listings);
      for (const d of [20, 10, 1]) await history({ url: listings[0].url, payTo: payToFor(3), daysAgo: d });
      for (const d of [20, 10, 1]) await history({ url: listings[2].url, payTo: payToFor(4), daysAgo: d });
      const w = wall(listings);
      const s = await run(w);
      const paid = w.seen.filter((x) => x.paid).map((x) => x.url).sort();
      assert.deepEqual(paid, ["https://b.owned-domain.io/x", "https://new-host.vercel.app/x"], "stranger stays out");
      assert.equal(await poolSpent(), 0n, "proven spend does not touch the unproven pool");
      assert.equal(s.unprovenPriceExcluded, 1);
    });

    await t.test("実績のある売り手には従来の $2 がそのまま効く", async () => {
      resetCaps();
      const listings: Listing[] = [
        { url: "https://old-seller.example.net/seed", payTo: payToFor(7), amount: "1000" },
        ...Array.from({ length: 4 }, (_, i) => ({ url: `https://old-seller.example.net/p${i}`, payTo: payToFor(7), amount: "1000000" })),
      ];
      await seed(listings);
      for (const d of [20, 10, 1]) await history({ url: listings[0].url, payTo: payToFor(7), daysAgo: d });
      const w = wall(listings);
      const s = await run(w);
      assert.equal((await ledger()).spent, 2_000_000n);
      assert.ok(s.sellerCapped >= 1);
      assert.equal(s.unprovenCapped, 0);
    });

    await t.test("環境変数: 上げ下げでき、0 で実績のない売り手には払わない。壊れた値は既定へ", async () => {
      const listings = subdomainListings(8, "50000");
      resetCaps();
      process.env.L1_UNPROVEN_DAILY_CAP_USD = "0.1";
      await seed(listings);
      let w = wall(listings);
      await run(w);
      assert.equal((await ledger()).spent, 100_000n, "lowered pool");

      resetCaps();
      process.env.L1_UNPROVEN_PURCHASE_CAP_USD = "0.01";
      await seed(listings);
      w = wall(listings);
      let s = await run(w);
      assert.equal((await ledger()).spent, 0n, "lowered per-purchase cap");
      assert.equal(s.unprovenPriceExcluded, 8);

      resetCaps();
      process.env.L1_UNPROVEN_DAILY_CAP_USD = "0";
      await seed(listings);
      w = wall(listings);
      s = await run(w);
      assert.equal((await ledger()).spent, 0n, "zero pays no unproven seller");
      assert.equal(s.unprovenPoolClosed, true);

      resetCaps();
      process.env.L1_UNPROVEN_DAILY_CAP_USD = "garbage";
      process.env.L1_UNPROVEN_PURCHASE_CAP_USD = "-1";
      await seed(listings);
      w = wall(listings);
      await run(w);
      assert.equal((await ledger()).spent, 400_000n, "broken values fall back to defaults");
      resetCaps();
    });

    await t.test("読めない宣言額の出品は、実績のない売り手なら候補にしない（行を書かずに毎回選ばれる形を作らない）", async () => {
      resetCaps();
      const listings: Listing[] = [{ url: "https://no-price.vercel.app/x", payTo: payToFor(8), amount: "1000000" }];
      await seed(listings);
      await db.execute(sql`UPDATE x402_endpoints SET price_amount = NULL`);
      const w = wall(listings);
      await run(w);
      assert.equal(w.seen.length, 0);
    });

    /** 候補 SQL を通したあとで環境変数を下げる。予約の 1 文だけが断る形を作る（候補 SQL は開始時の値で読み終えている）。 */
    const lowerAfterSelect = (w: ReturnType<typeof wall>, name: (typeof KEYS)[number], value: string) => ({
      ...w,
      fetchImpl: async (url: string, init?: RequestInit) => {
        process.env[name] = value;
        return w.fetchImpl(url, init);
      },
    });
    const paidUrls = (w: ReturnType<typeof wall>) => w.seen.filter((c) => c.paid).map((c) => c.url);
    const poolRows = async () => [...rows(await db.execute(sql`SELECT day::text AS day, spent_units::text AS s FROM x402_l1_spend_pool_daily WHERE pool = 'unproven' ORDER BY day`))];

    await t.test("予約だけ (1): 候補 SQL を通っても 1 件の上限で断る。行も数も増えない", async () => {
      resetCaps();
      const listings: Listing[] = [{ url: "https://only-reserve.vercel.app/x", payTo: payToFor(20), amount: "100000" }];
      await seed(listings);
      const w = wall(listings);
      const s = await run(lowerAfterSelect(w, "L1_UNPROVEN_PURCHASE_CAP_USD", "0.05"));
      assert.deepEqual(paidUrls(w), []);
      assert.equal(w.seen.length, 1, "the 402 was read, so the reservation is what refused");
      assert.equal((await ledger()).rows, 0);
      assert.equal(s.unprovenCapped, 1);
      assert.equal(s.unprovenPoolClosed, false, "a price refusal does not close the pool");
      assert.deepEqual(await poolRows(), []);
    });

    await t.test("予約だけ (2): 数の行が無くても、最初の INSERT で日次合計を超えない", async () => {
      resetCaps();
      const listings: Listing[] = [{ url: "https://first-insert.vercel.app/x", payTo: payToFor(21), amount: "100000" }];
      await seed(listings);
      assert.deepEqual(await poolRows(), [], "no counter row yet");
      const w = wall(listings);
      const s = await run(lowerAfterSelect(w, "L1_UNPROVEN_DAILY_CAP_USD", "0.05"));
      assert.deepEqual(paidUrls(w), []);
      assert.equal((await ledger()).rows, 0);
      assert.equal(s.unprovenCapped, 1);
      assert.equal(s.unprovenPoolClosed, true);
      assert.deepEqual(await poolRows(), []);
    });

    await t.test("予約だけ (3): 202 の配達では $1 を通さない。200 の配達なら同じ形で通る", async () => {
      for (const [http, buys] of [[202, false], [200, true]] as const) {
        resetCaps();
        process.env.L1_UNPROVEN_PURCHASE_CAP_USD = "1";
        const listings: Listing[] = [
          { url: "https://track.example.org/old", payTo: payToFor(22), amount: "1000" },
          { url: "https://track.example.org/one-dollar", payTo: payToFor(22), amount: "1000000" },
        ];
        await seed(listings);
        for (const d of [20, 10, 1]) await history({ url: listings[0].url, payTo: payToFor(22), daysAgo: d, http });
        const w = wall(listings);
        await run(lowerAfterSelect(w, "L1_UNPROVEN_PURCHASE_CAP_USD", "0.1"));
        assert.equal(paidUrls(w).includes(listings[1].url), buys, `http ${http}: ${JSON.stringify(paidUrls(w))}`);
      }
    });

    await t.test("予約だけ (4): 実績のある売り手の安い買い物は共有の枠を減らさない", async () => {
      resetCaps();
      const listings: Listing[] = [
        { url: "https://steady.example.net/seed", payTo: payToFor(23), amount: "10000" },
        { url: "https://steady.example.net/cheap", payTo: payToFor(23), amount: "10000" },
      ];
      await seed(listings);
      for (const d of [20, 10, 1]) await history({ url: listings[0].url, payTo: payToFor(23), daysAgo: d });
      const w = wall(listings);
      await run(w);
      assert.ok(paidUrls(w).includes(listings[1].url));
      assert.deepEqual(await poolRows(), [], "no share of the unproven pool is taken");
    });

    await t.test("予約だけ (5): 隣のドメインの配達と、受取先と登録ドメインの混算では実績にならない", async () => {
      resetCaps();
      process.env.L1_UNPROVEN_PURCHASE_CAP_USD = "1";
      const target: Listing = { url: "https://ab.io/one-dollar", payTo: payToFor(24), amount: "1000000" };
      const neighbor: Listing = { url: "https://cab.io/old", payTo: payToFor(25), amount: "1000" };
      await seed([target, neighbor]);
      for (const d of [20, 10, 1]) await history({ url: neighbor.url, payTo: payToFor(25), daysAgo: d });
      let w = wall([target, neighbor]);
      await run(lowerAfterSelect(w, "L1_UNPROVEN_PURCHASE_CAP_USD", "0.1"));
      assert.equal(paidUrls(w).includes(target.url), false, "cab.io does not prove ab.io");

      resetCaps();
      process.env.L1_UNPROVEN_PURCHASE_CAP_USD = "1";
      const other: Listing = { url: "https://elsewhere.example.net/old", payTo: payToFor(24), amount: "1000" };
      const sibling: Listing = { url: "https://sub.ab.io/old", payTo: payToFor(26), amount: "1000" };
      await seed([target, other, sibling]);
      for (const d of [20, 10]) await history({ url: other.url, payTo: payToFor(24), daysAgo: d });
      await history({ url: sibling.url, payTo: payToFor(26), daysAgo: 5 });
      w = wall([target, other, sibling]);
      await run(lowerAfterSelect(w, "L1_UNPROVEN_PURCHASE_CAP_USD", "0.1"));
      assert.equal(paidUrls(w).includes(target.url), false, "two payee days and one domain day are not three");
    });

    await t.test("予約だけ (6): 前日の行を今日の枠に数えない。今日の支出は今日の行に載る", async () => {
      resetCaps();
      const listings: Listing[] = [{ url: "https://next-day.vercel.app/x", payTo: payToFor(27), amount: "100000" }];
      await seed(listings);
      await db.execute(sql`INSERT INTO x402_l1_spend_pool_daily (day, pool, spent_units) VALUES ((now() AT TIME ZONE 'utc')::date - 1, 'unproven', 3000000)`);
      const w = wall(listings);
      const s = await run(w);
      assert.deepEqual(paidUrls(w), [listings[0].url]);
      assert.equal(s.unprovenPoolClosed, false);
      const today = rows(await db.execute(sql`SELECT spent_units::text AS s FROM x402_l1_spend_pool_daily WHERE pool = 'unproven' AND day = (now() AT TIME ZONE 'utc')::date`));
      assert.equal(today.length, 1, "today's row exists");
      assert.equal(BigInt(String(today[0].s).split(".")[0]), 100_000n);
      const yesterday = rows(await db.execute(sql`SELECT spent_units::text AS s FROM x402_l1_spend_pool_daily WHERE pool = 'unproven' AND day = (now() AT TIME ZONE 'utc')::date - 1`));
      assert.equal(BigInt(String(yesterday[0].s).split(".")[0]), 3_000_000n);
    });

    for (const viaReservation of [false, true]) {
      await t.test(`無料の共有ドメインは登録ドメインの実績に数えない（${viaReservation ? "予約" : "候補 SQL"}）`, async () => {
        resetCaps();
        if (viaReservation) process.env.L1_UNPROVEN_PURCHASE_CAP_USD = "1";
        const suffixes = ["trycloudflare.com", "nip.io", "sslip.io", "duckdns.org", "ts.net"];
        const olds = suffixes.map((suf, i): Listing => ({ url: `https://old.${suf}/seed`, payTo: payToFor(30 + i), amount: "1000" }));
        const fresh = suffixes.map((suf, i): Listing => ({ url: `https://fresh.${suf}/x`, payTo: payToFor(40 + i), amount: "1000000" }));
        await seed([...olds, ...fresh]);
        for (const o of olds) for (const d of [20, 10, 1]) await history({ url: o.url, payTo: o.payTo, daysAgo: d });
        const w = wall([...olds, ...fresh]);
        const s = await run(viaReservation ? lowerAfterSelect(w, "L1_UNPROVEN_PURCHASE_CAP_USD", "0.1") : w);
        assert.deepEqual(paidUrls(w).filter((u) => fresh.some((f) => f.url === u)), [], "new hosts do not inherit the suffix");
        if (!viaReservation) {
          assert.equal(w.seen.filter((c) => fresh.some((f) => f.url === c.url)).length, 0, "the candidate read already leaves them out");
          assert.equal(s.unprovenPriceExcluded, 5);
        }
        const l = await ledger();
        assert.equal(rows(await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases WHERE spent_units = '1000000'`))[0].n, 0, `spent ${l.spent}`);
      });
    }

    await t.test("共有ドメインの中でも、受取先の実績はその受取先に効く", async () => {
      resetCaps();
      const seedListing: Listing = { url: "https://mine.trycloudflare.com/seed", payTo: payToFor(50), amount: "1000" };
      const mine: Listing = { url: "https://mine.trycloudflare.com/one-dollar", payTo: payToFor(50), amount: "1000000" };
      await seed([seedListing, mine]);
      for (const d of [20, 10, 1]) await history({ url: seedListing.url, payTo: payToFor(50), daysAgo: d });
      const w = wall([seedListing, mine]);
      await run(w);
      assert.ok(paidUrls(w).includes(mine.url));
    });

    await t.test("共有ドメインの一覧", async () => {
      const { NO_DOMAIN_TRACK_RECORD, POOLED_SUFFIXES } = await import("@/lib/observatory/registered-domain");
      for (const s of POOLED_SUFFIXES) assert.ok(NO_DOMAIN_TRACK_RECORD.includes(s), s);
      for (const s of ["val.run", "code.run", "my.id", "net.co", "hstgr.cloud"]) assert.ok(NO_DOMAIN_TRACK_RECORD.includes(s), s);
    });

    /** 実績のある売り手を n 人置く。各自に過去の配達を 3 日ぶんと、指定の額の出品を 1 つ。 */
    async function provenSellers(n: number, amount: string, extra: Listing[] = []): Promise<Listing[]> {
      const seeds = Array.from({ length: n }, (_, i): Listing => ({ url: `https://seller${i}-proven.net/seed`, payTo: payToFor(100 + i), amount: "1000" }));
      const listings = Array.from({ length: n }, (_, i): Listing => ({ url: `https://seller${i}-proven.net/item`, payTo: payToFor(100 + i), amount }));
      await seed([...seeds, ...listings, ...extra]);
      for (const s of seeds) for (const d of [20, 10, 1]) await history({ url: s.url, payTo: s.payTo, daysAgo: d });
      return listings;
    }
    const overDimeRow = async () => {
      const r = rows(await db.execute(sql`SELECT spent_units::text AS s FROM x402_l1_spend_pool_daily WHERE pool = 'over_dime' AND day = (now() AT TIME ZONE 'utc')::date`));
      return r.length === 0 ? 0n : BigInt(String(r[0].s).split(".")[0]);
    };
    const overDimeLedger = async () =>
      BigInt(String(rows(await db.execute(sql`SELECT coalesce(sum(spent_units::numeric) FILTER (WHERE spent_units::numeric > 100000), 0)::text AS s FROM x402_l1_purchases WHERE attempted_at >= date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc'`))[0].s).split(".")[0]);

    await t.test("$0.10 超の日次枠: 実績のある売り手でも $15 で止まり、行を書かず、安い買い物は続く", async () => {
      resetCaps();
      const cheap: Listing = { url: "https://seller0-proven.net/dime", payTo: payToFor(100), amount: "100000" };
      const listings = await provenSellers(20, "1000000", [cheap]);
      const w = wall([...listings, cheap, ...Array.from({ length: 20 }, (_, i): Listing => ({ url: `https://seller${i}-proven.net/seed`, payTo: payToFor(100 + i), amount: "1000" }))]);
      const s = await run(w);
      assert.equal(await overDimeLedger(), 15_000_000n);
      assert.equal(await overDimeRow(), 15_000_000n, "counter row matches the ledger");
      assert.equal(s.overDimePoolClosed, true);
      assert.ok(s.overDimeCapped >= 1, `overDimeCapped=${s.overDimeCapped}`);
      assert.equal(s.settleFailed, 0);
      assert.equal(s.budgetDenied, 0);
      assert.ok(paidUrls(w).includes(cheap.url), "exactly $0.10 is outside the pool and still bought");
      assert.equal(rows(await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases WHERE amount_units = '1000000'`))[0].n, 15, "refused candidates leave no row");
      assert.equal(w.seen.filter((c) => !c.paid && listings.some((l) => l.url === c.url)).length, 16, "no 402 fetch after the pool closed");
      // 次のバッチは候補の段で外す。
      const w2 = wall(listings);
      const s2 = await run(w2);
      assert.equal(s2.overDimePoolClosed, true);
      assert.equal(w2.seen.filter((c) => listings.some((l) => l.url === c.url)).length, 0, "the next batch fetches none of them");
    });

    await t.test("$0.10 超の日次枠（予約だけ）: 数の行が無くても最初の INSERT で超えない", async () => {
      resetCaps();
      const listings = await provenSellers(1, "1000000");
      const w = wall(listings);
      const s = await run(lowerAfterSelect(w, "L1_OVER_DIME_DAILY_CAP_USD", "0.5"));
      assert.equal(paidUrls(w).includes(listings[0].url), false);
      assert.equal(await overDimeRow(), 0n);
      assert.equal(s.overDimeCapped, 1);
      assert.equal(rows(await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases WHERE amount_units = '1000000'`))[0].n, 0);
    });

    await t.test("$0.10 超の日次枠（予約だけ）: 行があるとき、上限ちょうどは通り、超えれば断る", async () => {
      resetCaps();
      const listings = await provenSellers(3, "500000");
      await db.execute(sql`INSERT INTO x402_l1_spend_pool_daily (day, pool, spent_units) VALUES ((now() AT TIME ZONE 'utc')::date, 'over_dime', 500000)`);
      process.env.L1_OVER_DIME_DAILY_CAP_USD = "1";
      const w = wall(listings);
      const s = await run(w);
      assert.equal(await overDimeRow(), 1_000_000n);
      assert.equal(await overDimeLedger(), 500_000n);
      assert.equal(s.overDimeCapped >= 1, true);
    });

    await t.test("$0.10 超の日次枠: 0 で $0.10 超を買わない。前日の行は数えない", async () => {
      resetCaps();
      let listings = await provenSellers(2, "200000");
      process.env.L1_OVER_DIME_DAILY_CAP_USD = "0";
      let w = wall(listings);
      await run(w);
      assert.equal(await overDimeLedger(), 0n);
      resetCaps();
      listings = await provenSellers(1, "200000");
      await db.execute(sql`INSERT INTO x402_l1_spend_pool_daily (day, pool, spent_units) VALUES ((now() AT TIME ZONE 'utc')::date - 1, 'over_dime', 15000000)`);
      w = wall(listings);
      await run(w);
      assert.equal(await overDimeLedger(), 200_000n);
    });

    for (const [batches, cap, units] of [[2, "0.5", 500_000n], [6, "1", 1_000_000n], [12, "1.5", 1_500_000n]] as const) {
      await t.test(`$0.10 超の日次枠: 同時の ${batches} バッチで $${cap} を超えない（5 回）`, async () => {
        for (let round = 0; round < 5; round++) {
          resetCaps();
          process.env.L1_OVER_DIME_DAILY_CAP_USD = cap;
          const listings = await provenSellers(16, "250000");
          const w = wall(listings);
          await Promise.all(Array.from({ length: batches }, () => run(w)));
          const spent = await overDimeLedger();
          assert.ok(spent <= units, `round ${round}: ledger over-dime spend ${spent}`);
          assert.equal(await overDimeRow(), spent, `round ${round}: counter row equals the ledger`);
        }
        resetCaps();
      });
    }

    await t.test("実績のない売り手の 1 件の上限を上げた日は、両方の枠に数える", async () => {
      resetCaps();
      process.env.L1_UNPROVEN_PURCHASE_CAP_USD = "0.5";
      const listings: Listing[] = [{ url: "https://both-pools.vercel.app/x", payTo: payToFor(60), amount: "200000" }];
      await seed(listings);
      const w = wall(listings);
      await run(w);
      assert.deepEqual(paidUrls(w), [listings[0].url]);
      assert.equal(await overDimeRow(), 200_000n);
      assert.equal(await poolSpent(), 200_000n);
      resetCaps();
    });

    await t.test("枠の表が無いと買わず、cron の応答で分かる", async () => {
      resetCaps();
      const listings = subdomainListings(3, "10000");
      await seed(listings);
      await db.execute(sql`ALTER TABLE x402_l1_spend_pool_daily RENAME TO x402_l1_spend_pool_daily_hidden`);
      try {
        const w = wall(listings);
        const s = await run(w);
        assert.equal(s.disabledReason, "spend_pool_table_missing");
        assert.equal(w.seen.length, 0, "no request goes out");
        assert.equal(s.attempted, 0);
        assert.equal((await ledger()).rows, 0);
      } finally {
        await db.execute(sql`ALTER TABLE x402_l1_spend_pool_daily_hidden RENAME TO x402_l1_spend_pool_daily`);
      }
      const w = wall(listings);
      const s = await run(w);
      assert.equal(s.disabledReason, null);
      assert.equal(s.attempted, 3);
    });

    await t.test("公開の要約に数を出さない", () => {
      const pub = publicL1Summary({ unprovenCapped: 3, unprovenPriceExcluded: 4, unprovenPoolClosed: true, overDimeCapped: 5, overDimePoolClosed: true } as never) as Record<string, unknown>;
      assert.equal("unprovenCapped" in pub, false);
      assert.equal("unprovenPriceExcluded" in pub, false);
      assert.equal("unprovenPoolClosed" in pub, false);
      assert.equal("overDimeCapped" in pub, false);
      assert.equal("overDimePoolClosed" in pub, false);
    });
  });
}
