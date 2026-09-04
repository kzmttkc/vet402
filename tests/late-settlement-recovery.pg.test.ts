// ============================================================
// 2026-09-04 金の経路監査 P2: settle_failed のあとに遅れて決済された分の分母整合。
//
// 署名した EIP-3009 は validBefore まで生きた金なので、売り手が我々の
// リクエストに応えなかった（settle_failed・tx_hash 無し）あとでも、窓の内側なら
// いつでも決済できる。台帳には「払っていない」と書いてあるのに、チェーンには
// 我々のホットウォレット発の Transfer が残る——公開している成立率と、
// オンチェーンの支出が食い違う。
//
// 直し方: 決済索引（settlements）は既に「既知の payTo への USDC Transfer」を
// 読んでいるので、そこから **我々の payer 発・その endpoint の payTo 宛・
// 期待額ちょうど・試行時刻の窓の内側** の tx を拾い、tx_hash の無い
// settle_failed 行へ結びつける。
//
// 結びつけた行は `settle_claimed`（＝主張はあるが未照合）へ戻す。**settled とは
// 名乗らせない**——照合器がこの行を拾って、EIP-3009 nonce の束縛まで含めた
// フル照合をしてから settled / settle_claim_refuted を決める。
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/late-settlement-recovery.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("late settlement recovery (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  const PAY_TO = "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";
  const PAYER = "0x6777e11fb0a7917b8110b7dab9188aa3f6d23986";
  const CHAIN = "eip155:8453";

  test("遅れて決済された settle_failed を tx に結びつける", async (t) => {
    const { recoverLateSettlements } = await import("@/lib/settlements/recover-late");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;

    const attemptedAt = new Date("2026-09-03T10:00:00Z");

    const reset = () =>
      db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, settlements, correction_log`);

    const seedEndpoint = async () => {
      const endpointId = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id: endpointId,
        resourceKey: `GET https://seller.example/api/${endpointId}`,
        resourceUrl: `https://seller.example/api/${endpointId}`,
        method: "GET",
        payTo: PAY_TO,
        network: CHAIN,
        status: "active",
        lastSeenAt: new Date(),
      });
      return endpointId;
    };

    const seedFailedPurchase = async (endpointId: string, amount = "1000") => {
      const [row] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId,
          status: "settle_failed",
          network: CHAIN,
          payTo: PAY_TO,
          payer: PAYER,
          amountUnits: amount,
          spentUnits: amount,
          attemptedAt,
          txHash: null,
        })
        .returning();
      return row.id;
    };

    const seedSettlement = async (txHash: string, amount: string, blockTime: Date) => {
      await db.insert(schema.settlements).values({
        chain: CHAIN,
        txHash,
        purchaseId: `${CHAIN}:${txHash}`,
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        amount,
        payer: PAYER,
        payee: PAY_TO,
        blockTime,
        source: "chain_index",
        attribution: "confirmed",
      });
    };

    await t.test("窓の内側の一致は settle_claimed へ戻り、tx_hash が入る", async () => {
      await reset();
      const endpointId = await seedEndpoint();
      const purchaseId = await seedFailedPurchase(endpointId);
      const tx = `0x${"11".repeat(32)}`;
      await seedSettlement(tx, "1000", new Date(attemptedAt.getTime() + 90_000));

      const summary = await recoverLateSettlements();
      assert.equal(summary.recovered, 1);

      const [row] = await db
        .select()
        .from(schema.x402L1Purchases)
        .where(eq(schema.x402L1Purchases.id, purchaseId));
      assert.equal(row.status, "settle_claimed", "settled を名乗らせてはいけない（未照合）");
      assert.equal(row.txHash, tx);
      assert.equal(row.settlementVerified, null, "照合前なのに結論が入っている");
    });

    await t.test("金額が違う tx は結びつけない", async () => {
      await reset();
      const endpointId = await seedEndpoint();
      const purchaseId = await seedFailedPurchase(endpointId, "1000");
      await seedSettlement(`0x${"22".repeat(32)}`, "999", new Date(attemptedAt.getTime() + 90_000));

      assert.equal((await recoverLateSettlements()).recovered, 0);
      const [row] = await db
        .select()
        .from(schema.x402L1Purchases)
        .where(eq(schema.x402L1Purchases.id, purchaseId));
      assert.equal(row.status, "settle_failed");
    });

    await t.test("窓の外（遅すぎる）tx は結びつけない", async () => {
      await reset();
      const endpointId = await seedEndpoint();
      await seedFailedPurchase(endpointId);
      await seedSettlement(`0x${"33".repeat(32)}`, "1000", new Date(attemptedAt.getTime() + 6 * 3600_000));
      assert.equal((await recoverLateSettlements()).recovered, 0);
    });

    await t.test("既に別の購入が使っている tx は結びつけない", async () => {
      await reset();
      const a = await seedEndpoint();
      const b = await seedEndpoint();
      const tx = `0x${"44".repeat(32)}`;
      await db.insert(schema.x402L1Purchases).values({
        endpointId: a,
        status: "settled",
        network: CHAIN,
        payTo: PAY_TO,
        payer: PAYER,
        amountUnits: "1000",
        spentUnits: "1000",
        txHash: tx,
        settlementVerified: true,
      });
      const late = await seedFailedPurchase(b);
      await seedSettlement(tx, "1000", new Date(attemptedAt.getTime() + 60_000));

      assert.equal((await recoverLateSettlements()).recovered, 0);
      const [row] = await db
        .select()
        .from(schema.x402L1Purchases)
        .where(eq(schema.x402L1Purchases.id, late));
      assert.equal(row.status, "settle_failed");
    });

    await t.test("1 本の tx を 2 つの settle_failed へ同時に貼らない", async () => {
      await reset();
      const a = await seedEndpoint();
      const b = await seedEndpoint();
      await seedFailedPurchase(a);
      await seedFailedPurchase(b);
      await seedSettlement(`0x${"55".repeat(32)}`, "1000", new Date(attemptedAt.getTime() + 60_000));

      const summary = await recoverLateSettlements();
      assert.equal(summary.recovered, 1, "同じ tx を 2 行へ貼っている");
    });
  });
}
