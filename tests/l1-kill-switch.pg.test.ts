// ============================================================
// 2026-09-05 監査 P0: 停止スイッチが**実際に金を止める**ことの実測。
//
// 純関数の分岐は tests/l1-kill-switch.test.ts。ここで確かめるのは配線:
//   1. バッチ開始時に halt が立っていれば 1 リクエストも出さない・1 行も書かない
//   2. halt が下りていれば従来どおり買える（関門が常時閉じていない証明）
//   3. **バッチ途中で halt が立ったらそこで止まる**（次の候補は署名しない）
//   4. **予約の後・署名の直前で halt が立っても署名しない**——予約を
//      `halted` / spent_units=0 へ倒して返す。ここは「1 円も動いていないのに
//      日次 $25 の観測予算だけが減る」を作らないための分岐でもある。
//
// 4 の再現には「reserveSpend の INSERT と署名の間」でフラグを立てる必要がある。
// 本番コードにテスト専用の穴を空けたくないので、テスト DB 側の AFTER INSERT
// トリガで立てる——通るのは製品コードの実経路だけになる。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-kill-switch.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 kill switch (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  // TRUNCATE より前に、接続先が本番（Neon）でないことを機械で確かめる（2026-09-04 監査 D・P2）。
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const payToFor = (n: string | number) => `0x${String(n).repeat(40).slice(0, 40)}`;

  test("L1 停止スイッチ", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { setSpendingHalt, SPENDING_HALT_FLAG } = await import("@/lib/observatory/kill-switch");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");

    // runtime_flags は schema.ts にある（`npm run db:push` で作られる）。
    const db = getDb()!;
    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases, runtime_flags`,
    );

    const savedEnabled = process.env.OBSERVATORY_L1_ENABLED;
    const savedKey = process.env.OBSERVATORY_WALLET_PRIVATE_KEY;
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    t.after(async () => {
      if (savedEnabled === undefined) delete process.env.OBSERVATORY_L1_ENABLED;
      else process.env.OBSERVATORY_L1_ENABLED = savedEnabled;
      if (savedKey === undefined) delete process.env.OBSERVATORY_WALLET_PRIVATE_KEY;
      else process.env.OBSERVATORY_WALLET_PRIVATE_KEY = savedKey;
      await db.execute(sql`TRUNCATE runtime_flags`);
    });

    const mk = (n: number, calls: number) =>
      parseCatalogItem({
        resource: `https://seller${n}.example/api`,
        accepts: [
          { amount: "3000", asset: BASE_USDC, network: "eip155:8453", payTo: payToFor(n) },
        ],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        quality: { l30DaysTotalCalls: calls, l30DaysUniquePayers: Math.ceil(calls / 10) },
      });
    await syncCatalog({
      fetchResult: { items: [mk(1, 900), mk(2, 100)], totalCount: 2, fetchedCount: 2, complete: true },
      today: "2026-09-05",
    });

    const challengeFor = (url: string) => {
      const n = /seller(\d)/.exec(url)?.[1] ?? "1";
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
    await runL0ProbeBatch({
      limit: 10,
      concurrency: 2,
      fetchImpl: async (url: string) =>
        new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } }),
    });

    /** 402 → 有料リトライは 200＋レシート。onPaid で「有料リクエストを見た瞬間」に割り込める。 */
    const wall = (onPaid?: (url: string) => Promise<void>) => {
      const seen: { url: string; paid: boolean }[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
        seen.push({ url, paid });
        if (!paid) {
          return new Response(challengeFor(url), {
            status: 402,
            headers: { "content-type": "application/json" },
          });
        }
        if (onPaid) await onPaid(url);
        return new Response(JSON.stringify({ data: "the goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({
                success: true,
                transaction: "0xdeadbeef00000000000000000000000000000000000000000000000000000000",
                network: "eip155:8453",
                payer: "0xf39F",
              }),
            ).toString("base64"),
          },
        });
      };
      return { seen, fetchImpl };
    };

    const ledger = async () => {
      const raw = await db.execute(sql`
        SELECT pu.status, pu.spent_units, e.resource_url
        FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        ORDER BY pu.attempted_at ASC, e.resource_url ASC
      `);
      return ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<
        string,
        unknown
      >[]).map((r) => ({
        status: String(r.status),
        spent: String(r.spent_units),
        seller: String(r.resource_url),
      }));
    };
    const clearLedger = () => db.execute(sql`TRUNCATE x402_l1_purchases`);

    await t.test("halt が立っていればバッチは 1 リクエストも出さない", async () => {
      await clearLedger();
      await setSpendingHalt({
        enabled: true,
        reason: "audit: suspicious payout",
        updatedBy: "test",
      });
      const { seen, fetchImpl } = wall();
      const summary = await runL1Batch({ fetchImpl });
      assert.equal(summary.halted, true);
      assert.equal(summary.disabledReason, "spending_halted");
      assert.match(String(summary.haltReason), /suspicious payout/);
      assert.equal(summary.attempted, 0);
      assert.equal(seen.length, 0, "停止中に外へ 1 本でも出したら関門が無いのと同じ");
      assert.deepEqual(await ledger(), []);
    });

    await t.test("halt を下ろせば従来どおり買える（関門が閉じっぱなしでない）", async () => {
      await clearLedger();
      await setSpendingHalt({ enabled: false, reason: "resumed", updatedBy: "test" });
      const { seen, fetchImpl } = wall();
      const summary = await runL1Batch({ fetchImpl, limit: 1 });
      assert.equal(summary.halted, false);
      assert.equal(summary.attempted, 1);
      assert.equal(summary.settled, 1);
      assert.ok(seen.some((s) => s.paid), "署名済みリクエストが出ている");
      const rows = await ledger();
      assert.equal(rows.length, 1);
      // 購入直後は settle_claimed（照合 cron がオンチェーンで確認して settled になる）。
      assert.ok(
        ["settled", "settle_claimed"].includes(rows[0].status),
        `支払い済みの status を期待: ${rows[0].status}`,
      );
      assert.equal(rows[0].spent, "3000", "署名したぶんは日次予算を食う");
    });

    await t.test("バッチ途中で halt が立つと、次の候補は署名されない", async () => {
      await clearLedger();
      await setSpendingHalt({ enabled: false, reason: "resumed", updatedBy: "test" });
      // seller1 の有料リクエストを見た瞬間に運用者が止めた、という形。
      const { seen, fetchImpl } = wall(async () => {
        await setSpendingHalt({ enabled: true, reason: "operator pulled the cord", updatedBy: "test" });
      });
      const summary = await runL1Batch({ fetchImpl, limit: 2 });
      assert.equal(summary.attempted, 1, "1 件目は飛行中なので最後まで記帳する");
      assert.equal(summary.halted, true);
      assert.match(String(summary.haltReason), /pulled the cord/);
      const paidSellers = seen.filter((s) => s.paid).map((s) => s.url);
      assert.equal(paidSellers.length, 1, "2 件目に署名を出してはいけない");
      assert.ok(paidSellers[0].includes("seller1"));
      const rows = await ledger();
      const halted = rows.filter((r) => r.status === "halted");
      assert.equal(halted.length, 1, "止めた事実は台帳に残す（黙って飛ばさない）");
      assert.equal(halted[0].spent, "0", "署名していないので予算を消費しない");
      assert.ok(halted[0].seller.includes("seller2"));
    });

    await t.test("予約の後・署名の直前で halt が立っても署名しない（予約は 0 に戻す）", async () => {
      await clearLedger();
      await setSpendingHalt({ enabled: false, reason: "resumed", updatedBy: "test" });
      // reserveSpend の INSERT と署名の間で立てる唯一の手段（本番コードに穴を空けない）。
      // 関数本体は $1 を受け取れない（プレースホルダを型解決できない）ので、
      // フラグ名は定数から組み立てた生 SQL で埋める。
      await db.execute(
        sql.raw(`
        CREATE OR REPLACE FUNCTION ks_flip_halt() RETURNS trigger AS $ks$
        BEGIN
          UPDATE runtime_flags SET enabled = true, reason = 'flipped between reserve and sign'
          WHERE name = '${SPENDING_HALT_FLAG}';
          RETURN NULL;
        END $ks$ LANGUAGE plpgsql
      `),
      );
      await db.execute(sql`
        CREATE TRIGGER ks_flip_halt_trg AFTER INSERT ON x402_l1_purchases
        FOR EACH ROW EXECUTE FUNCTION ks_flip_halt()
      `);
      try {
        const { seen, fetchImpl } = wall();
        const summary = await runL1Batch({ fetchImpl, limit: 1 });
        assert.equal(seen.filter((s) => s.paid).length, 0, "署名済みリクエストが 1 本も出ていないこと");
        assert.equal(summary.attempted, 0);
        assert.equal(summary.halted, true);
        const rows = await ledger();
        assert.equal(rows.length, 1, "予約行は残す（消さない——何が起きたかの記録）");
        assert.equal(rows[0].status, "halted");
        assert.equal(rows[0].spent, "0", "署名していない予約は日次予算を食わない");
      } finally {
        await db.execute(sql`DROP TRIGGER IF EXISTS ks_flip_halt_trg ON x402_l1_purchases`);
      }
    });
  });
}
