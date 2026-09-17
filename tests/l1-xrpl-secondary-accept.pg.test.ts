// ============================================================
// L1: Base が先頭・XRPL の RLUSD accept が 2 番目以降の行を、XRPL のレーンで買う（2026-09-18）。
//
// 本番の実測: XRPL を主ネットワークにする稼働中の行は 1 件（unbuildable）。約 1,600 件は e.network = eip155:8453 で、
// XRPL の RLUSD accept は raw_accepts の 2 番目以降。レールをカタログの e.network で決めていたので XRPL で 1 件も買えなかった。
//
// 守ること:
//  1. フラグ ON: その行が XRPL の枠（laneFloor.xrpl）に載り、XRPL の RLUSD で買われる。行は network = xrpl:0・
//     asset は hex・payer は XRPL のアドレス・amount_units は 6 桁 units。Base の accept には署名しない。
//  2. フラグ OFF: 従来どおり Base で買う。
//  3. XRPL で settle_claimed の行がある endpoint は、次に買い直すとき Base に戻る（レーンの実績は 1 回でよい）。
//  4. 壁の XRPL accept の payTo がカタログの raw_accepts の宣言に無い r アドレスなら払わない（Base へ落ち、理由を行に残す）。
//  5. 1 バッチ 1 件: 2 件目の XRPL レーン候補は署名されず、行も無い（Base でも買わない）。
//  6. 我々の側の XRPL 障害（署名の材料が読めない）: 1 件目は行なし、レーンを 1 回目で閉じ、以降の Base 先頭の
//     レーン候補は Base の通常経路で買う（行を書かずに飛ばし続けない）。summary.xrplLaneClosed に理由。
//  7. 台帳の asset は定数の大文字 hex。壁が `RLUSD` リテラルを名乗っても行に原文を残さない。
//  8. 1 ホストが多数の行を持つ形（本番の theaslangroup は約 1,600 件）: レーン枠は同一ホスト 2 件まで
//     （budget.ts LANE_FLOOR_MAX_PER_HOST）、その上で 1 バッチ 1 件——1 回の cron で XRPL の署名は 1 件。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-xrpl-secondary-accept.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 xrpl secondary accept (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const payToFor = (n: string | number) => `0x${String(n).repeat(40).slice(0, 40)}`;
  const RLUSD = "524C555344000000000000000000000000000000";
  const ISSUER = "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De";

  test("L1 XRPL secondary accept", async (t) => {
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

    const xrplWallet = Wallet.fromEntropy(new Uint8Array(16).fill(9));
    const xrplPayTo = (n: number) => Wallet.fromEntropy(new Uint8Array(16).fill(70 + n)).classicAddress;

    const saved: Record<string, string | undefined> = {};
    for (const k of ["OBSERVATORY_L1_ENABLED", "OBSERVATORY_WALLET_PRIVATE_KEY", "OBSERVATORY_XRPL_L1_ENABLED", "OBSERVATORY_XRPL_SEED", "L1_XRPL_DAILY_CAP_USD", "XRPL_RPC_URL", "L1_LANE_FLOOR_PER_RUN"]) saved[k] = process.env[k];
    t.after(() => {
      for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    process.env.OBSERVATORY_XRPL_SEED = xrplWallet.seed!;
    process.env.XRPL_RPC_URL = "https://xrpl.invalid:51234/";
    delete process.env.L1_XRPL_DAILY_CAP_USD;
    delete process.env.L1_LANE_FLOOR_PER_RUN;

    const baseAccept = (n: number) => ({ scheme: "exact", network: "eip155:8453", amount: "10000", asset: BASE_USDC, payTo: payToFor(n), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } });
    /** XRPL accept の asset 表記（7 の回帰で `RLUSD` リテラルに切り替える）。 */
    let xrplAsset = RLUSD;
    const xrplAccept = (n: number) => ({
      scheme: "exact",
      network: "xrpl:0",
      asset: xrplAsset,
      extra: { issuer: ISSUER, invoiceId: `INV${n}`, sourceTag: 804681468 },
      payTo: xrplPayTo(n),
      amount: "0.01",
      maxTimeoutSeconds: 300,
    });
    /** Base 先頭・XRPL 2 番目（theaslangroup の形）。需要は最低にして、主候補では最後尾になる形にする。 */
    const dualItem = (n: number) =>
      parseCatalogItem({
        resource: `https://dualseller${n}.example/api`,
        accepts: [baseAccept(n), xrplAccept(n)],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        quality: { l30DaysTotalCalls: 1, l30DaysUniquePayers: 1 },
      });
    /** 同じホストの別パス（1 ホストが多数の行を持つ形）。 */
    const sameHostItem = (n: number) =>
      parseCatalogItem({
        resource: `https://onehost.example/api/seller${n}`,
        accepts: [baseAccept(n), xrplAccept(n)],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        quality: { l30DaysTotalCalls: 1, l30DaysUniquePayers: 1 },
      });
    const baseItem = (n: number) =>
      parseCatalogItem({
        resource: `https://baseonly${n}.example/api`,
        accepts: [baseAccept(n)],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        quality: { l30DaysTotalCalls: 5000, l30DaysUniquePayers: 500 },
      });

    /** 壁が名乗る XRPL の payTo を差し替える（4 の回帰）。 */
    let wallXrplPayTo: ((n: number) => string) | null = null;
    const challengeDoc = (url: string) => {
      const n = Number(/seller(\d)|only(\d)/.exec(url)?.slice(1).find(Boolean) ?? "1");
      if (url.includes("dualseller") || url.includes("onehost.example")) {
        const x = xrplAccept(n);
        return { x402Version: 2, accepts: [baseAccept(n), wallXrplPayTo ? { ...x, payTo: wallXrplPayTo(n) } : x] };
      }
      return { x402Version: 2, accepts: [baseAccept(n)] };
    };
    const wall402 = (url: string) =>
      new Response(JSON.stringify({ error: "payment required" }), {
        status: 402,
        headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challengeDoc(url))).toString("base64") },
      });
    type Seen = { url: string; paid: boolean; payload: Record<string, unknown> | null; acceptedNetwork: string | null };
    const wall = () => {
      const seen: Seen[] = [];
      let counter = 0;
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const raw = headers.get("PAYMENT-SIGNATURE");
        const body = raw ? (JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { accepted: { network: string }; payload: Record<string, unknown> }) : null;
        seen.push({ url, paid: body !== null, payload: body?.payload ?? null, acceptedNetwork: body?.accepted.network ?? null });
        if (!body) return wall402(url);
        counter++;
        const onXrpl = "signedTxBlob" in body.payload;
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify(
                onXrpl
                  ? { success: true, transaction: `${counter}`.padStart(64, "A"), network: "xrpl:0", payer: xrplWallet.classicAddress }
                  : { success: true, transaction: `0x${`${counter}`.padStart(64, "b")}`, network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" },
              ),
            ).toString("base64"),
          },
        });
      };
      return { seen, fetchImpl };
    };

    async function seedItems(items: ReturnType<typeof parseCatalogItem>[]) {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      await syncCatalog({ fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true }, today: "2026-09-18" });
      await runL0ProbeBatch({ limit: 20, concurrency: 2, fetchImpl: async (url: string) => wall402(url) });
    }
    const ledgerFor = async (resourceUrl: string) => {
      const raw = await db.execute(sql`
        SELECT pu.status, pu.network, pu.asset, pu.pay_to, pu.amount_units, pu.spent_units, pu.payer, pu.auth_nonce,
               pu.raw_response_meta->'xrplLane'->>'reason' AS xrpl_lane_reason
        FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE e.resource_url = ${resourceUrl} ORDER BY pu.attempted_at ASC`);
      return [...((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<string, string | null>[])];
    };
    const FUNDED = async () => 1_000_000_000n;
    const SIGNING = async () => ({ sequence: 7, validatedLedgerIndex: 99_000_000 });
    const run = (w: ReturnType<typeof wall>) => runL1Batch({ limit: 10, fetchImpl: w.fetchImpl, getPayerUsdcBalance: FUNDED, getXrplSigningInputs: SIGNING });

    await t.test("フラグ ON: Base 先頭の行が XRPL の枠に載り、XRPL の RLUSD で買われる（行は xrpl:0）", async () => {
      process.env.OBSERVATORY_XRPL_L1_ENABLED = "true";
      await seedItems([baseItem(1), baseItem(2), dualItem(3)]);
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.laneFloor.xrpl, 1, "XRPL の枠に 1 件載る");
      assert.ok(w.seen[0].url.includes("dualseller3"), "レーン枠の候補が先頭");
      const paid = w.seen.filter((s) => s.url.includes("dualseller3") && s.paid);
      assert.equal(paid.length, 1);
      assert.equal(paid[0].acceptedNetwork, "xrpl:0");
      const tx = decode(String(paid[0].payload!.signedTxBlob)) as Record<string, unknown>;
      assert.equal(tx.TransactionType, "Payment");
      assert.equal(tx.Destination, xrplPayTo(3));
      assert.equal(tx.Account, xrplWallet.classicAddress);
      assert.deepEqual(tx.Amount, { currency: RLUSD, issuer: ISSUER, value: "0.01" });
      const rows = await ledgerFor("https://dualseller3.example/api");
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "settle_claimed");
      assert.equal(rows[0].network, "xrpl:0");
      assert.equal(rows[0].asset, RLUSD);
      assert.equal(rows[0].pay_to, xrplPayTo(3));
      assert.equal(rows[0].amount_units, "10000");
      assert.equal(rows[0].spent_units, "10000");
      assert.equal(rows[0].payer, xrplWallet.classicAddress);
      assert.match(rows[0].auth_nonce ?? "", /^[0-9A-F]{64}$/);
      // Base だけの売り手は従来どおり Base で買う
      const baseRows = await ledgerFor("https://baseonly1.example/api");
      assert.equal(baseRows[0]?.network, "eip155:8453");
      const xrplSpent = await db.execute(sql`SELECT coalesce(sum(spent_units::numeric), 0)::text AS s FROM x402_l1_purchases WHERE network = 'xrpl:0'`);
      assert.equal(((Array.isArray(xrplSpent) ? xrplSpent : (xrplSpent as { rows?: unknown[] }).rows ?? []) as { s: string }[])[0].s, "10000", "別枠 xrpl に 10000 units");
    });

    await t.test("フラグ OFF: 同じ行は従来どおり Base で買われる", async () => {
      delete process.env.OBSERVATORY_XRPL_L1_ENABLED;
      await seedItems([baseItem(1), dualItem(3)]);
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.laneFloor.xrpl ?? 0, 0);
      const paid = w.seen.filter((s) => s.url.includes("dualseller3") && s.paid);
      assert.equal(paid.length, 1);
      assert.equal(paid[0].acceptedNetwork, "eip155:8453");
      assert.ok("authorization" in paid[0].payload!, "EIP-3009 の封筒");
      const rows = await ledgerFor("https://dualseller3.example/api");
      assert.equal(rows[0].network, "eip155:8453");
      assert.equal(rows[0].xrpl_lane_reason, null, "レーン候補ではないので xrplLane も付かない");
    });

    await t.test("XRPL で settle_claimed の行がある endpoint は、買い直しで Base に戻る", async () => {
      process.env.OBSERVATORY_XRPL_L1_ENABLED = "true";
      await seedItems([dualItem(3)]);
      const ep = await db.execute(sql`SELECT id FROM x402_endpoints WHERE resource_url = 'https://dualseller3.example/api'`);
      const endpointId = ((Array.isArray(ep) ? ep : (ep as { rows?: unknown[] }).rows ?? []) as { id: string }[])[0].id;
      await db.insert(schema.x402L1Purchases).values({
        endpointId,
        status: "settle_claimed",
        payer: xrplWallet.classicAddress,
        network: "xrpl:0",
        asset: RLUSD,
        payTo: xrplPayTo(3),
        amountUnits: "10000",
        spentUnits: "10000",
        txHash: "C".repeat(64),
        attemptedAt: new Date(Date.now() - 10 * 86_400_000), // スイープ窓（6 日）の外
      });
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.laneFloor.xrpl, 0, "XRPL の枠には載らない");
      const paid = w.seen.filter((s) => s.url.includes("dualseller3") && s.paid);
      assert.equal(paid.length, 1);
      assert.equal(paid[0].acceptedNetwork, "eip155:8453", "Base に戻る");
      const rows = await ledgerFor("https://dualseller3.example/api");
      assert.deepEqual(rows.map((r) => r.network), ["xrpl:0", "eip155:8453"]);
    });

    await t.test("壁の XRPL accept の payTo がカタログの宣言に無い r アドレスなら払わない（Base へ落ち、理由を行に残す）", async () => {
      process.env.OBSERVATORY_XRPL_L1_ENABLED = "true";
      await seedItems([dualItem(3)]);
      wallXrplPayTo = (n) => xrplPayTo(n + 5); // 宣言（raw_accepts）に無い r アドレス
      try {
        const w = wall();
        await run(w);
        const paid = w.seen.filter((s) => s.url.includes("dualseller3") && s.paid);
        assert.equal(paid.length, 1);
        assert.equal(paid[0].acceptedNetwork, "eip155:8453", "XRPL には署名しない");
        assert.ok(!("signedTxBlob" in paid[0].payload!));
        const rows = await ledgerFor("https://dualseller3.example/api");
        assert.equal(rows.length, 1);
        assert.equal(rows[0].network, "eip155:8453");
        assert.equal(rows[0].xrpl_lane_reason, "payto_mismatch");
      } finally {
        wallXrplPayTo = null;
      }
    });

    await t.test("署名の材料が読めない（我々の側の障害）: 1 件目は行なし、レーンを閉じ、以降の Base 先頭の行は Base で買う", async () => {
      process.env.OBSERVATORY_XRPL_L1_ENABLED = "true";
      await seedItems([dualItem(3), dualItem(4), dualItem(5)]);
      const w = wall();
      let signingCalls = 0;
      const summary = await runL1Batch({
        limit: 10,
        fetchImpl: w.fetchImpl,
        getPayerUsdcBalance: FUNDED,
        getXrplSigningInputs: async () => {
          signingCalls++;
          throw new Error("xrpl_rpc_http_503");
        },
      });
      assert.equal(signingCalls, 1, "1 回目で閉じる（同じ RPC を叩き直さない）");
      assert.equal(summary.xrplLaneClosed, "signing_inputs_unavailable");
      assert.ok(!w.seen.some((s) => s.paid && s.acceptedNetwork === "xrpl:0"), "XRPL には署名しない");
      const first = /dualseller(\d)/.exec(w.seen[0].url)![1];
      assert.deepEqual(await ledgerFor(`https://dualseller${first}.example/api`), [], "1 件目は行なし（Base の売り手の request_error にしない）");
      for (const n of ["3", "4", "5"].filter((x) => x !== first)) {
        const rows = await ledgerFor(`https://dualseller${n}.example/api`);
        assert.equal(rows.length, 1, `dualseller${n} は Base の通常経路で買われる`);
        assert.equal(rows[0].network, "eip155:8453");
        assert.equal(rows[0].status, "settle_claimed");
      }
    });

    await t.test("台帳の asset は定数の大文字 hex: 壁とカタログが `RLUSD` リテラルでも行に原文を残さない", async () => {
      process.env.OBSERVATORY_XRPL_L1_ENABLED = "true";
      xrplAsset = "RLUSD";
      try {
        await seedItems([dualItem(3)]);
        const w = wall();
        const summary = await run(w);
        assert.equal(summary.laneFloor.xrpl, 1, "リテラル表記の行も XRPL の枠に載る");
        const paid = w.seen.filter((s) => s.paid && s.acceptedNetwork === "xrpl:0");
        assert.equal(paid.length, 1);
        const tx = decode(String(paid[0].payload!.signedTxBlob)) as Record<string, unknown>;
        assert.deepEqual(tx.Amount, { currency: RLUSD, issuer: ISSUER, value: "0.01" }, "tx の通貨コードも hex");
        const rows = await ledgerFor("https://dualseller3.example/api");
        assert.equal(rows[0].network, "xrpl:0");
        assert.equal(rows[0].asset, RLUSD, "行の asset は hex（壁の原文 RLUSD ではない）");
      } finally {
        xrplAsset = RLUSD;
      }
    });

    await t.test("1 ホストに 6 行: レーン枠は同一ホスト 2 件まで、XRPL の署名は 1 回の cron で 1 件", async () => {
      process.env.OBSERVATORY_XRPL_L1_ENABLED = "true";
      await seedItems([1, 2, 3, 4, 5, 6].map((n) => sameHostItem(n)));
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.laneFloor.xrpl, 2, "枠（既定 5）でも同一ホストは 2 件まで");
      assert.equal(summary.laneFloorHostCapped.xrpl, 4, "残り 4 行はホスト上限で枠から外れた");
      const paidXrpl = w.seen.filter((s) => s.paid && s.acceptedNetwork === "xrpl:0");
      assert.equal(paidXrpl.length, 1, "XRPL の署名は 1 件");
      const xrplRows = await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases WHERE network = 'xrpl:0'`);
      assert.equal(((Array.isArray(xrplRows) ? xrplRows : (xrplRows as { rows?: unknown[] }).rows ?? []) as { n: number }[])[0].n, 1);
      // 枠の 2 件目は要求も行も無い。枠から外れた 4 行は主候補として従来どおり Base で買われる。
      const second = w.seen.filter((s) => !s.paid).map((s) => s.url)[1];
      assert.ok(second !== undefined);
      const byNetwork = await db.execute(sql`SELECT network, count(*)::int AS n FROM x402_l1_purchases GROUP BY network ORDER BY network`);
      const counts = Object.fromEntries((((Array.isArray(byNetwork) ? byNetwork : (byNetwork as { rows?: unknown[] }).rows ?? []) as { network: string; n: number }[])).map((r) => [r.network, r.n]));
      assert.deepEqual(counts, { "eip155:8453": 4, "xrpl:0": 1 }, "XRPL 1 件 + 枠外の 4 行は Base。枠の 2 件目は行なし");
    });

    await t.test("1 バッチ 1 件: 2 件目の XRPL レーン候補は署名されず、行も無い（Base でも買わない）", async () => {
      process.env.OBSERVATORY_XRPL_L1_ENABLED = "true";
      await seedItems([baseItem(1), dualItem(3), dualItem(4), dualItem(5)]);
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.laneFloor.xrpl, 3);
      const paidXrpl = w.seen.filter((s) => s.paid && s.acceptedNetwork === "xrpl:0");
      assert.equal(paidXrpl.length, 1, "XRPL の署名は 1 件だけ");
      const dualSeen = w.seen.filter((s) => s.url.includes("dualseller"));
      assert.equal(dualSeen.length, 2, "2 件目以降は無払いの要求も出ない（1 件目の無払い + 支払い付き）");
      const rows = (await Promise.all([3, 4, 5].map((n) => ledgerFor(`https://dualseller${n}.example/api`)))).flat();
      assert.equal(rows.length, 1, "行は 1 件だけ（残りは翌バッチに XRPL の候補として戻る）");
      assert.equal(rows[0].network, "xrpl:0");
      assert.ok(w.seen.some((s) => s.url.includes("baseonly1") && s.paid), "Base は続けて買う");
    });
  });
}
