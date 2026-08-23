// ============================================================
// vet402 Observatory L1 — purchase runner integration (W3).
//
// DB-backed. Properties under test:
//  - fail-closed activation: flag off or no key → zero requests, zero rows;
//  - budget ledger: spent = SIGNED attempts (not just settles), summed from
//    the DB per UTC day, and the batch stops at the $25 line;
//  - target selection: L0-passing, real-demand first, one purchase per
//    endpoint per sweep window;
//  - the full happy path records the receipt (tx hash) and the delivery
//    facts; a price-mismatching seller is recorded, not paid.
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/observatory-l1-runner.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("observatory l1 runner (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  // Valid 20-byte addresses derived from the seller number (viem validates).
  const payToFor = (n: string | number) => `0x${String(n).repeat(40).slice(0, 40)}`;

  test("L1 purchase runner", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { eq, sql } = await import("drizzle-orm");

    const db = getDb()!;
    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
    );

    const savedEnabled = process.env.OBSERVATORY_L1_ENABLED;
    const savedKey = process.env.OBSERVATORY_WALLET_PRIVATE_KEY;
    t.after(() => {
      if (savedEnabled === undefined) delete process.env.OBSERVATORY_L1_ENABLED;
      else process.env.OBSERVATORY_L1_ENABLED = savedEnabled;
      if (savedKey === undefined) delete process.env.OBSERVATORY_WALLET_PRIVATE_KEY;
      else process.env.OBSERVATORY_WALLET_PRIVATE_KEY = savedKey;
    });

    // Seed: two sellers with declared price 3000 units, one with high demand.
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
      fetchResult: {
        items: [mk(1, 900), mk(2, 100)],
        totalCount: 2,
        fetchedCount: 2,
        complete: true,
      },
      today: "2026-08-14",
    });

    // Challenge whose payTo matches the catalog row for that URL — the L0
    // probe cross-checks metadata, so a fixture mismatch reads as fail.
    const challengeFor = (url: string) => {
      const n = /seller(\d)/.exec(url)?.[1] ?? "1";
      return JSON.stringify({
        x402Version: 2,
        accepts: [
          { scheme: "exact", network: "eip155:8453", amount: "3000", asset: BASE_USDC, payTo: payToFor(n), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } },
        ],
      });
    };
    // L0 pass both endpoints first (targets require a passing payment wall).
    await runL0ProbeBatch({
      limit: 10,
      concurrency: 2,
      fetchImpl: async (url: string) =>
        new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } }),
    });

    await t.test("flag off → zero requests, zero rows", async () => {
      delete process.env.OBSERVATORY_L1_ENABLED;
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      let called = 0;
      const summary = await runL1Batch({
        fetchImpl: async () => {
          called++;
          return new Response("", { status: 402 });
        },
      });
      assert.equal(summary.attempted, 0);
      assert.equal(summary.disabledReason, "l1_disabled");
      assert.equal(called, 0);
    });

    await t.test("no key → zero requests even with the flag on", async () => {
      process.env.OBSERVATORY_L1_ENABLED = "true";
      delete process.env.OBSERVATORY_WALLET_PRIVATE_KEY;
      const summary = await runL1Batch({ fetchImpl: async () => new Response("", { status: 402 }) });
      assert.equal(summary.attempted, 0);
      assert.equal(summary.disabledReason, "wallet_key_missing");
    });

    await t.test("wallet key without the 0x prefix (MetaMask export) is accepted", async () => {
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK.slice(2); // no 0x
      const summary = await runL1Batch({
        fetchImpl: async () => new Response("", { status: 500 }), // no purchase, just past the key gate
        limit: 0,
      });
      assert.equal(summary.disabledReason, null, "bare 64-hex key must not read as missing");
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    });

    await t.test("happy path: 402 → sign → settle → receipt row with facts", async () => {
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      const seen: { url: string; hasPayment: boolean }[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
        seen.push({ url, hasPayment: paid });
        if (!paid) {
          return new Response(challengeFor(url), {
            status: 402,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ data: "the goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({ success: true, transaction: "0xdeadbeef00000000000000000000000000000000000000000000000000000000", network: "eip155:8453", payer: "0xf39F" }),
            ).toString("base64"),
          },
        });
      };
      const summary = await runL1Batch({ fetchImpl, limit: 1 });
      assert.equal(summary.attempted, 1);
      assert.equal(summary.settled, 1);
      // highest-demand seller first
      assert.ok(seen[0].url.includes("seller1"));
      assert.equal(seen[0].hasPayment, false, "first request carries no payment");
      assert.equal(seen[1].hasPayment, true, "retry carries the signed payment");

      const rows = await db.select().from(schema.x402L1Purchases);
      assert.equal(rows.length, 1);
      // 2026-08-23 監査 C-4: 購入バッチは settled を名乗らない。settled の定義は
      // 「我々がチェーンで確認した」で、売り手が success:true と返したことでは
      // ない。照合 cron（settlement-verifier）が settled / settle_claim_refuted
      // へ確定させる。
      assert.equal(rows[0].status, "settle_claimed");
      assert.equal(rows[0].settlementVerified, null, "購入時点では未照合");
      assert.equal(rows[0].txHash, "0xdeadbeef00000000000000000000000000000000000000000000000000000000");
      assert.equal(rows[0].spentUnits, "3000");
      assert.equal(rows[0].payloadNonEmpty, true);
      assert.equal(rows[0].contentTypeMatch, true);
      assert.equal(rows[0].httpStatusPaid, 200);

      // 2026-08-23 監査 C-4: **購入バッチは observed_purchases を書かない。**
      // 2026-08-22 にここへ配線を入れたのは方向として正しかったが、当時の
      // settled は「売り手が success:true と言った」でしかなく、自己申告が
      // そのままスコアの最上位軸へ流れていた。証拠を書くのは照合器
      // （settlement-verifier）だけ——オンチェーンで宛先・金額・トークン・
      // チェーン・確定数を確認できた行のみ。
      const observed = await db.select().from(schema.observedPurchases);
      assert.equal(
        observed.length,
        0,
        "未照合の決済主張がスコア証拠に入っている——照合前に証拠を作ってはいけない",
      );

      // 冪等の性質そのものは維持されている（照合器が二重に書かない根拠）。
      const { recordObservedPurchase } = await import("@/lib/db/observed-purchases");
      const first = await recordObservedPurchase({
        wallet: rows[0].payer!,
        counterparty: payToFor(1),
        amount: "3000",
        txHash: "0xdeadbeef00000000000000000000000000000000000000000000000000000000",
        deliveryVerified: true,
      });
      assert.equal(first.created, true);
      const again = await recordObservedPurchase({
        wallet: rows[0].payer!,
        counterparty: payToFor(1),
        amount: "3000",
        txHash: "0xdeadbeef00000000000000000000000000000000000000000000000000000000",
        deliveryVerified: true,
      });
      assert.equal(again.created, false);
      assert.equal((await db.select().from(schema.observedPurchases)).length, 1);
    });

    await t.test("one purchase per endpoint per sweep window (no double-buy)", async () => {
      const summary = await runL1Batch({
        fetchImpl: async (url: string) => new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } }),
        limit: 2,
      });
      // seller1 already purchased above → only seller2 is a candidate now.
      assert.equal(summary.attempted, 1);
    });

    await t.test("onlyEndpointId narrows the batch to that endpoint (playground demo path)", async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      const eps = await db
        .select({ id: schema.x402Endpoints.id, url: schema.x402Endpoints.resourceUrl })
        .from(schema.x402Endpoints);
      const seller2 = eps.find((e) => e.url.includes("seller2"));
      assert.ok(seller2, "fixture seller2 must exist");
      const seen: string[] = [];
      const summary = await runL1Batch({
        fetchImpl: async (url: string) => {
          seen.push(url);
          return new Response(challengeFor(url), {
            status: 402,
            headers: { "content-type": "application/json" },
          });
        },
        limit: 10,
        onlyEndpointId: seller2.id,
      });
      assert.ok(seen.length > 0, "the requested endpoint is approached");
      assert.ok(
        seen.every((u) => u.includes("seller2")),
        "no other endpoint is approached when onlyEndpointId is set",
      );
      assert.equal(summary.attempted, 1);
    });

    await t.test("Solana: flag off → the solana candidate is never approached; flag+key on → full settle path with base58 payer", async () => {
      const { Keypair } = await import("@solana/web3.js");
      const SOL_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
      const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const SOL_PAY_TO = "GqSs5L9aPWGJwyRQe35YKQaWMDPh3R1dMqfSEPhSgkM";
      const FEE_PAYER = "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd";
      const solKeypair = Keypair.fromSeed(new Uint8Array(32).fill(9));
      const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";

      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      await syncCatalog({
        fetchResult: {
          items: [
            mk(1, 900),
            mk(2, 100),
            parseCatalogItem({
              resource: "https://solseller.example/api",
              accepts: [{ amount: "4000", asset: SOL_USDC, network: SOL_CAIP2, payTo: SOL_PAY_TO }],
              extensions: { bazaar: { info: { input: { method: "GET" } } } },
              quality: { l30DaysTotalCalls: 5000, l30DaysUniquePayers: 500 },
            }),
          ],
          totalCount: 3,
          fetchedCount: 3,
          complete: true,
        },
        today: "2026-08-15",
      });
      const solChallenge = JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: SOL_CAIP2,
            amount: "4000",
            asset: SOL_USDC,
            payTo: SOL_PAY_TO,
            maxTimeoutSeconds: 60,
            extra: { feePayer: FEE_PAYER },
          },
        ],
      });
      const anyChallenge = (url: string) =>
        url.includes("solseller") ? solChallenge : challengeFor(url);
      await runL0ProbeBatch({
        limit: 10,
        concurrency: 2,
        fetchImpl: async (url: string) =>
          new Response(anyChallenge(url), { status: 402, headers: { "content-type": "application/json" } }),
      });

      // フラグOFF: solana候補はSQL段階で除外され、1リクエストも飛ばない。
      delete process.env.OBSERVATORY_SOLANA_L1_ENABLED;
      delete process.env.OBSERVATORY_SOLANA_SECRET_KEY;
      const seenOff: string[] = [];
      await runL1Batch({
        fetchImpl: async (url: string) => {
          seenOff.push(url);
          return new Response(anyChallenge(url), { status: 402, headers: { "content-type": "application/json" } });
        },
        limit: 10,
      });
      assert.ok(seenOff.every((u) => !u.includes("solseller")), "solana candidate untouched while disabled");

      // フラグ+鍵ON: 全経路。壁は支払い付きリトライにbase58署名のレシートを返す。
      process.env.OBSERVATORY_SOLANA_L1_ENABLED = "true";
      process.env.OBSERVATORY_SOLANA_SECRET_KEY = Buffer.from(solKeypair.secretKey).toString("base64");
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      const summary = await runL1Batch({
        limit: 10,
        getSolanaBlockhash: async () => BLOCKHASH,
        fetchImpl: async (url: string, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          if (!url.includes("solseller")) {
            return new Response(anyChallenge(url), { status: 402, headers: { "content-type": "application/json" } });
          }
          const paid = headers.get("PAYMENT-SIGNATURE");
          if (!paid) {
            return new Response(solChallenge, { status: 402, headers: { "content-type": "application/json" } });
          }
          const envelope = JSON.parse(Buffer.from(paid, "base64").toString("utf8"));
          assert.equal(envelope.x402Version, 2);
          assert.equal(envelope.accepted.network, SOL_CAIP2);
          assert.ok(typeof envelope.payload.transaction === "string" && envelope.payload.transaction.length > 100);
          return new Response(JSON.stringify({ data: "sol goods" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "PAYMENT-RESPONSE": Buffer.from(
                JSON.stringify({ success: true, transaction: "5SoLSigBase58abcdefghijkmnopqrstuvwxyzabcdefghijkmnopqrstuvwxyzabcdefghijkmnopqrstuvwxyz", network: SOL_CAIP2, payer: FEE_PAYER }),
              ).toString("base64"),
            },
          });
        },
      });
      assert.ok(summary.settled >= 1, "solana purchase settled");
      const rows = await db.select().from(schema.x402L1Purchases);
      const solRow = rows.find((r) => r.network === SOL_CAIP2);
      assert.ok(solRow, "solana ledger row exists");
      // C-4: Solana も購入直後は settle_claimed。しかも Solana は照合器が
      // まだ無いので、cron は chain_not_yet_verifiable として繰り越す
      // （「読めなかった」を「偽物」と言わない）。
      assert.equal(solRow!.status, "settle_claimed");
      assert.equal(solRow!.payer, solKeypair.publicKey.toBase58(), "payer is base58, not lowercased");
      assert.equal(solRow!.payTo, SOL_PAY_TO, "payTo preserved base58 case");
      assert.equal(solRow!.spentUnits, "4000");
      delete process.env.OBSERVATORY_SOLANA_L1_ENABLED;
      delete process.env.OBSERVATORY_SOLANA_SECRET_KEY;
    });

    await t.test("a challenge over-charging vs catalog is recorded, never signed", async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      // payTo must be the endpoint's OWN declared payee: since 2026-08-22 the
      // payee gate runs before the price gate, so a shared payTo here would be
      // recorded as payto_mismatch and this test would stop testing pricing.
      const overcharging = (url: string) => {
        const n = /seller(\d)/.exec(url)?.[1] ?? "1";
        return JSON.stringify({
          x402Version: 2,
          accepts: [
            { scheme: "exact", network: "eip155:8453", amount: "999999", asset: BASE_USDC, payTo: payToFor(n), extra: { name: "USD Coin", version: "2" } },
          ],
        });
      };
      const summary = await runL1Batch({
        fetchImpl: async (url: string) =>
          new Response(overcharging(url), { status: 402, headers: { "content-type": "application/json" } }),
        limit: 2,
      });
      assert.equal(summary.settled, 0);
      const rows = await db.select().from(schema.x402L1Purchases);
      assert.ok(rows.length >= 1);
      assert.ok(rows.every((r) => r.status === "price_mismatch"));
      assert.ok(rows.every((r) => r.spentUnits === "0"), "nothing signed → nothing spent");
    });

    await t.test("a wall naming a payee other than the catalog's is recorded, never signed", async () => {
      // 2026-08-22 監査: l1-runner は `to: accept.payTo` で EIP-3009 に署名する
      // ので、壁が受取先を差し替えられるなら「誰に払うか」を売り手が決められる。
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      const swapped = JSON.stringify({
        x402Version: 2,
        accepts: [
          { scheme: "exact", network: "eip155:8453", amount: "3000", asset: BASE_USDC, payTo: payToFor("9"), extra: { name: "USD Coin", version: "2" } },
        ],
      });
      const summary = await runL1Batch({
        fetchImpl: async () =>
          new Response(swapped, { status: 402, headers: { "content-type": "application/json" } }),
        limit: 2,
      });
      assert.equal(summary.settled, 0);
      assert.equal(summary.attempted, 0, "署名まで行っていない");
      const rows = await db.select().from(schema.x402L1Purchases);
      assert.ok(rows.length >= 1);
      assert.ok(rows.every((r) => r.status === "payto_mismatch"), "価格ではなく受取先の所見として記録");
      assert.ok(rows.every((r) => r.spentUnits === "0"), "nothing signed → nothing spent");
    });

    await t.test("a wall naming the operator's own payTo is refused before any reservation", async () => {
      // 自己取引の防止。候補選択の自己除外は catalog の pay_to にしか掛からない。
      // カタログが payTo を申告していないエンドポイントでは payto_mismatch も
      // 比較対象を持たないので、**壁が返した payTo の運営者チェックだけ**が
      // 「vet402 が自分から買ったレシート」を止める最後の関門になる。
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      const OPERATOR = payToFor("9");
      const savedOperator = process.env.VET402_OPERATOR_PAYTO;
      process.env.VET402_OPERATOR_PAYTO = OPERATOR;
      const [nullPayToEp] = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: "nopayto.example/api",
          resourceUrl: "https://nopayto.example/api",
          network: "eip155:8453",
          method: "GET",
          payTo: null, // カタログが受取先を申告していない
          priceAmount: "3000",
          status: "active",
        })
        .returning();
      await db
        .insert(schema.x402L0Probes)
        .values({ endpointId: nullPayToEp.id, method: "GET", verdict: "pass" });
      try {
        const wall = JSON.stringify({
          x402Version: 2,
          accepts: [
            { scheme: "exact", network: "eip155:8453", amount: "3000", asset: BASE_USDC, payTo: OPERATOR, extra: { name: "USD Coin", version: "2" } },
          ],
        });
        const summary = await runL1Batch({
          onlyEndpointId: nullPayToEp.id,
          fetchImpl: async () =>
            new Response(wall, { status: 402, headers: { "content-type": "application/json" } }),
        });
        assert.equal(summary.settled, 0);
        assert.equal(summary.attempted, 0, "署名も予約もしていない");
        const rows = await db
          .select()
          .from(schema.x402L1Purchases)
          .where(eq(schema.x402L1Purchases.endpointId, nullPayToEp.id));
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, "payto_operator_self");
        assert.equal(rows[0].spentUnits, "0", "予約前に止まる → 支出0");
      } finally {
        if (savedOperator === undefined) delete process.env.VET402_OPERATOR_PAYTO;
        else process.env.VET402_OPERATOR_PAYTO = savedOperator;
        await db.execute(sql`DELETE FROM x402_l0_probes WHERE endpoint_id = ${nullPayToEp.id}::uuid`);
        await db.execute(sql`DELETE FROM x402_endpoints WHERE id = ${nullPayToEp.id}::uuid`);
      }
    });

    await t.test("品は来たがレシート無しは settleFailed に混ぜず deliveredNoReceipt で返す", async () => {
      // 2026-08-22 監査・項目8: DBの status は delivered_no_receipt と
      // settle_failed を区別しているのに、cron 応答の summary は両方を
      // settleFailed に吸収していて外から判別できなかった。
      await db.execute(sql`TRUNCATE x402_l1_purchases, observed_purchases`);
      const summary = await runL1Batch({
        fetchImpl: async (url: string, init?: RequestInit) => {
          const headers = new Headers(init?.headers);
          if (!headers.has("PAYMENT-SIGNATURE") && !headers.has("X-PAYMENT")) {
            return new Response(challengeFor(url), {
              status: 402,
              headers: { "content-type": "application/json" },
            });
          }
          // 品は返すが PAYMENT-RESPONSE を返さない壁。
          return new Response(JSON.stringify({ data: "the goods" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
        limit: 1,
      });
      assert.equal(summary.attempted, 1);
      assert.equal(summary.settled, 0);
      assert.equal(summary.deliveredNoReceipt, 1, "レシート無しはこの欄に立つ");
      assert.equal(summary.settleFailed, 0, "決済失敗と混ぜない");

      const rows = await db.select().from(schema.x402L1Purchases);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "delivered_no_receipt");
      assert.equal(rows[0].spentUnits, "3000", "署名した＝計上する");

      // レシート（tx_hash）が無い購入は observed_purchases に書けない
      // ——オンチェーンの購入として名指せないため（項目1の境界）。
      assert.equal((await db.select().from(schema.observedPurchases)).length, 0);
    });

    await t.test("daily budget from the DB stops the batch at the line", async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      // Pretend 24.999 USDC already spent today.
      const [ep] = await db.select({ id: schema.x402Endpoints.id }).from(schema.x402Endpoints).limit(1);
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id,
        // 予算は status を問わず合算する。実際に積まれるのは購入直後の
        // settle_claimed なので、見立てもそれに合わせる。
        status: "settle_claimed",
        spentUnits: "24999000",
        amountUnits: "24999000",
      });
      const summary = await runL1Batch({
        fetchImpl: async (url: string) => new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } }),
        limit: 2,
      });
      assert.equal(summary.settled, 0);
      assert.equal(summary.budgetDenied >= 1, true, "remaining $0.001 cannot cover a $0.003 purchase");
    });

    await t.test("a purchase landing exactly on the daily cap is allowed (<= boundary)", async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      // 25.000000 cap, a 0.003 purchase → seed 24.997000 so the buy lands on
      // the line exactly. reserveSpend gates on `day.spent + amount <= cap`;
      // an off-by-one to `<` would deny this and the test would catch it.
      const [ep] = await db.select({ id: schema.x402Endpoints.id }).from(schema.x402Endpoints).limit(1);
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id,
        status: "settle_claimed",
        spentUnits: "24997000",
        amountUnits: "24997000",
      });
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT")) {
          return new Response(JSON.stringify({ data: "the goods" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "PAYMENT-RESPONSE": Buffer.from(
                JSON.stringify({ success: true, transaction: "0x11fe000000000000000000000000000000000000000000000000000000000000", network: "eip155:8453" }),
              ).toString("base64"),
            },
          });
        }
        return new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } });
      };
      const summary = await runL1Batch({ fetchImpl, limit: 1 });
      assert.equal(summary.settled, 1, "a spend that reaches the cap exactly must go through");
      assert.equal(summary.budgetDenied, 0);
    });

    await t.test("an orphan in_flight reservation still occupies the daily budget", async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      // A kill after reserveSpend but before the outcome leaves an in_flight
      // row — money that MAY have moved. The daily-spend sum is status-blind by
      // design so that row keeps occupying the budget; dropping it from the sum
      // would silently re-open a fresh $25. Fill the cap with one in_flight row
      // and assert the batch is denied, not allowed to spend again.
      const [ep] = await db.select({ id: schema.x402Endpoints.id }).from(schema.x402Endpoints).limit(1);
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id,
        status: "in_flight",
        spentUnits: "25000000",
        amountUnits: "25000000",
      });
      const summary = await runL1Batch({
        fetchImpl: async (url: string) => new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } }),
        limit: 2,
      });
      assert.equal(summary.settled, 0);
      assert.equal(summary.budgetDenied >= 1, true, "an in_flight row must count against the budget");
    });

    // Security (2026-08-15 audit): the moment the EIP-3009 authorization is
    // signed, the money is live until validBefore — the seller can settle it
    // whatever happens on our side. If the ledger row is only written AFTER
    // the paid request returns, a kill in between (Vercel maxDuration=300s on
    // a batch that can legitimately take longer, or a DB blip on the insert)
    // spends real USDC that no later run can see: the daily cap is computed
    // from this table, so an unrecorded spend re-opens the same budget.
    await t.test("the spend is on the ledger BEFORE the signed request goes out", async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      let ledgerDuringPaidRequest: string[] | null = null;
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        if (headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT")) {
          const rows = await db.select().from(schema.x402L1Purchases);
          ledgerDuringPaidRequest = rows.map((r) => r.spentUnits);
          return new Response(JSON.stringify({ data: "the goods" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "PAYMENT-RESPONSE": Buffer.from(
                JSON.stringify({ success: true, transaction: "0xfeed000000000000000000000000000000000000000000000000000000000000", network: "eip155:8453" }),
              ).toString("base64"),
            },
          });
        }
        return new Response(challengeFor(url), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      };
      const summary = await runL1Batch({ fetchImpl, limit: 1 });
      assert.equal(summary.attempted, 1);
      assert.deepEqual(
        ledgerDuringPaidRequest,
        ["3000"],
        "signed money must already be counted on the ledger while the paid request is in flight",
      );
      const rows = await db.select().from(schema.x402L1Purchases);
      assert.equal(rows.length, 1, "the reservation is updated in place, not duplicated");
      assert.equal(rows[0].status, "settle_claimed");
      assert.equal(rows[0].spentUnits, "3000");
      assert.equal(rows[0].txHash, "0xfeed000000000000000000000000000000000000000000000000000000000000");
    });

    // Security (2026-08-15 audit): TOCTOU. Today's spend is read once per
    // batch and each purchase's ledger row lands seconds later (after two
    // network round trips), so two overlapping invocations of the cron route
    // both start from "spent 0 today" and each spends a full daily budget.
    // The daily cap is the only ceiling on this wallet, so the overshoot is
    // real USDC. The gate has to be taken in the database, per purchase.
    await t.test("two overlapping batches cannot spend past the daily cap", async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      const CEILING = "1000000"; // $1.00 — the hard per-purchase ceiling
      for (let i = 100; i < 140; i++) {
        const [row] = await db
          .insert(schema.x402Endpoints)
          .values({
            resourceKey: `race${i}.example/api`,
            resourceUrl: `https://race${i}.example/api`,
            method: "GET",
            network: "eip155:8453",
            payTo: payToFor(i),
            priceAmount: CEILING,
            priceAsset: BASE_USDC,
            qualityCalls30d: 1000,
            qualityPayers30d: 100,
          })
          .returning();
        if (!row) continue;
        await db
          .insert(schema.x402L0Probes)
          .values({ endpointId: row.id, method: "GET", verdict: "pass" });
      }

      const raceChallenge = (url: string) => {
        const n = /race(\d+)/.exec(url)?.[1] ?? "100";
        return JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              amount: CEILING,
              asset: BASE_USDC,
              payTo: payToFor(n),
              maxTimeoutSeconds: 300,
              extra: { name: "USD Coin", version: "2" },
            },
          ],
        });
      };
      // Real sellers answer over the network; the jitter keeps the two batches
      // from marching in artificial lockstep.
      const raceFetch = async (url: string, init?: RequestInit) => {
        await new Promise((r) => setTimeout(r, 2 + Math.random() * 6));
        const headers = new Headers(init?.headers);
        if (headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT")) {
          return new Response(JSON.stringify({ data: "ok" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "PAYMENT-RESPONSE": Buffer.from(
                JSON.stringify({ success: true, transaction: "0xacce550000000000000000000000000000000000000000000000000000000000", network: "eip155:8453" }),
              ).toString("base64"),
            },
          });
        }
        return new Response(raceChallenge(url), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      };

      await Promise.all([
        runL1Batch({ fetchImpl: raceFetch, limit: 45 }),
        (async () => {
          await new Promise((r) => setTimeout(r, 25));
          return runL1Batch({ fetchImpl: raceFetch, limit: 45 });
        })(),
      ]);

      const spentRaw = await db.execute(sql`
        SELECT coalesce(sum(spent_units::numeric), 0)::text AS spent
        FROM x402_l1_purchases
        WHERE attempted_at >= date_trunc('day', now() AT TIME ZONE 'utc')
      `);
      const spentList = (Array.isArray(spentRaw)
        ? spentRaw
        : (spentRaw as { rows?: unknown[] }).rows ?? []) as { spent: string }[];
      const spent = BigInt(spentList[0].spent.split(".")[0]);
      assert.ok(
        spent <= 26_000_000n,
        `two overlapping batches spent ${spent} units; the daily cap is 25_000_000 (one purchase of slack allowed)`,
      );
    });
  });
}
