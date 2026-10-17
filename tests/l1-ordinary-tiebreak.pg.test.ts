// ============================================================
// 通常候補の同点の決め手（2026-10-17）— l1-runner.ts targetsSql の ORDER BY の末尾。
//
// 本番実測（10/17・読み取りのみ）: 通常候補の 18〜53 位が需要の値（payers 4・calls 4）の同じ 36 件で、
// 1 回の実行が買う通常候補は中央値 33 件（最小 17）。ほぼ毎回、同点の途中で止まっていた。並びのキーが
// そこで尽きていたので、どれを買うかは実行計画しだい（統計の無い DB では回ごとに変わる）だった。
//
// 守ること（需要の値が同じとき）:
//  1. 未購入どうしは、カタログに最初に載った日時（first_seen_at）が古い順
//  2. 買い直しどうしは、最後に試した日時（その出品の購入行の max(attempted_at)）が古い順
//  3. それも同じなら id の小さい順（決定的）
//  4. 需要の値・未購入が先・優先ホストの順は従来どおり（決め手は最後にだけ足す）
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-ordinary-tiebreak.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const FUNDED_PAYER = async () => 1_000_000_000n;
const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 ordinary tie-break (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const DAY = 24 * 60 * 60 * 1000;

  test("L1 ordinary candidates: equal demand is broken by waiting time, then id", async (t) => {
    const { runL1Batch, SWEEP_WINDOW_DAYS } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");

    const db = getDb()!;
    const rowsOf = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];

    const KEYS = [
      "OBSERVATORY_L1_ENABLED",
      "OBSERVATORY_WALLET_PRIVATE_KEY",
      "OBSERVATORY_SOLANA_L1_ENABLED",
      "OBSERVATORY_ARC_L1_ENABLED",
      "OBSERVATORY_TEMPO_L1_ENABLED",
      "OBSERVATORY_CELO_L1_ENABLED",
      "L1_LANE_FLOOR_PER_RUN",
      "OBSERVATORY_L1_CENSUS",
      "OBSERVATORY_L1_RETEST_LISTINGS",
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
    for (const k of KEYS.slice(2)) delete process.env[k]; // 主候補だけ（レーン枠・census・retest なし）

    type Listing = { url: string; demand: "high" | "low"; firstSeenDaysAgo: number; pastDaysAgo?: number[] };
    const payTo = (i: number) => `0x${((i % 15) + 1).toString(16).repeat(40)}`;
    const challengeFor = (url: string, listings: Listing[]) => {
      const i = listings.findIndex((l) => l.url === url);
      return JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: BASE_USDC, payTo: payTo(i), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
      });
    };
    let txSeq = 0;
    const wall = (listings: Listing[]) => {
      const paid: string[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (!(headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT"))) {
          return new Response(challengeFor(url, listings), { status: 402, headers: { "content-type": "application/json" } });
        }
        paid.push(url);
        txSeq++;
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({ success: true, transaction: `0x${(0xcafe0000 + txSeq).toString(16).padStart(64, "0")}`, network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" }),
            ).toString("base64"),
          },
        });
      };
      return { paid, fetchImpl };
    };
    const idOf = async (url: string) => String(rowsOf(await db.execute(sql`SELECT id FROM x402_endpoints WHERE resource_url = ${url}`))[0].id);

    async function seed(listings: Listing[]) {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      const items = listings.map((l, i) =>
        parseCatalogItem({
          resource: l.url,
          accepts: [{ amount: "1000", asset: BASE_USDC, network: "eip155:8453", payTo: payTo(i) }],
          extensions: { bazaar: { info: { input: { method: "GET" } } } },
          quality: l.demand === "high" ? { l30DaysTotalCalls: 5000, l30DaysUniquePayers: 500 } : { l30DaysTotalCalls: 10, l30DaysUniquePayers: 1 },
        }),
      );
      await syncCatalog({ fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true }, today: "2026-10-17" });
      await runL0ProbeBatch({
        limit: 200,
        concurrency: 4,
        fetchImpl: async (url: string) => new Response(challengeFor(url, listings), { status: 402, headers: { "content-type": "application/json" } }),
      });
      for (const l of listings) {
        const id = await idOf(l.url);
        await db.execute(sql`UPDATE x402_endpoints SET first_seen_at = ${new Date(Date.now() - l.firstSeenDaysAgo * DAY).toISOString()}::timestamptz WHERE id = ${id}::uuid`);
        for (const d of l.pastDaysAgo ?? []) {
          await db.insert(schema.x402L1Purchases).values({
            endpointId: id,
            status: "settled",
            payer: "0x0000000000000000000000000000000000000001",
            network: "eip155:8453",
            asset: BASE_USDC,
            payTo: payTo(listings.indexOf(l)),
            amountUnits: "1000",
            spentUnits: "1000",
            httpStatusPaid: 200,
            attemptedAt: new Date(Date.now() - d * DAY),
            rawResponseMeta: { phase: "paid" },
          });
        }
      }
    }
    const run = (listings: Listing[], limit: number) => {
      const w = wall(listings);
      return runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit, fetchImpl: w.fetchImpl }).then((summary) => ({ summary, paid: w.paid }));
    };

    await t.test("前提: 買い直しの行は掃引窓の外（SWEEP_WINDOW_DAYS より古い）", () => {
      assert.ok(SWEEP_WINDOW_DAYS < 20, `fixture の買い直しは 20〜40 日前: SWEEP_WINDOW_DAYS = ${SWEEP_WINDOW_DAYS}`);
    });

    await t.test("未購入どうし: カタログに最初に載った日時が古い順（並べた順・id とは無関係）", async () => {
      // 載せる順と first_seen_at の順をずらす（物理順で通ってしまわないように）。
      const listings: Listing[] = [
        { url: "https://n3.example/api", demand: "low", firstSeenDaysAgo: 30 },
        { url: "https://n6.example/api", demand: "low", firstSeenDaysAgo: 5 },
        { url: "https://n1.example/api", demand: "low", firstSeenDaysAgo: 50 },
        { url: "https://n5.example/api", demand: "low", firstSeenDaysAgo: 10 },
        { url: "https://n2.example/api", demand: "low", firstSeenDaysAgo: 40 },
        { url: "https://n4.example/api", demand: "low", firstSeenDaysAgo: 20 },
        { url: "https://hd.example/api", demand: "high", firstSeenDaysAgo: 1 },
      ];
      await seed(listings);
      const { paid } = await run(listings, 4);
      assert.deepEqual(paid, ["https://hd.example/api", "https://n1.example/api", "https://n2.example/api", "https://n3.example/api"], "需要が先、同点は古い順");
      const second = await run(listings, 4);
      assert.deepEqual(second.paid, ["https://n4.example/api", "https://n5.example/api", "https://n6.example/api"], "残りも古い順");
    });

    await t.test("買い直しどうし: 最後に試した日時が古い順（最初の購入の日時ではない）。未購入が先なのは従来どおり", async () => {
      const listings: Listing[] = [
        { url: "https://r2.example/api", demand: "low", firstSeenDaysAgo: 60, pastDaysAgo: [30] },
        { url: "https://r4.example/api", demand: "low", firstSeenDaysAgo: 90, pastDaysAgo: [80, 20] }, // 最初は一番古いが、最後は 20 日前
        { url: "https://r1.example/api", demand: "low", firstSeenDaysAgo: 10, pastDaysAgo: [40] },
        { url: "https://r3.example/api", demand: "low", firstSeenDaysAgo: 70, pastDaysAgo: [25] },
        { url: "https://nn.example/api", demand: "low", firstSeenDaysAgo: 1 },
      ];
      await seed(listings);
      const { paid } = await run(listings, 3);
      assert.deepEqual(paid, ["https://nn.example/api", "https://r1.example/api", "https://r2.example/api"], "未購入 → 最後の購入が 40 日前 → 30 日前");
      const second = await run(listings, 3);
      assert.deepEqual(second.paid, ["https://r3.example/api", "https://r4.example/api"], "25 日前 → 20 日前（r4 の 80 日前の行は見ない）");
    });

    await t.test("待った時間も同じなら id の小さい順", async () => {
      const listings: Listing[] = ["https://e1.example/api", "https://e2.example/api", "https://e3.example/api", "https://e4.example/api", "https://e5.example/api"].map(
        (url) => ({ url, demand: "low" as const, firstSeenDaysAgo: 7 }),
      );
      await seed(listings);
      // seed の後で first_seen_at を同じ瞬間にそろえる（Date.now() の呼び出しごとのずれを消す）。
      await db.execute(sql`UPDATE x402_endpoints SET first_seen_at = now() - interval '7 days'`);
      const byId = rowsOf(await db.execute(sql`SELECT resource_url FROM x402_endpoints ORDER BY id`)).map((r) => String(r.resource_url));
      const { paid } = await run(listings, 2);
      assert.deepEqual(paid, byId.slice(0, 2));
    });
  });
}
