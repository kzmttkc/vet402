// ============================================================
// L1 の買い直し間隔と、初回購入の日次枠（2026-09-16）。
//
// 実測（公開台帳 export.csv?days=30・2026-09-16）: 30 日で $83.81・成立 2,639 件。
// うち初回購入が 55.5%（$46.54）、2 回目以降の買い直しが 44%（$37.27）。
// カタログは増え続けるので、全件 6 日間隔のままだと買い直しだけが積み上がる。
//
// 守ること:
//  1. 成立（status='settled'）が 3 件以上溜まったエンドポイントは、証拠として
//     もう足りている。買い直しは 30 日間隔（MATURE_SWEEP_WINDOW_DAYS）へ延びる。
//  2. 優先売り手（PRIORITY_SELLER_HOSTS）は成熟しても 1 日間隔のまま。時系列の
//     密度が堀そのものなので、ここは延ばさない。
//  3. 「成熟」は status='settled' だけで数える。settle_failed を数えると、
//     決済しない売り手ほど測られなくなる（逆向きの誘因）。
//  4. その UTC 日の初回購入が FIRST_PURCHASE_DAILY_QUOTA 件に達したら、未購入の
//     エンドポイントは候補から外す。買い直しは同じバッチでも続く。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_prep_0917 \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-sweep-cadence.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 sweep cadence (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const payToFor = (n: number) => `0x${String(n).repeat(40).slice(0, 40)}`;

  /** 実在ホストは api.exa.ai だけ（PRIORITY_SELLER_HOSTS の 1 つ）。壁は全て stub。 */
  const EP = {
    mature: { url: "https://mature.example/api", n: 1 },
    fresh: { url: "https://fresh.example/api", n: 2 },
    failed: { url: "https://failed.example/api", n: 3 },
    priority: { url: "https://api.exa.ai/search", n: 4 },
    newbie: { url: "https://newbie.example/api", n: 5 },
    repeat: { url: "https://repeat.example/api", n: 6 },
  } as const;
  type EpKey = keyof typeof EP;
  const nByUrl = new Map<string, number>(Object.values(EP).map((e) => [e.url, e.n]));

  test("L1 sweep cadence", async (t) => {
    const { runL1Batch, FIRST_PURCHASE_DAILY_QUOTA } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");

    const db = getDb()!;
    const rowsOf = (raw: unknown) =>
      (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<
        string,
        unknown
      >[];

    const saved = {
      l1: process.env.OBSERVATORY_L1_ENABLED,
      pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY,
      sol: process.env.OBSERVATORY_SOLANA_L1_ENABLED,
    };
    const restore = (k: string, v: string | undefined) =>
      v === undefined ? delete process.env[k] : (process.env[k] = v);
    t.after(() => {
      restore("OBSERVATORY_L1_ENABLED", saved.l1);
      restore("OBSERVATORY_WALLET_PRIVATE_KEY", saved.pk);
      restore("OBSERVATORY_SOLANA_L1_ENABLED", saved.sol);
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    delete process.env.OBSERVATORY_SOLANA_L1_ENABLED; // Base だけを測る

    const itemFor = (url: string, n: number) =>
      parseCatalogItem({
        resource: url,
        accepts: [{ amount: "3000", asset: BASE_USDC, network: "eip155:8453", payTo: payToFor(n) }],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        quality: { l30DaysTotalCalls: 100, l30DaysUniquePayers: 10 },
      });

    const challengeFor = (url: string) => {
      const n = nByUrl.get(url.replace(/\/+$/, "")) ?? 1;
      return JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "3000",
            asset: BASE_USDC,
            payTo: payToFor(n),
            maxTimeoutSeconds: 300,
            extra: { name: "USD Coin", version: "2" },
          },
        ],
      });
    };

    /** 402 → 支払い付きリトライは 200。どの URL へ支払い付きで出たかを記録する。 */
    const wall = () => {
      const seen: { url: string; paid: boolean }[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
        seen.push({ url, paid });
        if (!paid)
          return new Response(challengeFor(url), {
            status: 402,
            headers: { "content-type": "application/json" },
          });
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({
                success: true,
                transaction: `0x${"ab".repeat(32)}`,
                network: "eip155:8453",
                payer: "0x0000000000000000000000000000000000000001",
              }),
            ).toString("base64"),
          },
        });
      };
      return { seen, fetchImpl };
    };

    async function seed(keys: EpKey[]) {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      const items = keys.map((k) => itemFor(EP[k].url, EP[k].n));
      await syncCatalog({
        fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true },
        today: "2026-09-16",
      });
      await runL0ProbeBatch({
        limit: 20,
        concurrency: 2,
        fetchImpl: async (url: string) =>
          new Response(challengeFor(url), {
            status: 402,
            headers: { "content-type": "application/json" },
          }),
      });
    }

    const endpointIdOf = async (url: string) => {
      const raw = await db.execute(sql`SELECT id FROM x402_endpoints WHERE resource_url = ${url}`);
      const id = rowsOf(raw)[0]?.id;
      assert.ok(typeof id === "string", `endpoint not seeded: ${url}`);
      return id as string;
    };

    /** 過去の台帳行を置く。daysAgo は「何日前の試行か」。 */
    async function history(key: EpKey, rows: { status: string; daysAgo: number }[]) {
      const id = await endpointIdOf(EP[key].url);
      for (const r of rows) {
        await db.execute(sql`
          INSERT INTO x402_l1_purchases
            (endpoint_id, attempted_at, status, payer, network, asset, pay_to, amount_units, spent_units)
          VALUES (${id}::uuid, now() - make_interval(days => ${r.daysAgo}), ${r.status},
                  '0x0000000000000000000000000000000000000001', 'eip155:8453', ${BASE_USDC},
                  ${payToFor(EP[key].n)}, '3000', '3000')`);
      }
    }

    /**
     * 「その日が初回購入だったエンドポイント」を count 件ぶん作る。endpoint_id に
     * 外部キーは無いので、枠を数える側の条件（min(attempted_at)）だけを再現する。
     * spent_units は 0 — 日次予算ではなく枠だけを試す。
     */
    async function fillFirstPurchases(count: number, when: "today" | "yesterday") {
      const at =
        when === "today"
          ? sql`(date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc') + interval '1 second'`
          : sql`(date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc') - interval '1 hour'`;
      await db.execute(sql`
        INSERT INTO x402_l1_purchases
          (endpoint_id, attempted_at, status, payer, network, asset, pay_to, amount_units, spent_units)
        SELECT gen_random_uuid(), ${at}, 'settled',
               '0x0000000000000000000000000000000000000001', 'eip155:8453', ${BASE_USDC},
               '0x0000000000000000000000000000000000000002', '0', '0'
        FROM generate_series(1, ${count})`);
    }

    const ledgerFor = async (key: EpKey) => {
      const raw = await db.execute(sql`
        SELECT pu.status FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE e.resource_url = ${EP[key].url} ORDER BY pu.attempted_at`);
      return rowsOf(raw).map((r) => String(r.status));
    };

    const paidTo = (seen: { url: string; paid: boolean }[], key: EpKey) =>
      seen.some((s) => s.url.startsWith(EP[key].url) && s.paid);

    const run = async () => {
      const w = wall();
      const summary = await runL1Batch({ limit: 50, fetchImpl: w.fetchImpl });
      return { ...w, summary };
    };

    // ---- C1: 成立 3 件は 30 日窓 ----
    await t.test("C1 成立 3 件: 7 日後も 29 日後も選ばれず、31 日後に選ばれる", async () => {
      for (const [daysAgo, expected] of [
        [7, false],
        [29, false],
        [31, true],
      ] as const) {
        await seed(["mature"]);
        await history("mature", [
          { status: "settled", daysAgo: daysAgo + 9 },
          { status: "settled", daysAgo: daysAgo + 4 },
          { status: "settled", daysAgo },
        ]);
        const before = (await ledgerFor("mature")).length;
        const w = await run();
        assert.equal(
          paidTo(w.seen, "mature"),
          expected,
          `最後の購入から ${daysAgo} 日: 支払い付きリクエスト ${expected ? "あり" : "なし"} のはず`,
        );
        assert.equal(
          (await ledgerFor("mature")).length > before,
          expected,
          `最後の購入から ${daysAgo} 日: 台帳の行 ${expected ? "増える" : "増えない"} のはず`,
        );
      }
    });

    // ---- C2: 成立 2 件は従来の 6 日窓 ----
    await t.test("C2 成立 2 件: 7 日経てば従来どおり買い直す", async () => {
      await seed(["fresh"]);
      await history("fresh", [
        { status: "settled", daysAgo: 20 },
        { status: "settled", daysAgo: 7 },
      ]);
      const w = await run();
      assert.ok(paidTo(w.seen, "fresh"), "6 日窓のまま——支払い付きで買い直す");
      assert.equal((await ledgerFor("fresh")).length, 3, "台帳に 1 行増える");
    });

    // ---- C3: settle_failed は「成熟」に数えない ----
    await t.test("C3 settle_failed が 5 件でも成熟扱いにしない（settled だけを数える）", async () => {
      await seed(["failed"]);
      await history("failed", [
        { status: "settle_failed", daysAgo: 12 },
        { status: "settle_failed", daysAgo: 11 },
        { status: "settle_failed", daysAgo: 10 },
        { status: "settle_failed", daysAgo: 9 },
        { status: "settle_failed", daysAgo: 8 },
        // 直近 3 件が全て非決済だと冷却期間（NON_SETTLING_COOLDOWN_STREAK）で
        // 外れてしまい、窓の検証にならない。最新の 1 件だけ決済主張ありにする。
        { status: "settle_claimed", daysAgo: 7 },
      ]);
      const w = await run();
      assert.ok(paidTo(w.seen, "failed"), "成立 0 件なので 6 日窓のまま——7 日後に買い直す");
      assert.equal((await ledgerFor("failed")).length, 7, "台帳に 1 行増える");
    });

    // ---- C4: 優先売り手は成熟しても 1 日窓 ----
    await t.test("C4 優先売り手は成立 5 件でも 1 日窓のまま", async () => {
      await seed(["priority"]);
      await history("priority", [
        { status: "settled", daysAgo: 10 },
        { status: "settled", daysAgo: 8 },
        { status: "settled", daysAgo: 6 },
        { status: "settled", daysAgo: 4 },
        { status: "settled", daysAgo: 2 },
      ]);
      const w = await run();
      assert.ok(paidTo(w.seen, "priority"), "優先売り手は 2 日前に買っていても今日また買う");
      assert.equal((await ledgerFor("priority")).length, 6, "台帳に 1 行増える");
    });

    // ---- C5: 初回購入の日次枠 ----
    await t.test("C5 初回購入が枠に達したら未購入は候補から外れ、買い直しは続く", async () => {
      await seed(["newbie", "repeat"]);
      await history("repeat", [{ status: "settled", daysAgo: 7 }]);
      await fillFirstPurchases(FIRST_PURCHASE_DAILY_QUOTA, "today");
      const w = await run();
      assert.ok(!paidTo(w.seen, "newbie"), "未購入のエンドポイントへ支払い付きで出さない");
      assert.deepEqual(await ledgerFor("newbie"), [], "行を書かない（翌日また候補になる）");
      assert.ok(paidTo(w.seen, "repeat"), "購入履歴のあるエンドポイントの買い直しは同じバッチで続く");
      assert.equal((await ledgerFor("repeat")).length, 2, "買い直しの行は増える");
    });

    await t.test("C5b 枠に 1 件足りなければ未購入も買う", async () => {
      await seed(["newbie"]);
      await fillFirstPurchases(FIRST_PURCHASE_DAILY_QUOTA - 1, "today");
      const w = await run();
      assert.ok(paidTo(w.seen, "newbie"), "枠が残っていれば初回購入は止めない");
      assert.equal((await ledgerFor("newbie")).length, 1);
    });

    // ---- C6: 枠は UTC 日で切り替わる ----
    await t.test("C6 前日の初回購入は翌日の枠を食わない", async () => {
      await seed(["newbie"]);
      await fillFirstPurchases(FIRST_PURCHASE_DAILY_QUOTA + 10, "yesterday");
      const w = await run();
      assert.ok(paidTo(w.seen, "newbie"), "前日の 130 件は今日の枠に数えない");
      assert.equal((await ledgerFor("newbie")).length, 1, "今日の初回購入として 1 行");
    });
  });
}
