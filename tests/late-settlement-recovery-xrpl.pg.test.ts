// ============================================================
// XRPL の遅延決済の回収（2026-09-19）: index-xrpl → recover-late を本番の配線のまま 1 本通す。
//
// XRPL では署名済み blob の hash が tx の hash そのもので、提出前に我々だけが知っている
// （l1-runner が x402_l1_purchases.auth_nonce に残す）。EVM の索引には EIP-3009 の nonce が無いので
// 回収は払い元・宛先・額・窓までしか見られないが、XRPL は索引の tx_hash と auth_nonce を直接比べられる。
//
// 守ること:
//  1. 正例: account_tx に載った RLUSD の受取が索引（settlements）へ入り、払い元・宛先・額・窓に加えて
//     tx の hash が auth_nonce と一致する行だけが settle_claimed へ戻る（settled とは名乗らせない）。
//  2. 負例: hash が違う（同じ売り手への同額の別の支払い）・額が違う・宛先が違う受取では回収しない。
//  3. auth_nonce の無い XRPL の行は回収しない（何に署名したか分からない行に、額と宛先だけで tx を貼らない）。
//
// RPC は XRPL_RPC_URL への fetch を偽の account_tx に差し替える（ネットワークへは出ない）。
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/late-settlement-recovery-xrpl.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("late settlement recovery xrpl (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const CHAIN = "xrpl:0";
  const RPC_URL = "https://xrpl.invalid:51234/";
  const PAYER = "rn1E1zyZY5LuZfzds7DfJVL3ZVcNq1XrKt";
  const PAYEE = "rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32";
  /** カタログに載っている別の売り手（宛先違いの受取も索引には入る）。 */
  const OTHER_PAYEE = "rG31cLyErnqeVj2eomEjBZtq7PYaupGYzL";
  const SIGNED_HASH = "A1".repeat(32);
  const OTHER_HASH = "B2".repeat(32);

  test("XRPL: index-xrpl → recover-late は署名済み blob の hash で結びつける", async (t) => {
    const { indexXrpl, XRPL_X402_SOURCE_TAG } = await import("@/lib/settlements/index-xrpl");
    const { recoverLateSettlements } = await import("@/lib/settlements/recover-late");
    const { RLUSD_CURRENCY_HEX, RLUSD_ISSUER } = await import("@/lib/observatory/xrpl402-payer");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;

    const attemptedAt = new Date("2026-09-18T10:00:00Z");

    const saved: Record<string, string | undefined> = {};
    for (const k of ["XRPL_RPC_URL", "OBSERVATORY_XRPL_INDEX_ENABLED"]) saved[k] = process.env[k];
    const realFetch = globalThis.fetch;
    t.after(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      globalThis.fetch = realFetch;
    });
    process.env.XRPL_RPC_URL = RPC_URL;
    delete process.env.OBSERVATORY_XRPL_INDEX_ENABLED;

    type Delivery = { hash: string; destination: string; value: string; closeTime: Date; ledgerIndex: number };
    /** XRPL_RPC_URL への account_tx だけに答える。他の宛先への fetch はテストの誤りなので落とす。 */
    const serveAccountTx = (deliveries: Delivery[]) => {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(String(input), RPC_URL, "XRPL_RPC_URL 以外へ出ている");
        const body = JSON.parse(String(init?.body)) as { method: string; params: [{ account: string }] };
        assert.equal(body.method, "account_tx");
        const account = body.params[0].account;
        const transactions = deliveries
          .filter((d) => d.destination === account)
          .map((d) => ({
            validated: true,
            hash: d.hash,
            ledger_index: d.ledgerIndex,
            close_time_iso: d.closeTime.toISOString(),
            tx_json: { TransactionType: "Payment", Account: PAYER, Destination: d.destination, SourceTag: XRPL_X402_SOURCE_TAG },
            meta: { TransactionResult: "tesSUCCESS", delivered_amount: { currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_ISSUER, value: d.value } },
          }));
        return new Response(JSON.stringify({ result: { status: "success", transactions } }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
    };

    const reset = () =>
      db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, settlements, correction_log, indexer_checkpoints`);

    /** 本番の形: Base が先頭・XRPL の RLUSD accept は raw_accepts の 2 番目（受取先はここから索引に入る）。 */
    const seedEndpoint = async (xrplPayTo: string) => {
      const endpointId = randomUUID();
      const basePayTo = "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";
      await db.insert(schema.x402Endpoints).values({
        id: endpointId,
        resourceKey: `GET https://seller.example/api/${endpointId}`,
        resourceUrl: `https://seller.example/api/${endpointId}`,
        method: "GET",
        payTo: basePayTo,
        network: "eip155:8453",
        status: "active",
        lastSeenAt: new Date(),
        rawAccepts: [
          { scheme: "exact", network: "eip155:8453", amount: "10000", asset: BASE_USDC, payTo: basePayTo },
          { scheme: "exact", network: CHAIN, amount: "0.01", asset: RLUSD_CURRENCY_HEX, payTo: xrplPayTo, extra: { issuer: RLUSD_ISSUER } },
        ],
      });
      return endpointId;
    };

    const seedPurchase = async (endpointId: string, over: { status?: string; authNonce?: string | null } = {}) => {
      const [row] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId,
          status: over.status ?? "settle_failed",
          network: CHAIN,
          asset: RLUSD_CURRENCY_HEX,
          payTo: PAYEE,
          payer: PAYER,
          amountUnits: "10000",
          spentUnits: "10000",
          attemptedAt,
          txHash: null,
          authNonce: over.authNonce === undefined ? SIGNED_HASH : over.authNonce,
        })
        .returning();
      return row.id;
    };
    const purchaseRow = async (id: string) =>
      (await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, id)))[0];
    const indexedHashes = async () => {
      const raw = await db.execute(sql`SELECT tx_hash FROM settlements WHERE chain = ${CHAIN} ORDER BY tx_hash`);
      return ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { tx_hash: string }[]).map((r) => r.tx_hash);
    };
    const delivery = (over: Partial<Delivery> = {}): Delivery => ({
      hash: SIGNED_HASH,
      destination: PAYEE,
      value: "0.01",
      closeTime: new Date(attemptedAt.getTime() + 90_000),
      ledgerIndex: 99_000_001,
      ...over,
    });

    for (const status of ["settle_failed", "delivered_no_receipt"]) {
      await t.test(`正例（${status}）: 索引に載った受取の hash が auth_nonce と一致すれば settle_claimed へ戻る`, async () => {
        await reset();
        const purchaseId = await seedPurchase(await seedEndpoint(PAYEE), { status });
        serveAccountTx([delivery()]);

        const indexed = await indexXrpl();
        assert.equal(indexed.skipped, undefined);
        assert.equal(indexed.inserted, 1);
        assert.deepEqual(await indexedHashes(), [SIGNED_HASH]);

        const summary = await recoverLateSettlements();
        assert.deepEqual(summary.links, [{ purchaseId, txHash: SIGNED_HASH }]);
        const row = await purchaseRow(purchaseId);
        assert.equal(row.status, "settle_claimed", "settled を名乗らせてはいけない（未照合）");
        assert.equal(row.txHash, SIGNED_HASH);
        assert.equal(row.settlementVerified, null, "照合前なのに結論が入っている");
      });
    }

    await t.test("負例: hash が違う受取（同じ売り手への同額の別の支払い）は、払い元・宛先・額・窓が合っても結びつけない", async () => {
      await reset();
      const purchaseId = await seedPurchase(await seedEndpoint(PAYEE));
      serveAccountTx([delivery({ hash: OTHER_HASH })]);

      assert.equal((await indexXrpl()).inserted, 1);
      assert.deepEqual(await indexedHashes(), [OTHER_HASH], "受取そのものは索引に入っている");
      assert.equal((await recoverLateSettlements()).recovered, 0);
      const row = await purchaseRow(purchaseId);
      assert.equal(row.status, "settle_failed");
      assert.equal(row.txHash, null);
    });

    await t.test("負例: 額が違う受取は結びつけない", async () => {
      await reset();
      const purchaseId = await seedPurchase(await seedEndpoint(PAYEE));
      serveAccountTx([delivery({ value: "0.02" })]);

      assert.equal((await indexXrpl()).inserted, 1);
      assert.equal((await recoverLateSettlements()).recovered, 0);
      assert.equal((await purchaseRow(purchaseId)).status, "settle_failed");
    });

    await t.test("負例: 宛先が違う受取は結びつけない", async () => {
      await reset();
      const purchaseId = await seedPurchase(await seedEndpoint(PAYEE));
      await seedEndpoint(OTHER_PAYEE);
      serveAccountTx([delivery({ destination: OTHER_PAYEE })]);

      assert.equal((await indexXrpl()).inserted, 1);
      assert.equal((await recoverLateSettlements()).recovered, 0);
      assert.equal((await purchaseRow(purchaseId)).status, "settle_failed");
    });

    await t.test("2 件の未決済の行に 1 本の受取: hash の合う行にだけ貼る（先に試行した行へ流れない）", async () => {
      await reset();
      const endpointId = await seedEndpoint(PAYEE);
      const earlier = await seedPurchase(endpointId, { authNonce: OTHER_HASH });
      const [laterRow] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId: await seedEndpoint(PAYEE),
          status: "settle_failed",
          network: CHAIN,
          asset: RLUSD_CURRENCY_HEX,
          payTo: PAYEE,
          payer: PAYER,
          amountUnits: "10000",
          spentUnits: "10000",
          attemptedAt: new Date(attemptedAt.getTime() + 60_000),
          txHash: null,
          authNonce: SIGNED_HASH,
        })
        .returning();
      serveAccountTx([delivery({ closeTime: new Date(attemptedAt.getTime() + 120_000) })]);

      await indexXrpl();
      const summary = await recoverLateSettlements();
      assert.deepEqual(summary.links, [{ purchaseId: laterRow.id, txHash: SIGNED_HASH }]);
      assert.equal((await purchaseRow(earlier)).status, "settle_failed");
    });

    await t.test("xrpl:0 以外の xrpl:* の行も hash の束縛を素通りしない", async () => {
      await reset();
      const OTHER_NET = "xrpl:1";
      const seedOn = async (authNonce: string) => {
        const [row] = await db
          .insert(schema.x402L1Purchases)
          .values({ endpointId: await seedEndpoint(PAYEE), status: "settle_failed", network: OTHER_NET, asset: RLUSD_CURRENCY_HEX, payTo: PAYEE, payer: PAYER, amountUnits: "10000", spentUnits: "10000", attemptedAt, txHash: null, authNonce })
          .returning();
        return row.id;
      };
      const wrong = await seedOn(OTHER_HASH);
      await db.insert(schema.settlements).values({
        chain: OTHER_NET,
        txHash: SIGNED_HASH,
        purchaseId: `${OTHER_NET}:${SIGNED_HASH}`,
        asset: RLUSD_CURRENCY_HEX,
        amount: "10000",
        payer: PAYER,
        payee: PAYEE,
        blockTime: new Date(attemptedAt.getTime() + 90_000),
        source: "chain_index",
        attribution: "probable",
      });
      assert.equal((await recoverLateSettlements()).recovered, 0, "hash の合わない行へ貼っている");
      assert.equal((await purchaseRow(wrong)).status, "settle_failed");
      const right = await seedOn(SIGNED_HASH);
      assert.deepEqual((await recoverLateSettlements()).links, [{ purchaseId: right, txHash: SIGNED_HASH }]);
    });

    await t.test("auth_nonce の無い XRPL の行は回収しない", async () => {
      await reset();
      const purchaseId = await seedPurchase(await seedEndpoint(PAYEE), { authNonce: null });
      serveAccountTx([delivery()]);

      assert.equal((await indexXrpl()).inserted, 1);
      assert.equal((await recoverLateSettlements()).recovered, 0);
      assert.equal((await purchaseRow(purchaseId)).status, "settle_failed");
    });
  });
}
