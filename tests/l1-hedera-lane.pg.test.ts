// ============================================================
// L1 の Hedera レーン（2026-11-27）— 目録（Blocky402）→ 候補 → 署名 → 台帳。
//
// 守ること:
//  1. 旗 ON・口座と鍵あり: Blocky402 の hedera:mainnet の出品を HBAR で 1 件買い、台帳の行は
//     network hedera:mainnet・asset 0.0.0・payer 0.0.x・auth_nonce は署名した取引 ID・amount_units / spent_units は
//     ネットワークの為替で切り上げた USD 6 桁・raw_response_meta.hedera.nativeAmount は払った tinybar。
//  2. 旗 OFF: hedera:mainnet の出品には無払いの要求も出さない（EVM の selectAccept へ落とさない）。行も書かない。
//  3. 合計の上限（L1_HEDERA_TOTAL_CAP_TINYBARS）に届いたら署名しない。行も書かない。
//  4. 為替が読めない: 署名しない・行を書かない（我々の側の故障を売り手の行にしない）。
// ネットワークには出ない（402・mirror node・署名器は全部差し替え）。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-hedera-lane.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const FUNDED_PAYER = async () => 1_000_000_000n;
const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 hedera lane (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  // 試験用の固定の secp256k1 鍵（本物の Hedera 口座の鍵ではない）。
  const HEDERA_TEST_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const PAYER = "0.0.10968738";
  const PAY_TO = "0.0.10963430";
  const FEE_PAYER = "0.0.10571514";
  const TXID = "0.0.10571514@1795739901.710706809";
  const RESOURCE = "https://hederaseller.example/v1/util/id-mint";
  const RATE = { centEquivalent: 162213n, hbarEquivalent: 30000n, expirationTime: 1795741200 };

  test("L1 Hedera lane", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BLOCKY402_DISCOVERY_SOURCE } = await import("@/lib/observatory/blocky402-discovery");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const KEYS = [
      "OBSERVATORY_L1_ENABLED",
      "OBSERVATORY_WALLET_PRIVATE_KEY",
      "OBSERVATORY_HEDERA_L1_ENABLED",
      "HEDERA_PAYER_ACCOUNT_ID",
      "HEDERA_PAYER_PRIVATE_KEY",
      "HEDERA_L1_NETWORK",
      "L1_HEDERA_TOTAL_CAP_TINYBARS",
      "L1_HEDERA_DAILY_CAP_USD",
    ] as const;
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    t.after(() => {
      for (const k of KEYS) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    const arm = (hedera: boolean) => {
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      if (hedera) process.env.OBSERVATORY_HEDERA_L1_ENABLED = "true";
      else delete process.env.OBSERVATORY_HEDERA_L1_ENABLED;
      process.env.HEDERA_PAYER_ACCOUNT_ID = PAYER;
      process.env.HEDERA_PAYER_PRIVATE_KEY = HEDERA_TEST_KEY;
      delete process.env.HEDERA_L1_NETWORK;
      delete process.env.L1_HEDERA_TOTAL_CAP_TINYBARS;
      delete process.env.L1_HEDERA_DAILY_CAP_USD;
    };

    // 2026-11-27 実測の Blocky402 の目録の形（目録の額 5,802,334・壁の額 5,473,255 tinybar）。
    const hederaAccept = (amount: string) => ({
      scheme: "exact",
      network: "hedera:mainnet",
      asset: "0.0.0",
      amount,
      payTo: PAY_TO,
      maxTimeoutSeconds: 120,
      extra: { invoiceId: "aw-test", feePayer: FEE_PAYER, facilitator: "blocky402", assetSymbol: "HBAR" },
    });
    const challenge = JSON.stringify({ x402Version: 2, accepts: [hederaAccept("5473255")] });

    async function seed() {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      const item = parseCatalogItem({
        resource: RESOURCE,
        type: "http",
        x402Version: 2,
        accepts: [hederaAccept("5802334")],
        extensions: { bazaar: { info: { input: { type: "http", method: "GET" } } } },
      });
      await syncCatalog({ fetchResult: { items: [item], totalCount: 1, fetchedCount: 1, complete: true }, today: "2026-11-27", source: BLOCKY402_DISCOVERY_SOURCE });
      await runL0ProbeBatch({
        limit: 10,
        concurrency: 1,
        fetchImpl: async () => new Response(challenge, { status: 402, headers: { "content-type": "application/json" } }),
      });
    }

    const wall = () => {
      const seen: { url: string; paid: boolean; header?: string }[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const header = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT") ?? undefined;
        seen.push({ url, paid: !!header, header });
        if (!header) return new Response(challenge, { status: 402, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ op: "id_mint", ids: ["01a1c3c3-062d-7d93-b38b-d0fc1d58bd41"] }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: true, transaction: TXID, network: "hedera:mainnet", payer: PAYER })).toString("base64"),
          },
        });
      };
      return { seen, fetchImpl };
    };

    await t.test("旗 ON: Blocky402 の出品を HBAR で 1 件買い、台帳に tinybar と取引 ID を残す", async () => {
      arm(true);
      await seed();
      const w = wall();
      const signed: { tinybars: bigint; network: string }[] = [];
      const summary = await runL1Batch({
        limit: 5,
        getPayerUsdcBalance: FUNDED_PAYER,
        readHederaRate: async () => RATE,
        createHederaPayment: async (input) => {
          signed.push({ tinybars: input.tinybars, network: input.network });
          return { transaction: Buffer.from("signed-hedera-transfer").toString("base64"), transactionId: TXID };
        },
        fetchImpl: w.fetchImpl,
      });
      assert.equal(signed.length, 1, "署名は 1 回");
      assert.equal(signed[0].tinybars, 5_473_255n, "壁の額（宣言以下）で署名する");
      assert.equal(signed[0].network, "hedera:mainnet");
      assert.equal(summary.attemptsByNetwork["hedera:mainnet"], 1);
      const paid = w.seen.find((s) => s.paid);
      assert.ok(paid, "支払い付きの要求を出す");
      const decoded = JSON.parse(Buffer.from(paid.header!, "base64").toString("utf8")) as {
        x402Version: number;
        accepted?: { network?: string; extra?: Record<string, unknown> };
        payload?: { transaction?: string };
      };
      assert.equal(decoded.x402Version, 2);
      assert.equal(decoded.accepted?.network, "hedera:mainnet");
      assert.equal(decoded.accepted?.extra?.invoiceId, "aw-test", "壁の extra（invoiceId）をそのまま返す");
      assert.equal(decoded.payload?.transaction, Buffer.from("signed-hedera-transfer").toString("base64"));

      const rows = await db.select().from(schema.x402L1Purchases);
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.equal(row.status, "settle_claimed");
      assert.equal(row.network, "hedera:mainnet");
      assert.equal(row.asset, "0.0.0");
      assert.equal(row.payTo, PAY_TO);
      assert.equal(row.payer, PAYER);
      assert.equal(row.txHash, TXID);
      assert.equal(row.authNonce, TXID, "auth_nonce は署名した取引 ID");
      // 5,473,255 tinybar × 162213 / (30000 × 1e4) = 2959.4… → 2960
      assert.equal(row.amountUnits, "2960");
      assert.equal(row.spentUnits, "2960");
      const meta = row.rawResponseMeta as { hedera?: { nativeAmount?: string; asset?: string; feePayer?: string; exchangeRate?: { centEquivalent?: string } } };
      assert.equal(meta.hedera?.nativeAmount, "5473255");
      assert.equal(meta.hedera?.asset, "0.0.0");
      assert.equal(meta.hedera?.feePayer, FEE_PAYER);
      assert.equal(meta.hedera?.exchangeRate?.centEquivalent, "162213");
      assert.equal(JSON.stringify(rows).includes(HEDERA_TEST_KEY.slice(2)), false, "鍵は台帳に出ない");
    });

    await t.test("旗 OFF: hedera:mainnet の出品に要求を出さず、行も書かない", async () => {
      arm(false);
      await seed();
      const w = wall();
      let signed = 0;
      await runL1Batch({
        limit: 5,
        getPayerUsdcBalance: FUNDED_PAYER,
        readHederaRate: async () => RATE,
        createHederaPayment: async () => {
          signed++;
          return { transaction: "x", transactionId: TXID };
        },
        fetchImpl: w.fetchImpl,
      });
      assert.equal(signed, 0);
      assert.equal(w.seen.filter((s) => s.url.startsWith(RESOURCE)).length, 0, "無払いの要求も出さない");
      const rows = await db.select().from(schema.x402L1Purchases);
      assert.equal(rows.length, 0);
    });

    await t.test("合計の上限に届いたら署名しない・行を書かない", async () => {
      arm(true);
      process.env.L1_HEDERA_TOTAL_CAP_TINYBARS = "5000000"; // 0.05 HBAR < 壁の 0.0547 HBAR
      await seed();
      const w = wall();
      let signed = 0;
      await runL1Batch({
        limit: 5,
        getPayerUsdcBalance: FUNDED_PAYER,
        readHederaRate: async () => RATE,
        createHederaPayment: async () => {
          signed++;
          return { transaction: "x", transactionId: TXID };
        },
        fetchImpl: w.fetchImpl,
      });
      assert.equal(signed, 0);
      assert.equal(w.seen.filter((s) => s.paid).length, 0);
      const rows = await db.select().from(schema.x402L1Purchases);
      assert.equal(rows.length, 0);
    });

    await t.test("為替が読めないときは署名しない・行を書かない", async () => {
      arm(true);
      await seed();
      const w = wall();
      let signed = 0;
      await runL1Batch({
        limit: 5,
        getPayerUsdcBalance: FUNDED_PAYER,
        readHederaRate: async () => {
          throw new Error("hedera_mirror_http_503");
        },
        createHederaPayment: async () => {
          signed++;
          return { transaction: "x", transactionId: TXID };
        },
        fetchImpl: w.fetchImpl,
      });
      assert.equal(signed, 0);
      const rows = await db.select().from(schema.x402L1Purchases);
      assert.equal(rows.length, 0);
    });
  });
}
