// ============================================================
// L1 の XRPL レーン（2026-09-17）——フラグ・別枠・残高の関門・支払い付きリクエストの形。
//
// 守ること:
//  1. OBSERVATORY_XRPL_L1_ENABLED が "true" でなければ、XRPL の候補には 1 リクエストも出さず行も書かない。
//  2. 有効なら、支払い付きリクエストは PAYMENT-SIGNATURE を運び、payload.signedTxBlob が decode できる
//     RLUSD Payment。行には network / asset / pay_to / amount_units（"0.01" → 10000）/ auth_nonce（blob の hash）。
//  3. その UTC 日の XRPL 支出が別枠（既定 $2）に達したら XRPL には触れない。Base は買う。
//     残りが 1 件分に足りないときは予約で断り、行を書かない。
//  4. 購入元の RLUSD が足りない／XRP が手数料に足りない（読み手が throw）なら署名せず、行を書かない。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-xrpl-lane.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 xrpl lane (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const payToFor = (n: string | number) => `0x${String(n).repeat(40).slice(0, 40)}`;
  const RLUSD = "524C555344000000000000000000000000000000";
  const ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

  test("L1 XRPL lane", async (t) => {
    const { Wallet, decode } = await import("xrpl");
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    // 決定的なテスト鍵（本物の資金とは無関係）。
    const xrplWallet = Wallet.fromEntropy(new Uint8Array(16).fill(9));
    const xrplPayTo = (n: number) => Wallet.fromEntropy(new Uint8Array(16).fill(40 + n)).classicAddress;

    const saved = {
      l1: process.env.OBSERVATORY_L1_ENABLED,
      pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY,
      xOn: process.env.OBSERVATORY_XRPL_L1_ENABLED,
      xSeed: process.env.OBSERVATORY_XRPL_SEED,
      cap: process.env.L1_XRPL_DAILY_CAP_USD,
    };
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    t.after(() => {
      restore("OBSERVATORY_L1_ENABLED", saved.l1);
      restore("OBSERVATORY_WALLET_PRIVATE_KEY", saved.pk);
      restore("OBSERVATORY_XRPL_L1_ENABLED", saved.xOn);
      restore("OBSERVATORY_XRPL_SEED", saved.xSeed);
      restore("L1_XRPL_DAILY_CAP_USD", saved.cap);
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    process.env.OBSERVATORY_XRPL_SEED = xrplWallet.seed!;
    delete process.env.L1_XRPL_DAILY_CAP_USD; // 既定 $2

    const xrplAccept = (n: number) => ({
      scheme: "exact",
      network: "xrpl:0",
      asset: RLUSD,
      extra: { issuer: ISSUER, invoiceId: `INV${n}`, sourceTag: 804681468 },
      payTo: xrplPayTo(n),
      amount: "0.01",
      maxTimeoutSeconds: 300,
    });
    const baseItem = (n: number) =>
      parseCatalogItem({
        resource: `https://seller${n}.example/api`,
        accepts: [{ amount: "3000", asset: BASE_USDC, network: "eip155:8453", payTo: payToFor(n) }],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        quality: { l30DaysTotalCalls: 100, l30DaysUniquePayers: 10 },
      });
    const xrplItem = (n: number) =>
      parseCatalogItem({
        resource: `https://xrplseller${n}.example/api`,
        // 実物の壁と同じく XRP の accept も並ぶ（RLUSD が選ばれる）
        accepts: [xrplAccept(n), { ...xrplAccept(n), asset: "XRP", amount: "10000", extra: { invoiceId: `INV${n}`, sourceTag: 804681468 } }],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        quality: { l30DaysTotalCalls: 5000, l30DaysUniquePayers: 500 },
      });
    const challengeDoc = (url: string) => {
      if (url.includes("xrplseller")) {
        const n = Number(/xrplseller(\d)/.exec(url)?.[1] ?? "1");
        return { x402Version: 2, accepts: [xrplAccept(n), { ...xrplAccept(n), asset: "XRP", amount: "10000", extra: { invoiceId: `INV${n}`, sourceTag: 804681468 } }] };
      }
      const n = /seller(\d)/.exec(url)?.[1] ?? "1";
      return { x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "3000", asset: BASE_USDC, payTo: payToFor(n), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }] };
    };
    const wall402 = (url: string) =>
      new Response(JSON.stringify({ error: "payment required" }), {
        status: 402,
        headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challengeDoc(url))).toString("base64") },
      });

    type Seen = { url: string; paid: boolean; header: string | null };
    const wall = () => {
      const seen: Seen[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
        seen.push({ url, paid, header: headers.get("PAYMENT-SIGNATURE") });
        if (!paid) return wall402(url);
        const n = /seller(\d)/.exec(url)?.[1] ?? "1";
        const isX = url.includes("xrplseller");
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify(
                isX
                  ? { success: true, transaction: `${n}`.padStart(64, "A"), network: "xrpl:0", payer: xrplWallet.classicAddress }
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
        fetchResult: { items: [baseItem(1), xrplItem(1), xrplItem(2), xrplItem(3)], totalCount: 4, fetchedCount: 4, complete: true },
        today: "2026-09-17",
      });
      await runL0ProbeBatch({ limit: 10, concurrency: 2, fetchImpl: async (url: string) => wall402(url) });
    }
    async function spendXrplToday(units: number) {
      const rows = await db.execute(sql`SELECT id FROM x402_endpoints WHERE resource_url = 'https://xrplseller3.example/api'`);
      const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as { id: string }[];
      await db.insert(schema.x402L1Purchases).values({
        endpointId: list[0].id,
        status: "settle_claimed",
        payer: xrplWallet.classicAddress,
        network: "xrpl:0",
        asset: RLUSD,
        payTo: xrplPayTo(3),
        amountUnits: String(units),
        spentUnits: String(units),
      });
    }
    const ledgerFor = async (resourceUrl: string) => {
      const raw = await db.execute(sql`
        SELECT pu.status, pu.network, pu.asset, pu.pay_to, pu.amount_units, pu.spent_units, pu.auth_nonce, pu.tx_hash, pu.payer
        FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE e.resource_url = ${resourceUrl}`);
      // postgres-js は Array の派生（Result）を返すので、deepEqual のために素の配列へ写す。
      return [...((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<string, string | null>[])];
    };
    const FUNDED = async () => 1_000_000_000n;
    const SIGNING = async () => ({ sequence: 7, validatedLedgerIndex: 99_000_000 });
    const l0Verdicts = async () => {
      const raw = await db.execute(sql`SELECT e.resource_url, p.verdict FROM x402_l0_probes p JOIN x402_endpoints e ON e.id = p.endpoint_id`);
      return (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { resource_url: string; verdict: string }[];
    };

    await t.test("フラグ無し: XRPL の候補には触れず行も書かない。Base は買う", async () => {
      delete process.env.OBSERVATORY_XRPL_L1_ENABLED;
      await seed();
      assert.ok((await l0Verdicts()).filter((r) => r.resource_url.includes("xrplseller")).every((r) => r.verdict === "pass"), "L0 は xrpl:0 の壁を pass にする");
      const w = wall();
      const summary = await runL1Batch({ limit: 10, fetchImpl: w.fetchImpl, getPayerUsdcBalance: FUNDED, getXrplSigningInputs: SIGNING });
      assert.ok(w.seen.every((s) => !s.url.includes("xrplseller")), "XRPL には 1 リクエストも出ない");
      assert.ok(w.seen.some((s) => s.url.includes("seller1.example") && s.paid));
      assert.ok(summary.settled >= 1);
      for (const n of [1, 2, 3]) assert.deepEqual(await ledgerFor(`https://xrplseller${n}.example/api`), []);
    });

    await t.test("有効: 支払い付きリクエストは decode できる RLUSD Payment を運び、行に 10000 units と blob の hash が残る", async () => {
      process.env.OBSERVATORY_XRPL_L1_ENABLED = "true";
      await seed();
      const w = wall();
      const summary = await runL1Batch({ limit: 10, fetchImpl: w.fetchImpl, getPayerUsdcBalance: FUNDED, getXrplSigningInputs: SIGNING });
      const paid = w.seen.filter((s) => s.url.includes("xrplseller") && s.paid);
      assert.ok(paid.length >= 1, "XRPL の候補を支払い付きで買う");
      for (const p of paid) {
        const body = JSON.parse(Buffer.from(p.header!, "base64").toString("utf8"));
        assert.equal(body.x402Version, 2);
        assert.equal(body.accepted.network, "xrpl:0");
        assert.equal(body.accepted.asset, RLUSD, "RLUSD を選ぶ（XRP ではない）");
        assert.equal(body.accepted.amount, "0.01");
        const tx = decode(body.payload.signedTxBlob) as Record<string, unknown>;
        assert.equal(tx.TransactionType, "Payment");
        assert.equal(tx.Account, xrplWallet.classicAddress);
        assert.equal(tx.Sequence, 7);
        assert.equal(tx.LastLedgerSequence, 99_000_032);
        assert.equal(tx.SourceTag, 804681468);
        assert.deepEqual(tx.Amount, { currency: RLUSD, issuer: ISSUER, value: "0.01" });
        assert.equal(typeof tx.TxnSignature, "string");
      }
      const rows = (await Promise.all([1, 2, 3].map((n) => ledgerFor(`https://xrplseller${n}.example/api`)))).flat();
      assert.ok(rows.length >= 1);
      for (const r of rows) {
        assert.equal(r.status, "settle_claimed");
        assert.equal(r.network, "xrpl:0");
        assert.equal(r.asset, RLUSD);
        assert.equal(r.amount_units, "10000");
        assert.equal(r.spent_units, "10000");
        assert.equal(r.payer, xrplWallet.classicAddress);
        assert.match(r.pay_to ?? "", /^r/);
        assert.match(r.auth_nonce ?? "", /^[0-9A-F]{64}$/, "auth_nonce は署名した blob の hash");
        assert.match(r.tx_hash ?? "", /^[0-9A-F]{64}$/);
      }
      const spent = await db.execute(sql`SELECT coalesce(sum(spent_units::numeric), 0)::text AS s FROM x402_l1_purchases WHERE network LIKE 'xrpl:%'`);
      const s = ((Array.isArray(spent) ? spent : (spent as { rows?: unknown[] }).rows ?? []) as { s: string }[])[0].s;
      assert.ok(Number(s) <= 2_000_000, `XRPL の当日支出は別枠以内 (${s})`);
      assert.ok(summary.settled >= 1);
    });

    await t.test("別枠を使い切った日は XRPL に触れず、残りが 1 件分に足りないときは予約で断って行を書かない", async () => {
      process.env.OBSERVATORY_XRPL_L1_ENABLED = "true";
      await seed();
      await spendXrplToday(2_000_000);
      let w = wall();
      await runL1Batch({ limit: 10, fetchImpl: w.fetchImpl, getPayerUsdcBalance: FUNDED, getXrplSigningInputs: SIGNING });
      assert.ok(w.seen.every((s) => !s.url.includes("xrplseller1") && !s.url.includes("xrplseller2")), "XRPL の候補には触れない");
      assert.ok(w.seen.some((s) => s.url.includes("seller1.example") && s.paid), "Base は買う");
      assert.deepEqual(await ledgerFor("https://xrplseller1.example/api"), []);

      await seed();
      await spendXrplToday(2_000_000 - 1000); // 残り 1000 < 1 件 10000
      w = wall();
      await runL1Batch({ limit: 10, fetchImpl: w.fetchImpl, getPayerUsdcBalance: FUNDED, getXrplSigningInputs: SIGNING });
      assert.ok(!w.seen.some((s) => s.url.includes("xrplseller") && s.paid), "支払い付きは出ない");
      assert.deepEqual(await ledgerFor("https://xrplseller1.example/api"), [], "行が無い＝翌日また選ばれる");
      assert.deepEqual(await ledgerFor("https://xrplseller2.example/api"), []);
    });

    await t.test("残高の関門: RLUSD が足りない／XRP が手数料に足りない（読み手が throw）なら署名せず行も書かない", async () => {
      process.env.OBSERVATORY_XRPL_L1_ENABLED = "true";
      for (const reader of [
        async ({ chain }: { chain: string }) => (chain === "xrpl" ? 0n : 1_000_000_000n),
        async ({ chain }: { chain: string }) => {
          if (chain === "xrpl") throw new Error("xrpl_fee_unfunded: -500000 drops spendable after reserve < fee 12");
          return 1_000_000_000n;
        },
      ]) {
        await seed();
        const w = wall();
        const summary = await runL1Batch({ limit: 10, fetchImpl: w.fetchImpl, getPayerUsdcBalance: reader, getXrplSigningInputs: SIGNING });
        assert.ok(!w.seen.some((s) => s.url.includes("xrplseller") && s.paid), "XRPL へ支払い付きは出ない");
        assert.ok(summary.payerUnfunded >= 1);
        for (const n of [1, 2, 3]) assert.deepEqual(await ledgerFor(`https://xrplseller${n}.example/api`), [], "行を書かない");
        assert.ok(w.seen.some((s) => s.url.includes("seller1.example") && s.paid), "Base は買う");
      }
    });
  });
}
