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

// 2026-09-17 Issue #29: runL1Batch は署名の前に購入元の USDC 残高を読む（既定は RPC）。
// このファイルは残高の関門の検査ではないので、十分な残高を返す読み手を渡す。
const FUNDED_PAYER = async () => 1_000_000_000n;
import { randomUUID } from "node:crypto";

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
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER,
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
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, fetchImpl: async () => new Response("", { status: 402 }) });
      assert.equal(summary.attempted, 0);
      assert.equal(summary.disabledReason, "wallet_key_missing");
    });

    await t.test("wallet key without the 0x prefix (MetaMask export) is accepted", async () => {
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK.slice(2); // no 0x
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER,
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
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, fetchImpl, limit: 1 });
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
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER,
        fetchImpl: async (url: string) => new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } }),
        limit: 2,
      });
      // seller1 already purchased above → only seller2 is a candidate now.
      assert.equal(summary.attempted, 1);
    });

    await t.test("未置換パスパラメータのURLは買いに行かない（2026-08-26 F-1）", async () => {
      // settle_failed の82%（724/885 が HTTP 400）が ':siren' 等の未置換
      // プレースホルダを我々がそのまま叩いた結果だった。正しいリクエストを
      // 作れない相手に署名して予算を燃やし、その 400 を売り手の不履行として
      // 記録していた。候補選定の SQL で除外されることを固定する。
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      // 2026-09-02 監査 A1: `:name` だけでなく `{name}` `<name>` `[name]` `*` も同じ
      // （src/lib/observatory/path-template.ts が正典・SQL 側は同じ正規表現）。
      const placeholderUrls = [
        "https://ph.example/v1/entreprise/:siren",
        "https://ph.example/items/{itemId}",
        "https://ph.example/items/%7BitemId%7D",
        "https://ph.example/items/[slug]",
        "https://ph.example/files/*",
      ];
      const placeholderIds: string[] = [];
      for (const url of placeholderUrls) {
        const placeholderId = randomUUID();
        placeholderIds.push(placeholderId);
        await db.insert(schema.x402Endpoints).values({
          id: placeholderId,
          resourceKey: `GET ${url}`,
          resourceUrl: url,
          method: "GET",
          priceAmount: "3000",
          payTo: "0x00000000000000000000000000000000000000ph",
          network: "eip155:8453",
          status: "active",
        });
        await db.insert(schema.x402L0Probes).values({
          endpointId: placeholderId,
          method: "GET",
          verdict: "pass",
          httpStatus: 402,
        });
      }
      const seen: string[] = [];
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER,
        fetchImpl: async (url: string) => {
          seen.push(url);
          return new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } });
        },
        limit: 50,
      });
      assert.ok(
        !seen.some((u) => u.includes("ph.example")),
        `プレースホルダURLに購入リクエストを送っている——予算を燃やして冤罪を作る経路が再開している: ${seen.join(", ")}`,
      );
      for (const placeholderId of placeholderIds) {
        await db.execute(sql`DELETE FROM x402_endpoints WHERE id = ${placeholderId}::uuid`);
        await db.execute(sql`DELETE FROM x402_l0_probes WHERE endpoint_id = ${placeholderId}::uuid`);
      }
      void summary;
    });

    await t.test("onlyEndpointId narrows the batch to that endpoint (playground demo path)", async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      const eps = await db
        .select({ id: schema.x402Endpoints.id, url: schema.x402Endpoints.resourceUrl })
        .from(schema.x402Endpoints);
      const seller2 = eps.find((e) => e.url.includes("seller2"));
      assert.ok(seller2, "fixture seller2 must exist");
      const seen: string[] = [];
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER,
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
      await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER,
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
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER,
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

    // Stellar（2026-10-18）。差し込み口は上の Solana と同じ: カタログ同期 → L0 pass → runL1Batch の options。
    // 署名は createStellarPayment、残高は getPayerUsdcBalance。どちらもスタブで、RPC / Horizon には出ない。
    // 秘密はテストの中で作り、失敗メッセージにも台帳の JSON にも載せない。
    const STELLAR_ENV = ["OBSERVATORY_STELLAR_L1_ENABLED", "STELLAR_PAYER_SECRET", "STELLAR_HORIZON_URL", "STELLAR_RPC_URL", "L1_STELLAR_DAILY_CAP_USD"] as const;
    const savedStellarEnv = Object.fromEntries(STELLAR_ENV.map((k) => [k, process.env[k]]));
    const restoreStellarEnv = () => {
      for (const k of STELLAR_ENV) {
        const v = savedStellarEnv[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    t.after(restoreStellarEnv);
    // 後続の Base のテストは seller1 / seller2 の L0 pass を前提にする。Stellar の同期で外した行を戻す。
    const restoreBaseCatalog = async () => {
      await syncCatalog({
        fetchResult: { items: [mk(1, 900), mk(2, 100)], totalCount: 2, fetchedCount: 2, complete: true },
        today: "2026-08-14",
      });
      await runL0ProbeBatch({
        limit: 10,
        concurrency: 2,
        fetchImpl: async (url: string) =>
          new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } }),
      });
    };

    await t.test("Stellar: 旗 OFF では stellar の候補を買わない", async () => {
      const { Keypair } = await import("@stellar/stellar-sdk");
      const { STELLAR_PUBNET_CAIP2, STELLAR_USDC_SAC } = await import("@/lib/observatory/stellar402-payer");
      const payTo = Keypair.random().publicKey();
      const amount = "1000000";
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      delete process.env.OBSERVATORY_STELLAR_L1_ENABLED;
      delete process.env.STELLAR_PAYER_SECRET;
      delete process.env.STELLAR_HORIZON_URL;
      delete process.env.STELLAR_RPC_URL;
      await db.execute(sql`TRUNCATE x402_l1_purchases`);
      await syncCatalog({
        fetchResult: {
          items: [
            mk(1, 900),
            parseCatalogItem({
              resource: "https://stellarseller.example/api",
              accepts: [{ amount, asset: STELLAR_USDC_SAC, network: STELLAR_PUBNET_CAIP2, payTo }],
              extensions: { bazaar: { info: { input: { method: "GET" } } } },
              quality: { l30DaysTotalCalls: 8000, l30DaysUniquePayers: 80 },
            }),
          ],
          totalCount: 2,
          fetchedCount: 2,
          complete: true,
        },
        today: "2026-08-16",
      });
      const stellarChallenge = JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: "exact", network: STELLAR_PUBNET_CAIP2, amount, asset: STELLAR_USDC_SAC, payTo, maxTimeoutSeconds: 60, extra: { areFeesSponsored: true } }],
      });
      await runL0ProbeBatch({
        limit: 10,
        concurrency: 2,
        fetchImpl: async (url: string) =>
          new Response(url.includes("stellarseller") ? stellarChallenge : challengeFor(url), {
            status: 402,
            headers: { "content-type": "application/json" },
          }),
      });
      const seen: string[] = [];
      let signed = 0;
      await runL1Batch({
        getPayerUsdcBalance: FUNDED_PAYER,
        limit: 10,
        createStellarPayment: async () => {
          signed++;
          return { transaction: "unused" };
        },
        fetchImpl: async (url: string) => {
          seen.push(url);
          return new Response(url.includes("stellarseller") ? stellarChallenge : challengeFor(url), {
            status: 402,
            headers: { "content-type": "application/json" },
          });
        },
      });
      try {
        // origin/main は stellar:pubnet を知らない。候補から外さず、無払いの要求のあと EVM の selectAccept が
        // no_eligible_accept を書く。署名も、network = stellar:pubnet の行もしない。
        assert.ok(seen.some((u) => u.includes("stellarseller")), "旗 OFF でも main と同じく無払いの要求は出る");
        assert.equal(signed, 0, "旗 OFF では署名口を呼ばない");
        const rows = await db.select().from(schema.x402L1Purchases);
        assert.ok(rows.every((r) => r.network !== STELLAR_PUBNET_CAIP2), "stellar の network では書かない");
        const eps = await db.select().from(schema.x402Endpoints);
        const stellarEp = eps.find((e) => e.resourceUrl.includes("stellarseller"));
        assert.ok(stellarEp, "カタログに stellar の出品がある");
        const row = rows.find((r) => r.endpointId === stellarEp.id);
        assert.ok(row, "main と同じく行を書く");
        assert.equal(row.status, "no_eligible_accept");
        assert.equal(typeof row.payer, "string");
        assert.match(row.payer ?? "", /^0x[0-9a-f]{40}$/, "払い手の表記は EVM の番地（stellar_key_missing ではない）");
      } finally {
        await restoreBaseCatalog();
      }
    });

    await t.test("Stellar: 旗 ON でも RPC が無いときは候補に触れない", async () => {
      const { Keypair } = await import("@stellar/stellar-sdk");
      const { STELLAR_PUBNET_CAIP2, STELLAR_USDC_SAC } = await import("@/lib/observatory/stellar402-payer");
      const payer = Keypair.random();
      const payTo = Keypair.random().publicKey();
      const amount = "1000000";
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      process.env.OBSERVATORY_STELLAR_L1_ENABLED = "true";
      process.env.STELLAR_PAYER_SECRET = payer.secret();
      process.env.STELLAR_HORIZON_URL = "http://127.0.0.1:9";
      delete process.env.STELLAR_RPC_URL;
      try {
        await db.execute(sql`TRUNCATE x402_l1_purchases`);
        await syncCatalog({
          fetchResult: {
            items: [
              parseCatalogItem({
                resource: "https://stellarseller.example/api",
                accepts: [{ amount, asset: STELLAR_USDC_SAC, network: STELLAR_PUBNET_CAIP2, payTo }],
                extensions: { bazaar: { info: { input: { method: "GET" } } } },
                quality: { l30DaysTotalCalls: 9000, l30DaysUniquePayers: 90 },
              }),
            ],
            totalCount: 1,
            fetchedCount: 1,
            complete: true,
          },
          today: "2026-08-16",
        });
        const stellarChallenge = JSON.stringify({
          x402Version: 2,
          accepts: [{ scheme: "exact", network: STELLAR_PUBNET_CAIP2, amount, asset: STELLAR_USDC_SAC, payTo, maxTimeoutSeconds: 60, extra: { areFeesSponsored: true } }],
        });
        await runL0ProbeBatch({
          limit: 5,
          concurrency: 1,
          fetchImpl: async () => new Response(stellarChallenge, { status: 402, headers: { "content-type": "application/json" } }),
        });
        const seen: string[] = [];
        let signed = 0;
        await runL1Batch({
          limit: 5,
          getPayerUsdcBalance: FUNDED_PAYER,
          createStellarPayment: async () => {
            signed++;
            return { transaction: "must-not-sign" };
          },
          fetchImpl: async (url: string) => {
            seen.push(url);
            return new Response(stellarChallenge, { status: 402, headers: { "content-type": "application/json" } });
          },
        });
        assert.ok(seen.every((u) => !u.includes("stellarseller")), "RPC が無ければ 1 リクエストも出ない");
        assert.equal(signed, 0);
        const rows = await db.select().from(schema.x402L1Purchases);
        assert.equal(rows.length, 0);
        assert.equal(JSON.stringify(rows).includes(payer.secret()), false);
      } finally {
        restoreStellarEnv();
        await restoreBaseCatalog();
      }
    });

    await t.test("Stellar: v1 の壁には署名しない", async () => {
      const { Keypair } = await import("@stellar/stellar-sdk");
      const { STELLAR_PUBNET_CAIP2, STELLAR_USDC_SAC } = await import("@/lib/observatory/stellar402-payer");
      const payer = Keypair.random();
      const payTo = Keypair.random().publicKey();
      const amount = "1000000";
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      process.env.OBSERVATORY_STELLAR_L1_ENABLED = "true";
      process.env.STELLAR_PAYER_SECRET = payer.secret();
      process.env.STELLAR_HORIZON_URL = "http://127.0.0.1:9";
      process.env.STELLAR_RPC_URL = "http://127.0.0.1:9";
      try {
        await db.execute(sql`TRUNCATE x402_l1_purchases`);
        await syncCatalog({
          fetchResult: {
            items: [
              parseCatalogItem({
                resource: "https://stellarseller.example/api",
                accepts: [{ amount, asset: STELLAR_USDC_SAC, network: STELLAR_PUBNET_CAIP2, payTo }],
                extensions: { bazaar: { info: { input: { method: "GET" } } } },
                quality: { l30DaysTotalCalls: 9000, l30DaysUniquePayers: 90 },
              }),
            ],
            totalCount: 1,
            fetchedCount: 1,
            complete: true,
          },
          today: "2026-08-16",
        });
        const v2 = JSON.stringify({
          x402Version: 2,
          accepts: [{ scheme: "exact", network: STELLAR_PUBNET_CAIP2, amount, asset: STELLAR_USDC_SAC, payTo, maxTimeoutSeconds: 60, extra: { areFeesSponsored: true } }],
        });
        const v1 = JSON.stringify({
          x402Version: 1,
          accepts: [{ scheme: "exact", network: STELLAR_PUBNET_CAIP2, amount, asset: STELLAR_USDC_SAC, payTo, maxTimeoutSeconds: 60, extra: { areFeesSponsored: true } }],
        });
        await runL0ProbeBatch({
          limit: 5,
          concurrency: 1,
          fetchImpl: async () => new Response(v2, { status: 402, headers: { "content-type": "application/json" } }),
        });
        let signed = 0;
        await runL1Batch({
          limit: 5,
          getPayerUsdcBalance: FUNDED_PAYER,
          createStellarPayment: async () => {
            signed++;
            return { transaction: "must-not-sign" };
          },
          fetchImpl: async () => new Response(v1, { status: 402, headers: { "content-type": "application/json" } }),
        });
        assert.equal(signed, 0, "v1 の壁では署名口を呼ばない");
        const rows = await db.select().from(schema.x402L1Purchases);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, "no_eligible_accept");
        const meta = rows[0].rawResponseMeta as { reason?: string } | null;
        assert.equal(meta?.reason, "x402_v1_unsupported");
        assert.equal(JSON.stringify(rows).includes(payer.secret()), false);
      } finally {
        restoreStellarEnv();
        await restoreBaseCatalog();
      }
    });

    await t.test("Stellar: 1 日の別枠を超える 2 件目は reserveSpend が署名しない", async () => {
      const { Keypair } = await import("@stellar/stellar-sdk");
      const { STELLAR_PUBNET_CAIP2, STELLAR_USDC_SAC } = await import("@/lib/observatory/stellar402-payer");
      const payer = Keypair.random();
      const sellers = [Keypair.random().publicKey(), Keypair.random().publicKey()];
      const amount = "1000000";
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      process.env.OBSERVATORY_STELLAR_L1_ENABLED = "true";
      process.env.STELLAR_PAYER_SECRET = payer.secret();
      process.env.STELLAR_HORIZON_URL = "http://127.0.0.1:9";
      process.env.STELLAR_RPC_URL = "http://127.0.0.1:9";
      process.env.L1_STELLAR_DAILY_CAP_USD = "0.10";
      try {
        await db.execute(sql`TRUNCATE x402_l1_purchases`);
        await syncCatalog({
          fetchResult: {
            items: sellers.map((payTo, i) =>
              parseCatalogItem({
                resource: `https://stellarseller${i + 1}.example/api`,
                accepts: [{ amount, asset: STELLAR_USDC_SAC, network: STELLAR_PUBNET_CAIP2, payTo }],
                extensions: { bazaar: { info: { input: { method: "GET" } } } },
                quality: { l30DaysTotalCalls: 9000 - i, l30DaysUniquePayers: 90 },
              }),
            ),
            totalCount: 2,
            fetchedCount: 2,
            complete: true,
          },
          today: "2026-08-16",
        });
        const challengeForUrl = (url: string) => {
          const i = /stellarseller(\d)/.exec(url)?.[1];
          const payTo = sellers[i ? Number(i) - 1 : 0];
          return JSON.stringify({
            x402Version: 2,
            accepts: [{ scheme: "exact", network: STELLAR_PUBNET_CAIP2, amount, asset: STELLAR_USDC_SAC, payTo, maxTimeoutSeconds: 60, extra: { areFeesSponsored: true } }],
          });
        };
        await runL0ProbeBatch({
          limit: 5,
          concurrency: 1,
          fetchImpl: async (url: string) =>
            new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } }),
        });
        let signed = 0;
        await runL1Batch({
          limit: 5,
          getPayerUsdcBalance: FUNDED_PAYER,
          createStellarPayment: async () => {
            signed++;
            return { transaction: "AAAA-test-xdr" };
          },
          fetchImpl: async (url: string, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
            if (!paid) {
              return new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } });
            }
            return new Response(JSON.stringify({ data: "stellar goods" }), {
              status: 200,
              headers: {
                "content-type": "application/json",
                "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: true, transaction: "ab".repeat(32), network: STELLAR_PUBNET_CAIP2 })).toString("base64"),
              },
            });
          },
        });
        assert.equal(signed, 1, "別枠 $0.10 では $0.10 の 2 件目に署名しない");
        const rows = await db.select().from(schema.x402L1Purchases);
        const stellarRows = rows.filter((r) => r.network === STELLAR_PUBNET_CAIP2);
        assert.equal(stellarRows.length, 1);
        assert.equal(JSON.stringify(rows).includes(payer.secret()), false);
      } finally {
        restoreStellarEnv();
        await restoreBaseCatalog();
      }
    });

    await t.test("Stellar: 旗 ON で未入金なら署名せず、以後の stellar を閉じる", async () => {
      const { Keypair } = await import("@stellar/stellar-sdk");
      const { STELLAR_PUBNET_CAIP2, STELLAR_USDC_SAC } = await import("@/lib/observatory/stellar402-payer");
      const payer = Keypair.random();
      const sellers = [Keypair.random().publicKey(), Keypair.random().publicKey()];
      const amount = "1000000";
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      process.env.OBSERVATORY_STELLAR_L1_ENABLED = "true";
      process.env.STELLAR_PAYER_SECRET = payer.secret();
      process.env.STELLAR_HORIZON_URL = "http://127.0.0.1:9";
      process.env.STELLAR_RPC_URL = "http://127.0.0.1:9";
      const logs: string[] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => {
        logs.push(args.map((a) => String(a)).join(" "));
      };
      try {
        await db.execute(sql`TRUNCATE x402_l1_purchases`);
        await syncCatalog({
          fetchResult: {
            items: [
              mk(1, 100),
              ...sellers.map((payTo, i) =>
                parseCatalogItem({
                  resource: `https://stellarseller${i + 1}.example/api`,
                  accepts: [{ amount, asset: STELLAR_USDC_SAC, network: STELLAR_PUBNET_CAIP2, payTo }],
                  extensions: { bazaar: { info: { input: { method: "GET" } } } },
                  quality: { l30DaysTotalCalls: 9000 - i, l30DaysUniquePayers: 90 },
                }),
              ),
            ],
            totalCount: 3,
            fetchedCount: 3,
            complete: true,
          },
          today: "2026-08-17",
        });
        const challengeForUrl = (url: string) => {
          const i = /stellarseller(\d)/.exec(url)?.[1];
          if (!i) return challengeFor(url);
          return JSON.stringify({
            x402Version: 2,
            accepts: [{
              scheme: "exact",
              network: STELLAR_PUBNET_CAIP2,
              amount,
              asset: STELLAR_USDC_SAC,
              payTo: sellers[Number(i) - 1],
              maxTimeoutSeconds: 60,
              extra: { areFeesSponsored: true },
            }],
          });
        };
        await runL0ProbeBatch({
          limit: 10,
          concurrency: 2,
          fetchImpl: async (url: string) =>
            new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } }),
        });
        const seen: { url: string; paid: boolean }[] = [];
        let signed = 0;
        const summary = await runL1Batch({
          limit: 10,
          getPayerUsdcBalance: async ({ chain }) => (chain === "stellar" ? 0n : 1_000_000_000n),
          createStellarPayment: async () => {
            signed++;
            return { transaction: "must-not-sign" };
          },
          fetchImpl: async (url: string, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
            seen.push({ url, paid });
            return new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } });
          },
        });
        const stellarSeen = seen.filter((s) => s.url.includes("stellarseller"));
        assert.equal(stellarSeen.length, 1, "未入金の 1 件目のあとは stellar に無払いの要求も出さない");
        assert.equal(stellarSeen[0]?.paid, false, "未入金では支払い付きの要求を出さない");
        assert.equal(signed, 0, "未入金では署名口を呼ばない");
        assert.equal(summary.payerUnfunded, 1, "未入金は 1 回数え、残りの stellar を流し続けない");
        assert.ok(seen.some((s) => s.url.includes("seller1.example") && s.paid), "Base は買う");
        const rows = await db.select().from(schema.x402L1Purchases);
        assert.ok(rows.every((r) => r.network !== STELLAR_PUBNET_CAIP2), "未入金の stellar は行を書かない");
        const dumped = JSON.stringify(rows) + logs.join("\n");
        assert.equal(dumped.includes(payer.secret()), false);
      } finally {
        console.error = origError;
        restoreStellarEnv();
        await restoreBaseCatalog();
      }
    });

    await t.test("Stellar: 照合できる形の受領証なら summary.settled が立ち、行は settle_claimed", async () => {
      const { Keypair } = await import("@stellar/stellar-sdk");
      const { STELLAR_PUBNET_CAIP2, STELLAR_USDC_SAC } = await import("@/lib/observatory/stellar402-payer");
      const payer = Keypair.random();
      const payTo = Keypair.random().publicKey();
      const amount = "1000000";
      const txHash = "ab".repeat(32);
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      process.env.OBSERVATORY_STELLAR_L1_ENABLED = "true";
      process.env.STELLAR_PAYER_SECRET = payer.secret();
      process.env.STELLAR_HORIZON_URL = "http://127.0.0.1:9";
      process.env.STELLAR_RPC_URL = "http://127.0.0.1:9";
      const logs: string[] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => {
        logs.push(args.map((a) => String(a)).join(" "));
      };
      try {
        await db.execute(sql`TRUNCATE x402_l1_purchases, observed_purchases`);
        await syncCatalog({
          fetchResult: {
            items: [
              parseCatalogItem({
                resource: "https://stellarseller.example/api",
                accepts: [{ amount, asset: STELLAR_USDC_SAC, network: STELLAR_PUBNET_CAIP2, payTo }],
                extensions: { bazaar: { info: { input: { method: "GET" } } } },
                quality: { l30DaysTotalCalls: 9000, l30DaysUniquePayers: 90 },
              }),
            ],
            totalCount: 1,
            fetchedCount: 1,
            complete: true,
          },
          today: "2026-08-18",
        });
        const stellarChallenge = JSON.stringify({
          x402Version: 2,
          accepts: [{ scheme: "exact", network: STELLAR_PUBNET_CAIP2, amount, asset: STELLAR_USDC_SAC, payTo, maxTimeoutSeconds: 60, extra: { areFeesSponsored: true } }],
        });
        await runL0ProbeBatch({
          limit: 5,
          concurrency: 1,
          fetchImpl: async () => new Response(stellarChallenge, { status: 402, headers: { "content-type": "application/json" } }),
        });
        let signedUnits: bigint | null = null;
        let signedAsset: string | null = null;
        const summary = await runL1Batch({
          limit: 5,
          getPayerUsdcBalance: FUNDED_PAYER,
          createStellarPayment: async (input) => {
            signedUnits = input.stellarUnits;
            signedAsset = input.signingAsset;
            return { transaction: "AAAA-test-xdr" };
          },
          fetchImpl: async (url: string, init?: RequestInit) => {
            const headers = new Headers(init?.headers);
            if (!headers.has("PAYMENT-SIGNATURE") && !headers.has("X-PAYMENT")) {
              return new Response(stellarChallenge, { status: 402, headers: { "content-type": "application/json" } });
            }
            const envelope = JSON.parse(Buffer.from(headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT") ?? "", "base64").toString("utf8"));
            assert.equal(envelope.payload.transaction, "AAAA-test-xdr");
            assert.equal(envelope.accepted.network, STELLAR_PUBNET_CAIP2);
            return new Response(JSON.stringify({ data: "stellar goods" }), {
              status: 200,
              headers: {
                "content-type": "application/json",
                "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: true, transaction: txHash, network: STELLAR_PUBNET_CAIP2 })).toString("base64"),
              },
            });
          },
        });
        assert.equal(summary.settled, 1);
        assert.equal(signedUnits, 1_000_000n, "署名口へ渡す額は 7 桁の stroops");
        assert.equal(signedAsset, STELLAR_USDC_SAC);
        // 2026-10-30（設計 v5 第1段）: cdp_bazaar の行は完全な取得でも閉じないので、前の子テストの出品も active のまま候補に残る
        // （origin/main ではこの syncCatalog が他の出品を delisted にしていた）。Stellar の出品の購入行だけを見る。
        const rows = (await db.select().from(schema.x402L1Purchases)).filter((r) => r.network === STELLAR_PUBNET_CAIP2);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, "settle_claimed", "購入バッチはチェーン照合の前なので settle_claimed。summary.settled は形式の通った申告");
        assert.equal(rows[0].network, STELLAR_PUBNET_CAIP2);
        assert.equal(rows[0].asset, STELLAR_USDC_SAC);
        assert.equal(rows[0].payTo, payTo);
        assert.equal(rows[0].payer, payer.publicKey());
        assert.equal(rows[0].amountUnits, "100000", "台帳は 6 桁。1000000 stroops = $0.10");
        assert.equal(rows[0].spentUnits, "100000");
        assert.equal(rows[0].txHash, txHash);
        assert.equal(rows[0].settlementVerified, null);
        assert.equal((await db.select().from(schema.observedPurchases)).length, 0, "未照合の主張は証拠にしない");
        const dumped = JSON.stringify(rows) + logs.join("\n");
        assert.equal(dumped.includes(payer.secret()), false);
      } finally {
        console.error = origError;
        restoreStellarEnv();
        await restoreBaseCatalog();
      }
    });

    // Stellar secondary（2026-10-18・段4）。Base が先頭、stellar:pubnet の USDC が 2 番目。
    // 額は Base 10000（6 桁・$0.01）と Stellar 100000（7 桁・同じ $0.01）。署名も残高もスタブ。
    const dualBaseAmount = "10000";
    const dualStroops = "100000";
    async function withDualStellar(
      items: { host: string; basePayTo: string; stellarPayTo: string }[],
      wallPayTo: ReadonlyMap<string, string>,
      run: (challengeForUrl: (url: string) => string) => Promise<void>,
    ) {
      const { STELLAR_PUBNET_CAIP2, STELLAR_USDC_SAC } = await import("@/lib/observatory/stellar402-payer");
      const challengeForUrl = (url: string) => {
        const item = items.find((i) => url.includes(i.host));
        if (!item) return challengeFor(url);
        return JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              amount: dualBaseAmount,
              asset: BASE_USDC,
              payTo: item.basePayTo,
              maxTimeoutSeconds: 300,
              extra: { name: "USD Coin", version: "2" },
            },
            {
              scheme: "exact",
              network: STELLAR_PUBNET_CAIP2,
              amount: dualStroops,
              asset: STELLAR_USDC_SAC,
              payTo: wallPayTo.get(item.host) ?? item.stellarPayTo,
              maxTimeoutSeconds: 60,
              extra: { areFeesSponsored: true },
            },
          ],
        });
      };
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      await syncCatalog({
        fetchResult: {
          items: items.map((item) =>
            parseCatalogItem({
              resource: `https://${item.host}/api`,
              accepts: [
                { amount: dualBaseAmount, asset: BASE_USDC, network: "eip155:8453", payTo: item.basePayTo },
                { amount: dualStroops, asset: STELLAR_USDC_SAC, network: STELLAR_PUBNET_CAIP2, payTo: item.stellarPayTo },
              ],
              extensions: { bazaar: { info: { input: { method: "GET" } } } },
              quality: { l30DaysTotalCalls: 1, l30DaysUniquePayers: 1 },
            }),
          ),
          totalCount: items.length,
          fetchedCount: items.length,
          complete: true,
        },
        today: "2026-10-18",
      });
      await runL0ProbeBatch({
        limit: 10,
        concurrency: 2,
        fetchImpl: async (url: string) =>
          new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } }),
      });
      try {
        await run(challengeForUrl);
      } finally {
        await restoreBaseCatalog();
      }
    }

    await t.test("Stellar secondary: Base 先頭の出品をレーン枠から Stellar で買う", async () => {
      const { Keypair } = await import("@stellar/stellar-sdk");
      const { STELLAR_PUBNET_CAIP2 } = await import("@/lib/observatory/stellar402-payer");
      const payer = Keypair.random();
      const stellarPayTo = Keypair.random().publicKey();
      const host = "stellardual.example";
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      process.env.OBSERVATORY_STELLAR_L1_ENABLED = "true";
      process.env.STELLAR_PAYER_SECRET = payer.secret();
      process.env.STELLAR_HORIZON_URL = "http://127.0.0.1:9";
      process.env.STELLAR_RPC_URL = "http://127.0.0.1:9";
      try {
        await withDualStellar(
          [{ host, basePayTo: payToFor(8), stellarPayTo }],
          new Map(),
          async (challengeForUrl) => {
            const chains: string[] = [];
            let signedUnits: bigint | null = null;
            const summary = await runL1Batch({
              limit: 10,
              getPayerUsdcBalance: async ({ chain }) => {
                chains.push(chain);
                return 1_000_000_000n;
              },
              createStellarPayment: async (input) => {
                signedUnits = input.stellarUnits;
                return { transaction: "AAAA-secondary" };
              },
              fetchImpl: async (url: string, init?: RequestInit) => {
                const headers = new Headers(init?.headers);
                const raw = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
                if (!raw) {
                  return new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } });
                }
                const envelope = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { accepted: { network: string } };
                assert.equal(envelope.accepted.network, STELLAR_PUBNET_CAIP2);
                return new Response(JSON.stringify({ data: "stellar goods" }), {
                  status: 200,
                  headers: {
                    "content-type": "application/json",
                    "PAYMENT-RESPONSE": Buffer.from(
                      JSON.stringify({ success: true, transaction: "ab".repeat(32), network: STELLAR_PUBNET_CAIP2 }),
                    ).toString("base64"),
                  },
                });
              },
            });
            assert.equal(summary.laneFloor.stellar, 1, "レーン枠に載る");
            assert.equal(signedUnits, 100_000n);
            assert.ok(chains.includes("stellar"), "payerChain は stellar");
            assert.equal(chains.includes("base"), false);
            const rows = await db.select().from(schema.x402L1Purchases);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].network, STELLAR_PUBNET_CAIP2);
            assert.equal(rows[0].payer, payer.publicKey());
            assert.equal(rows[0].payTo, stellarPayTo);
            assert.equal(rows[0].amountUnits, "10000");
            assert.equal(JSON.stringify(rows).includes(payer.secret()), false);
          },
        );
      } finally {
        restoreStellarEnv();
      }
    });

    await t.test("Stellar secondary: 宣言と違う payTo の壁は払わず Base へ落とす", async () => {
      const { Keypair } = await import("@stellar/stellar-sdk");
      const { STELLAR_PUBNET_CAIP2 } = await import("@/lib/observatory/stellar402-payer");
      const payer = Keypair.random();
      const declaredPayTo = Keypair.random().publicKey();
      const wallOnly = Keypair.random().publicKey();
      const host = "stellardual.example";
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      process.env.OBSERVATORY_STELLAR_L1_ENABLED = "true";
      process.env.STELLAR_PAYER_SECRET = payer.secret();
      process.env.STELLAR_HORIZON_URL = "http://127.0.0.1:9";
      process.env.STELLAR_RPC_URL = "http://127.0.0.1:9";
      try {
        await withDualStellar(
          [{ host, basePayTo: payToFor(8), stellarPayTo: declaredPayTo }],
          new Map([[host, wallOnly]]),
          async (challengeForUrl) => {
            let signed = 0;
            const paidNetworks: string[] = [];
            await runL1Batch({
              limit: 10,
              getPayerUsdcBalance: FUNDED_PAYER,
              createStellarPayment: async () => {
                signed++;
                return { transaction: "must-not-sign" };
              },
              fetchImpl: async (url: string, init?: RequestInit) => {
                const headers = new Headers(init?.headers);
                const raw = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
                if (!raw) {
                  return new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } });
                }
                const envelope = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { accepted: { network: string } };
                paidNetworks.push(envelope.accepted.network);
                return new Response(JSON.stringify({ data: "base goods" }), {
                  status: 200,
                  headers: {
                    "content-type": "application/json",
                    "PAYMENT-RESPONSE": Buffer.from(
                      JSON.stringify({ success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:8453" }),
                    ).toString("base64"),
                  },
                });
              },
            });
            assert.equal(signed, 0, "Stellar には署名しない");
            assert.deepEqual(paidNetworks, ["eip155:8453"]);
            const rows = await db.select().from(schema.x402L1Purchases);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].network, "eip155:8453");
            const meta = rows[0].rawResponseMeta as { stellarLane?: { reason?: string } } | null;
            assert.equal(meta?.stellarLane?.reason, "payto_mismatch");
            assert.equal(JSON.stringify(rows).includes(payer.secret()), false);
            // 2026-10-27: challenge_402 は壁が出した accepts を全部残す（Stellar の accept も入る）。Stellar で
            // 払っていないことは、証拠の列を除いた台帳の列で見る。署名済みペイロード（payment_payload）は Base のもの。
            const ledgerOnly = JSON.stringify(rows, (k, v) => (k === "challenge402" || k === "paymentPayload" ? undefined : v));
            assert.equal(ledgerOnly.includes(STELLAR_PUBNET_CAIP2), false);
            assert.equal(JSON.stringify(rows[0].paymentPayload).includes(STELLAR_PUBNET_CAIP2), false);
            assert.equal(JSON.stringify(rows[0].challenge402).includes(STELLAR_PUBNET_CAIP2), true, "受け取った 402 の Stellar の accept は証拠に残る");
          },
        );
      } finally {
        restoreStellarEnv();
      }
    });

    await t.test("Stellar secondary: 未入金なら優先を閉じ、その候補は Base で買う", async () => {
      const { Keypair } = await import("@stellar/stellar-sdk");
      const { STELLAR_PUBNET_CAIP2 } = await import("@/lib/observatory/stellar402-payer");
      const payer = Keypair.random();
      const hosts = ["stellardual1.example", "stellardual2.example"];
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      process.env.OBSERVATORY_STELLAR_L1_ENABLED = "true";
      process.env.STELLAR_PAYER_SECRET = payer.secret();
      process.env.STELLAR_HORIZON_URL = "http://127.0.0.1:9";
      process.env.STELLAR_RPC_URL = "http://127.0.0.1:9";
      try {
        await withDualStellar(
          hosts.map((host, i) => ({ host, basePayTo: payToFor(8 + i), stellarPayTo: Keypair.random().publicKey() })),
          new Map(),
          async (challengeForUrl) => {
            let stellarChecks = 0;
            let signed = 0;
            let paidN = 0;
            const summary = await runL1Batch({
              limit: 10,
              getPayerUsdcBalance: async ({ chain }) => {
                if (chain === "stellar") {
                  stellarChecks++;
                  return 0n;
                }
                return 1_000_000_000n;
              },
              createStellarPayment: async () => {
                signed++;
                return { transaction: "must-not-sign" };
              },
              fetchImpl: async (url: string, init?: RequestInit) => {
                const headers = new Headers(init?.headers);
                const raw = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
                if (!raw) {
                  return new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } });
                }
                paidN++;
                const tx = `0x${paidN.toString(16).padStart(64, "0")}`;
                return new Response(JSON.stringify({ data: "base goods" }), {
                  status: 200,
                  headers: {
                    "content-type": "application/json",
                    "PAYMENT-RESPONSE": Buffer.from(
                      JSON.stringify({ success: true, transaction: tx, network: "eip155:8453" }),
                    ).toString("base64"),
                  },
                });
              },
            });
            assert.equal(summary.laneFloor.stellar, 2);
            assert.equal(stellarChecks, 1, "1 件目の未入金で以後の stellar の優先を閉じる");
            assert.equal(summary.payerUnfunded, 1);
            assert.equal(signed, 0);
            const rows = await db.select().from(schema.x402L1Purchases);
            const eps = await db.select().from(schema.x402Endpoints);
            assert.equal(rows.length, 2, "未入金の候補も、次の候補も Base で買う");
            for (const host of hosts) {
              const ep = eps.find((e) => e.resourceUrl.includes(host));
              const row = rows.find((r) => r.endpointId === ep?.id);
              assert.ok(row, host);
              assert.equal(row!.network, "eip155:8453");
            }
            assert.ok(rows.every((r) => r.network !== STELLAR_PUBNET_CAIP2));
            assert.equal(JSON.stringify(rows).includes(payer.secret()), false);
          },
        );
      } finally {
        restoreStellarEnv();
      }
    });

    await t.test("Stellar secondary: 旗 OFF なら枠に stellar が出ず、Base で買う", async () => {
      const { Keypair } = await import("@stellar/stellar-sdk");
      const { STELLAR_PUBNET_CAIP2 } = await import("@/lib/observatory/stellar402-payer");
      const host = "stellardual.example";
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      delete process.env.OBSERVATORY_STELLAR_L1_ENABLED;
      delete process.env.STELLAR_PAYER_SECRET;
      delete process.env.STELLAR_HORIZON_URL;
      delete process.env.STELLAR_RPC_URL;
      try {
        await withDualStellar(
          [{ host, basePayTo: payToFor(8), stellarPayTo: Keypair.random().publicKey() }],
          new Map(),
          async (challengeForUrl) => {
            let signed = 0;
            const summary = await runL1Batch({
              limit: 10,
              getPayerUsdcBalance: FUNDED_PAYER,
              createStellarPayment: async () => {
                signed++;
                return { transaction: "must-not-sign" };
              },
              fetchImpl: async (url: string, init?: RequestInit) => {
                const headers = new Headers(init?.headers);
                const raw = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
                if (!raw) {
                  return new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } });
                }
                return new Response(JSON.stringify({ data: "base goods" }), {
                  status: 200,
                  headers: {
                    "content-type": "application/json",
                    "PAYMENT-RESPONSE": Buffer.from(
                      JSON.stringify({ success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:8453" }),
                    ).toString("base64"),
                  },
                });
              },
            });
            assert.equal(summary.laneFloor.stellar ?? 0, 0, "旗 OFF の secondary 枠に stellar は出ない");
            assert.equal(signed, 0);
            const rows = await db.select().from(schema.x402L1Purchases);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].network, "eip155:8453");
            assert.ok(rows.every((r) => r.network !== STELLAR_PUBNET_CAIP2));
          },
        );
      } finally {
        restoreStellarEnv();
      }
    });

    function captureErrors(): { logs: string[]; restore: () => void } {
      const logs: string[] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => {
        logs.push(args.map((a) => String(a)).join(" "));
      };
      return { logs, restore: () => (console.error = origError) };
    }

    await t.test("Stellar secondary: 署名前の故障は未署名の予約を消す", async () => {
      const { Keypair } = await import("@stellar/stellar-sdk");
      const payer = Keypair.random();
      const host = "stellardual.example";
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      process.env.OBSERVATORY_STELLAR_L1_ENABLED = "true";
      process.env.STELLAR_PAYER_SECRET = payer.secret();
      process.env.STELLAR_HORIZON_URL = "http://127.0.0.1:9";
      process.env.STELLAR_RPC_URL = "http://127.0.0.1:9";
      const cap = captureErrors();
      try {
        await withDualStellar(
          [{ host, basePayTo: payToFor(8), stellarPayTo: Keypair.random().publicKey() }],
          new Map(),
          async (challengeForUrl) => {
            await runL1Batch({
              limit: 10,
              getPayerUsdcBalance: FUNDED_PAYER,
              createStellarPayment: async () => {
                throw new Error(`stellar_sign_failed_pre: rpc ${payer.secret()} https://rpc.example/x`);
              },
              fetchImpl: async (url: string, init?: RequestInit) => {
                const headers = new Headers(init?.headers);
                const raw = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
                if (!raw) {
                  return new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } });
                }
                return new Response(JSON.stringify({ data: "base goods" }), {
                  status: 200,
                  headers: {
                    "content-type": "application/json",
                    "PAYMENT-RESPONSE": Buffer.from(
                      JSON.stringify({ success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:8453" }),
                    ).toString("base64"),
                  },
                });
              },
            });
            const rows = await db.select().from(schema.x402L1Purchases);
            assert.equal(rows.filter((r) => r.status === "in_flight" || r.status === "request_error").length, 0, "署名前の予約は残さない");
            const dumped = JSON.stringify(rows) + cap.logs.join("\n");
            assert.equal(dumped.includes(payer.secret()), false);
            assert.equal(dumped.includes("rpc.example"), false);
          },
        );
      } finally {
        cap.restore();
        restoreStellarEnv();
      }
    });

    await t.test("Stellar secondary: 署名前の故障はその候補を Base で 1 回買い直す", async () => {
      const { Keypair } = await import("@stellar/stellar-sdk");
      const payer = Keypair.random();
      const host = "stellardual.example";
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      process.env.OBSERVATORY_STELLAR_L1_ENABLED = "true";
      process.env.STELLAR_PAYER_SECRET = payer.secret();
      process.env.STELLAR_HORIZON_URL = "http://127.0.0.1:9";
      process.env.STELLAR_RPC_URL = "http://127.0.0.1:9";
      try {
        await withDualStellar(
          [{ host, basePayTo: payToFor(8), stellarPayTo: Keypair.random().publicKey() }],
          new Map(),
          async (challengeForUrl) => {
            const paidNetworks: string[] = [];
            await runL1Batch({
              limit: 10,
              getPayerUsdcBalance: FUNDED_PAYER,
              createStellarPayment: async () => {
                throw new Error("stellar_sign_failed_pre: rpc down");
              },
              fetchImpl: async (url: string, init?: RequestInit) => {
                const headers = new Headers(init?.headers);
                const raw = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
                if (!raw) {
                  return new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } });
                }
                const envelope = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { accepted: { network: string } };
                paidNetworks.push(envelope.accepted.network);
                return new Response(JSON.stringify({ data: "base goods" }), {
                  status: 200,
                  headers: {
                    "content-type": "application/json",
                    "PAYMENT-RESPONSE": Buffer.from(
                      JSON.stringify({ success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:8453" }),
                    ).toString("base64"),
                  },
                });
              },
            });
            assert.deepEqual(paidNetworks, ["eip155:8453"]);
            const rows = await db.select().from(schema.x402L1Purchases);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].network, "eip155:8453");
            assert.equal(rows[0].status, "settle_claimed");
            assert.equal(JSON.stringify(rows).includes(payer.secret()), false);
          },
        );
      } finally {
        restoreStellarEnv();
      }
    });

    await t.test("Stellar secondary: 署名後の故障は Base を買わず request_error を残す", async () => {
      const { Keypair } = await import("@stellar/stellar-sdk");
      const { STELLAR_PUBNET_CAIP2 } = await import("@/lib/observatory/stellar402-payer");
      const payer = Keypair.random();
      const host = "stellardual.example";
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      process.env.OBSERVATORY_STELLAR_L1_ENABLED = "true";
      process.env.STELLAR_PAYER_SECRET = payer.secret();
      process.env.STELLAR_HORIZON_URL = "http://127.0.0.1:9";
      process.env.STELLAR_RPC_URL = "http://127.0.0.1:9";
      const cap = captureErrors();
      try {
        await withDualStellar(
          [{ host, basePayTo: payToFor(8), stellarPayTo: Keypair.random().publicKey() }],
          new Map(),
          async (challengeForUrl) => {
            const paidNetworks: string[] = [];
            const summary = await runL1Batch({
              limit: 10,
              getPayerUsdcBalance: FUNDED_PAYER,
              createStellarPayment: async () => {
                throw new Error(`stellar_sign_failed_post: resimulate ${payer.secret()} https://rpc.example/x`);
              },
              fetchImpl: async (url: string, init?: RequestInit) => {
                const headers = new Headers(init?.headers);
                const raw = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
                if (!raw) {
                  return new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } });
                }
                const envelope = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { accepted: { network: string } };
                paidNetworks.push(envelope.accepted.network);
                return new Response(JSON.stringify({ data: "base goods" }), {
                  status: 200,
                  headers: {
                    "content-type": "application/json",
                    "PAYMENT-RESPONSE": Buffer.from(
                      JSON.stringify({ success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:8453" }),
                    ).toString("base64"),
                  },
                });
              },
            });
            assert.deepEqual(paidNetworks, [], "署名後は Base の支払いを出さない");
            const rows = await db.select().from(schema.x402L1Purchases);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].status, "request_error");
            assert.equal(rows[0].network, STELLAR_PUBNET_CAIP2);
            // 署名後に releaseUnsignedReservation を呼ぶと spent_units が 0 になる。予約の額を残す。
            assert.equal(rows[0].spentUnits, "10000");
            assert.equal(rows[0].amountUnits, "10000");
            assert.equal(rows[0].authNonce, null);
            assert.equal(summary.spentUnitsTotal, "10000", "署名したら使ったと数える");
            const dumped = JSON.stringify(rows) + cap.logs.join("\n");
            assert.equal(dumped.includes(payer.secret()), false);
            assert.equal(dumped.includes("rpc.example"), false);
          },
        );
      } finally {
        cap.restore();
        restoreStellarEnv();
      }
    });

    await t.test("Stellar secondary: 別枠が尽きた日は stellar を開かず Base で買う", async () => {
      const { Keypair } = await import("@stellar/stellar-sdk");
      const payer = Keypair.random();
      const host = "stellardual.example";
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      process.env.OBSERVATORY_STELLAR_L1_ENABLED = "true";
      process.env.STELLAR_PAYER_SECRET = payer.secret();
      process.env.STELLAR_HORIZON_URL = "http://127.0.0.1:9";
      process.env.STELLAR_RPC_URL = "http://127.0.0.1:9";
      process.env.L1_STELLAR_DAILY_CAP_USD = "0";
      try {
        await withDualStellar(
          [{ host, basePayTo: payToFor(8), stellarPayTo: Keypair.random().publicKey() }],
          new Map(),
          async (challengeForUrl) => {
            let signed = 0;
            const paidNetworks: string[] = [];
            const summary = await runL1Batch({
              limit: 10,
              getPayerUsdcBalance: FUNDED_PAYER,
              createStellarPayment: async () => {
                signed++;
                return { transaction: "must-not-sign" };
              },
              fetchImpl: async (url: string, init?: RequestInit) => {
                const headers = new Headers(init?.headers);
                const raw = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
                if (!raw) {
                  return new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } });
                }
                const envelope = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { accepted: { network: string } };
                paidNetworks.push(envelope.accepted.network);
                return new Response(JSON.stringify({ data: "base goods" }), {
                  status: 200,
                  headers: {
                    "content-type": "application/json",
                    "PAYMENT-RESPONSE": Buffer.from(
                      JSON.stringify({ success: true, transaction: `0x${"cd".repeat(32)}`, network: "eip155:8453" }),
                    ).toString("base64"),
                  },
                });
              },
            });
            assert.equal(summary.laneFloor.stellar, 1, "別枠が 0 でも secondary の候補は枠に残る");
            assert.equal(signed, 0, "別枠が尽きているので Stellar には署名しない");
            assert.deepEqual(paidNetworks, ["eip155:8453"]);
            const rows = await db.select().from(schema.x402L1Purchases);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].network, "eip155:8453");
            assert.equal(JSON.stringify(rows).includes(payer.secret()), false);
          },
        );
      } finally {
        restoreStellarEnv();
      }
    });

    // BNB secondary（2026-10-19・段B2b）。Base が先頭、eip155:56 の USD1（eip3009・18 桁）が 2 番目。
    // 額は Base 100000（6 桁・$0.10）と USD1 1e17（18 桁・同じ $0.10）。台帳は 6 桁の 100000。
    // 署名はランナーの EVM 経路（テスト鍵）。残高はスタブ。RPC には出ない。
    const BNB_ENV = ["OBSERVATORY_BNB_L1_ENABLED", "BNB_RPC_URL", "L1_BNB_DAILY_CAP_USD"] as const;
    const savedBnbEnv = Object.fromEntries(BNB_ENV.map((k) => [k, process.env[k]]));
    const restoreBnbEnv = () => {
      for (const k of BNB_ENV) {
        const v = savedBnbEnv[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    };
    t.after(restoreBnbEnv);
    const bnbBaseAmount = "100000";
    const dualUsd1 = "100000000000000000";
    const { BNB_CAIP2, BNB_USD1 } = await import("@/lib/observatory/x402-payer");
    const { privateKeyToAccount } = await import("viem/accounts");
    const bnbPayer = privateKeyToAccount(TEST_PK as `0x${string}`);
    const usd1Extra = { name: "World Liberty Financial USD", version: "1", assetTransferMethod: "eip3009" };
    async function withDualBnb(
      items: { host: string; basePayTo: string; bnbPayTo: string }[],
      wall: ReadonlyMap<string, { bnbPayTo?: string; bnbAccepts?: Record<string, unknown>[] }>,
      run: (challengeForUrl: (url: string) => string) => Promise<void>,
    ) {
      const challengeForUrl = (url: string) => {
        const item = items.find((i) => url.includes(i.host));
        if (!item) return challengeFor(url);
        const over = wall.get(item.host);
        const bnbAccepts = over?.bnbAccepts ?? [
          {
            scheme: "exact",
            network: BNB_CAIP2,
            amount: dualUsd1,
            asset: BNB_USD1,
            payTo: over?.bnbPayTo ?? item.bnbPayTo,
            maxTimeoutSeconds: 60,
            extra: usd1Extra,
          },
        ];
        return JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              amount: bnbBaseAmount,
              asset: BASE_USDC,
              payTo: item.basePayTo,
              maxTimeoutSeconds: 300,
              extra: { name: "USD Coin", version: "2" },
            },
            ...bnbAccepts,
          ],
        });
      };
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      await syncCatalog({
        fetchResult: {
          items: items.map((item) =>
            parseCatalogItem({
              resource: `https://${item.host}/api`,
              accepts: [
                { scheme: "exact", amount: bnbBaseAmount, asset: BASE_USDC, network: "eip155:8453", payTo: item.basePayTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } },
                { scheme: "exact", amount: dualUsd1, asset: BNB_USD1, network: BNB_CAIP2, payTo: item.bnbPayTo, maxTimeoutSeconds: 60, extra: usd1Extra },
              ],
              extensions: { bazaar: { info: { input: { method: "GET" } } } },
              quality: { l30DaysTotalCalls: 1, l30DaysUniquePayers: 1 },
            }),
          ),
          totalCount: items.length,
          fetchedCount: items.length,
          complete: true,
        },
        today: "2026-10-19",
      });
      await runL0ProbeBatch({
        limit: 10,
        concurrency: 2,
        fetchImpl: async (url: string) =>
          new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } }),
      });
      try {
        await run(challengeForUrl);
      } finally {
        await restoreBaseCatalog();
      }
    }
    const enableBnb = () => {
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      process.env.OBSERVATORY_BNB_L1_ENABLED = "true";
      process.env.BNB_RPC_URL = "http://127.0.0.1:9";
    };
    const paidResponse = (network: string, n = 1) =>
      new Response(JSON.stringify({ data: "goods" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "PAYMENT-RESPONSE": Buffer.from(
            JSON.stringify({ success: true, transaction: `0x${n.toString(16).padStart(64, "0")}`, network }),
          ).toString("base64"),
        },
      });

    await t.test("BNB secondary: Base 先頭の出品をレーン枠から USD1 で買う", async () => {
      const host = "bnbdual.example";
      const bnbPayTo = payToFor(9);
      enableBnb();
      try {
        await withDualBnb([{ host, basePayTo: payToFor(8), bnbPayTo }], new Map(), async (challengeForUrl) => {
          const chains: string[] = [];
          let signedValue = "";
          const summary = await runL1Batch({
            limit: 10,
            getPayerUsdcBalance: async ({ chain }) => {
              chains.push(chain);
              return 1_000_000_000n;
            },
            fetchImpl: async (url: string, init?: RequestInit) => {
              const headers = new Headers(init?.headers);
              const raw = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
              if (!raw) return new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } });
              const envelope = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as {
                accepted: { network: string };
                payload: { authorization: { value: string; to: string } };
              };
              assert.equal(envelope.accepted.network, BNB_CAIP2);
              signedValue = envelope.payload.authorization.value;
              assert.equal(envelope.payload.authorization.to.toLowerCase(), bnbPayTo);
              return paidResponse(BNB_CAIP2);
            },
          });
          assert.equal(summary.laneFloor.bnb, 1, "レーン枠に載る");
          assert.equal(signedValue, dualUsd1, "署名する額は 18 桁");
          assert.ok(chains.includes("bnb"), "payerChain は bnb");
          assert.equal(chains.includes("base"), false);
          const rows = await db.select().from(schema.x402L1Purchases);
          assert.equal(rows.length, 1);
          assert.equal(rows[0].network, BNB_CAIP2);
          assert.equal(rows[0].asset, BNB_USD1);
          assert.equal(rows[0].payTo, bnbPayTo);
          assert.equal(rows[0].payer, bnbPayer.address.toLowerCase());
          assert.equal(rows[0].amountUnits, "100000", "台帳は 6 桁。1e17 USD1 = $0.10");
          assert.equal(rows[0].spentUnits, "100000");
          assert.equal(rows[0].status, "settle_claimed");
        });
      } finally {
        restoreBnbEnv();
      }
    });

    await t.test("BNB secondary: 宣言の payTo と違う壁は払わず Base へ落とす", async () => {
      const host = "bnbdual.example";
      const basePayTo = payToFor(8);
      enableBnb();
      try {
        await withDualBnb(
          [{ host, basePayTo, bnbPayTo: payToFor(9) }],
          new Map([[host, { bnbPayTo: basePayTo }]]),
          async (challengeForUrl) => {
            const paidNetworks: string[] = [];
            await runL1Batch({
              limit: 10,
              getPayerUsdcBalance: FUNDED_PAYER,
              fetchImpl: async (url: string, init?: RequestInit) => {
                const headers = new Headers(init?.headers);
                const raw = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
                if (!raw) return new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } });
                const envelope = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { accepted: { network: string; payTo: string } };
                paidNetworks.push(envelope.accepted.network);
                assert.equal(envelope.accepted.payTo.toLowerCase(), basePayTo);
                return paidResponse("eip155:8453");
              },
            });
            assert.deepEqual(paidNetworks, ["eip155:8453"]);
            const rows = await db.select().from(schema.x402L1Purchases);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].network, "eip155:8453");
            assert.equal(rows[0].payTo, basePayTo);
          },
        );
      } finally {
        restoreBnbEnv();
      }
    });

    await t.test("BNB secondary: 未入金なら優先を閉じ、その候補は Base で買う", async () => {
      const hosts = ["bnbdual1.example", "bnbdual2.example"];
      enableBnb();
      try {
        await withDualBnb(
          hosts.map((host, i) => ({ host, basePayTo: payToFor(8 + i), bnbPayTo: payToFor(4 + i) })),
          new Map(),
          async (challengeForUrl) => {
            let bnbChecks = 0;
            let paidN = 0;
            const summary = await runL1Batch({
              limit: 10,
              getPayerUsdcBalance: async ({ chain }) => {
                if (chain === "bnb") {
                  bnbChecks++;
                  return 0n;
                }
                return 1_000_000_000n;
              },
              fetchImpl: async (url: string, init?: RequestInit) => {
                const headers = new Headers(init?.headers);
                const raw = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
                if (!raw) return new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } });
                paidN++;
                const envelope = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { accepted: { network: string } };
                assert.equal(envelope.accepted.network, "eip155:8453");
                return paidResponse("eip155:8453", paidN);
              },
            });
            assert.equal(summary.laneFloor.bnb, 2);
            assert.equal(bnbChecks, 1, "1 件目の未入金で以後の bnb の優先を閉じる");
            assert.equal(summary.payerUnfunded, 1);
            const rows = await db.select().from(schema.x402L1Purchases);
            assert.equal(rows.length, 2, "未入金の候補も、次の候補も Base で買う");
            assert.ok(rows.every((r) => r.network === "eip155:8453"));
          },
        );
      } finally {
        restoreBnbEnv();
      }
    });

    await t.test("BNB secondary: 旗 OFF なら枠に bnb が出ず、Base で買う", async () => {
      const host = "bnbdual.example";
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      delete process.env.OBSERVATORY_BNB_L1_ENABLED;
      delete process.env.BNB_RPC_URL;
      try {
        await withDualBnb([{ host, basePayTo: payToFor(8), bnbPayTo: payToFor(9) }], new Map(), async (challengeForUrl) => {
          const paidNetworks: string[] = [];
          const summary = await runL1Batch({
            limit: 10,
            getPayerUsdcBalance: FUNDED_PAYER,
            fetchImpl: async (url: string, init?: RequestInit) => {
              const headers = new Headers(init?.headers);
              const raw = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
              if (!raw) return new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } });
              const envelope = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { accepted: { network: string } };
              paidNetworks.push(envelope.accepted.network);
              return paidResponse("eip155:8453");
            },
          });
          assert.equal(summary.laneFloor.bnb ?? 0, 0, "旗 OFF の secondary 枠に bnb は出ない");
          assert.deepEqual(paidNetworks, ["eip155:8453"]);
          const rows = await db.select().from(schema.x402L1Purchases);
          assert.equal(rows.length, 1);
          assert.equal(rows[0].network, "eip155:8453");
        });
      } finally {
        restoreBnbEnv();
      }
    });

    await t.test("BNB secondary: USD1 以外（permit2・USDT）だけの壁は Base で買う", async () => {
      const host = "bnbdual.example";
      const basePayTo = payToFor(8);
      const usdt = "0x55d398326f99059fF775485246999027B3197955";
      enableBnb();
      try {
        await withDualBnb(
          [{ host, basePayTo, bnbPayTo: payToFor(9) }],
          new Map([
            [
              host,
              {
                bnbAccepts: [
                  {
                    scheme: "exact",
                    network: BNB_CAIP2,
                    amount: dualUsd1,
                    asset: BNB_USD1,
                    payTo: payToFor(9),
                    maxTimeoutSeconds: 60,
                    extra: { name: "World Liberty Financial USD", version: "1", assetTransferMethod: "permit2" },
                  },
                  {
                    scheme: "exact",
                    network: BNB_CAIP2,
                    amount: dualUsd1,
                    asset: usdt,
                    payTo: payToFor(9),
                    maxTimeoutSeconds: 60,
                    extra: { name: "Tether USD", version: "1", assetTransferMethod: "eip3009" },
                  },
                ],
              },
            ],
          ]),
          async (challengeForUrl) => {
            const chains: string[] = [];
            const paidNetworks: string[] = [];
            await runL1Batch({
              limit: 10,
              getPayerUsdcBalance: async ({ chain }) => {
                chains.push(chain);
                return 1_000_000_000n;
              },
              fetchImpl: async (url: string, init?: RequestInit) => {
                const headers = new Headers(init?.headers);
                const raw = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
                if (!raw) return new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } });
                const envelope = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { accepted: { network: string } };
                paidNetworks.push(envelope.accepted.network);
                return paidResponse("eip155:8453");
              },
            });
            assert.deepEqual(paidNetworks, ["eip155:8453"]);
            assert.equal(chains.includes("bnb"), false, "USD1 の eip3009 が無いので bnb の残高は見ない");
            const rows = await db.select().from(schema.x402L1Purchases);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].network, "eip155:8453");
            assert.equal(rows[0].payTo, basePayTo);
          },
        );
      } finally {
        restoreBnbEnv();
      }
    });

    await t.test("BNB secondary: 別枠が尽きた日は bnb を開かず Base で買う", async () => {
      const host = "bnbdual.example";
      enableBnb();
      process.env.L1_BNB_DAILY_CAP_USD = "0";
      try {
        await withDualBnb([{ host, basePayTo: payToFor(8), bnbPayTo: payToFor(9) }], new Map(), async (challengeForUrl) => {
          const chains: string[] = [];
          const paidNetworks: string[] = [];
          const summary = await runL1Batch({
            limit: 10,
            getPayerUsdcBalance: async ({ chain }) => {
              chains.push(chain);
              return 1_000_000_000n;
            },
            fetchImpl: async (url: string, init?: RequestInit) => {
              const headers = new Headers(init?.headers);
              const raw = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
              if (!raw) return new Response(challengeForUrl(url), { status: 402, headers: { "content-type": "application/json" } });
              const envelope = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as { accepted: { network: string } };
              paidNetworks.push(envelope.accepted.network);
              return paidResponse("eip155:8453");
            },
          });
          assert.equal(summary.laneFloor.bnb, 1, "別枠が 0 でも secondary の候補は枠に残る");
          assert.equal(chains.includes("bnb"), false);
          assert.deepEqual(paidNetworks, ["eip155:8453"]);
          const rows = await db.select().from(schema.x402L1Purchases);
          assert.equal(rows.length, 1);
          assert.equal(rows[0].network, "eip155:8453");
        });
      } finally {
        restoreBnbEnv();
      }
    });

    async function seedBnbPrimary(host: string) {
      const payTo = payToFor(7);
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      await syncCatalog({
        fetchResult: {
          items: [
            parseCatalogItem({
              resource: `https://${host}/api`,
              accepts: [{ scheme: "exact", amount: dualUsd1, asset: BNB_USD1, network: BNB_CAIP2, payTo, maxTimeoutSeconds: 60, extra: usd1Extra }],
              extensions: { bazaar: { info: { input: { method: "GET" } } } },
              quality: { l30DaysTotalCalls: 8000, l30DaysUniquePayers: 80 },
            }),
          ],
          totalCount: 1,
          fetchedCount: 1,
          complete: true,
        },
        today: "2026-10-19",
      });
      const challenge = JSON.stringify({
        x402Version: 2,
        accepts: [{ scheme: "exact", network: BNB_CAIP2, amount: dualUsd1, asset: BNB_USD1, payTo, maxTimeoutSeconds: 60, extra: usd1Extra }],
      });
      await runL0ProbeBatch({
        limit: 5,
        concurrency: 1,
        fetchImpl: async () => new Response(challenge, { status: 402, headers: { "content-type": "application/json" } }),
      });
      return challenge;
    }

    await t.test("BNB primary: 旗 OFF でも eip155:56 が主ネットワークの行は候補に残る", async () => {
      const host = "bnbonly.example";
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      delete process.env.OBSERVATORY_BNB_L1_ENABLED;
      delete process.env.BNB_RPC_URL;
      try {
        const challenge = await seedBnbPrimary(host);
        const seen: string[] = [];
        let paid = 0;
        await runL1Batch({
          limit: 5,
          getPayerUsdcBalance: FUNDED_PAYER,
          fetchImpl: async (url: string, init?: RequestInit) => {
            seen.push(url);
            const headers = new Headers(init?.headers);
            if (headers.get("PAYMENT-SIGNATURE") || headers.get("X-PAYMENT")) paid++;
            return new Response(challenge, { status: 402, headers: { "content-type": "application/json" } });
          },
        });
        assert.ok(seen.some((u) => u.includes(host)), "旗 OFF でも main と同じく無払いの要求は出る");
        assert.equal(paid, 0, "旗 OFF では署名しない");
        const rows = await db.select().from(schema.x402L1Purchases);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].status, "no_eligible_accept");
      } finally {
        restoreBnbEnv();
        await restoreBaseCatalog();
      }
    });

    await t.test("BNB primary: 旗 ON でも BNB_RPC_URL が無いときは候補に触れない", async () => {
      const host = "bnbonly.example";
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      process.env.OBSERVATORY_BNB_L1_ENABLED = "true";
      delete process.env.BNB_RPC_URL;
      try {
        const challenge = await seedBnbPrimary(host);
        const seen: string[] = [];
        await runL1Batch({
          limit: 5,
          getPayerUsdcBalance: FUNDED_PAYER,
          fetchImpl: async (url: string) => {
            seen.push(url);
            return new Response(challenge, { status: 402, headers: { "content-type": "application/json" } });
          },
        });
        assert.ok(seen.every((u) => !u.includes(host)), "BNB_RPC_URL が無ければ 1 リクエストも出ない");
        const rows = await db.select().from(schema.x402L1Purchases);
        assert.equal(rows.length, 0);
      } finally {
        restoreBnbEnv();
        await restoreBaseCatalog();
      }
    });

    await t.test("旗 on で BNB_RPC_URL が無いとき、Base の accept が外れた出品でも BNB には署名しない", async () => {
      const host = "bnbfalloff.example";
      const basePayTo = payToFor(8);
      const bnbPayTo = payToFor(9);
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      process.env.OBSERVATORY_BNB_L1_ENABLED = "true";
      delete process.env.BNB_RPC_URL;
      const catalogBase = {
        scheme: "exact",
        amount: bnbBaseAmount,
        asset: BASE_USDC,
        network: "eip155:8453",
        payTo: basePayTo,
        maxTimeoutSeconds: 300,
        extra: { name: "USD Coin", version: "2" },
      };
      const catalogBnb = {
        scheme: "exact",
        amount: dualUsd1,
        asset: BNB_USD1,
        network: BNB_CAIP2,
        payTo: bnbPayTo,
        maxTimeoutSeconds: 60,
        extra: usd1Extra,
      };
      const badBase = { ...catalogBase, asset: "0x0000000000000000000000000000000000000001" };
      try {
        await db.execute(
          sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
        );
        await syncCatalog({
          fetchResult: {
            items: [
              parseCatalogItem({
                resource: `https://${host}/api`,
                accepts: [catalogBase, catalogBnb],
                extensions: { bazaar: { info: { input: { method: "GET" } } } },
                quality: { l30DaysTotalCalls: 100, l30DaysUniquePayers: 10 },
              }),
            ],
            totalCount: 1,
            fetchedCount: 1,
            complete: true,
          },
          today: "2026-10-19",
        });
        const honest = JSON.stringify({ x402Version: 2, accepts: [catalogBase, catalogBnb] });
        await runL0ProbeBatch({
          limit: 5,
          concurrency: 1,
          fetchImpl: async () => new Response(honest, { status: 402, headers: { "content-type": "application/json" } }),
        });
        const seen: string[] = [];
        const paidNetworks: string[] = [];
        await runL1Batch({
          limit: 10,
          getPayerUsdcBalance: FUNDED_PAYER,
          fetchImpl: async (url: string, init?: RequestInit) => {
            seen.push(url);
            const headers = new Headers(init?.headers);
            const sig = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
            if (sig) {
              const decoded = JSON.parse(Buffer.from(sig, "base64").toString("utf8")) as { accepted?: { network?: string } };
              paidNetworks.push(String(decoded.accepted?.network ?? ""));
            }
            return new Response(JSON.stringify({ x402Version: 2, accepts: [badBase, catalogBnb] }), {
              status: 402,
              headers: { "content-type": "application/json" },
            });
          },
        });
        assert.ok(seen.some((u) => u.includes(host)), "壁まで届いている（候補から外れただけ、ではない）");
        assert.equal(paidNetworks.length, 0, "署名しない");
        assert.ok(!paidNetworks.includes(BNB_CAIP2));
        const rows = await db.select().from(schema.x402L1Purchases);
        assert.ok(rows.length >= 1);
        assert.ok(rows.every((r) => r.network !== BNB_CAIP2));
        assert.ok(rows.every((r) => r.spentUnits === "0"));
      } finally {
        restoreBnbEnv();
        await restoreBaseCatalog();
      }
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
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER,
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
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER,
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

    await t.test("a listing with no declared payTo is never requested, so a wall naming the operator's own payTo is never reached", async () => {
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
        // 2026-09-29 監査 5 周目: カタログが受取先を申告していない出品は L1 で買わない（候補 SQL と purchaseOne の
        // isL1PurchasableListing）。以前はここで壁の payTo（運営者）を読み、運営者チェックで payto_operator_self を
        // 記録していた。今は壁に 1 リクエストも出さないので、運営者を名乗る壁にも届かない（行も書かない）。
        let requests = 0;
        const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER,
          onlyEndpointId: nullPayToEp.id,
          fetchImpl: async () => {
            requests++;
            return new Response(wall, { status: 402, headers: { "content-type": "application/json" } });
          },
        });
        assert.equal(summary.settled, 0);
        assert.equal(summary.attempted, 0, "署名も予約もしていない");
        assert.equal(requests, 0, "受取先を申告していない出品には要求を出さない");
        const rows = await db
          .select()
          .from(schema.x402L1Purchases)
          .where(eq(schema.x402L1Purchases.endpointId, nullPayToEp.id));
        assert.equal(rows.length, 0, "我々の側の見送りなので行は書かない");
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
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER,
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
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER,
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
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, fetchImpl, limit: 1 });
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
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER,
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
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, fetchImpl, limit: 1 });
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
        runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, fetchImpl: raceFetch, limit: 45 }),
        (async () => {
          await new Promise((r) => setTimeout(r, 25));
          return runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, fetchImpl: raceFetch, limit: 45 });
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
