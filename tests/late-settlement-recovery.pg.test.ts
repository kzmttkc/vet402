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
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("late settlement recovery (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
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

    const seedSettlement = async (txHash: string, amount: string, blockTime: Date, over: { payer?: string; payee?: string } = {}) => {
      await db.insert(schema.settlements).values({
        chain: CHAIN,
        txHash,
        purchaseId: `${CHAIN}:${txHash}`,
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        amount,
        payer: over.payer ?? PAYER,
        payee: over.payee ?? PAY_TO,
        blockTime,
        source: "chain_index",
        attribution: "confirmed",
      });
    };

    /** 署名済みで決済が確定していない行（2026-09-19）。settle_claimed_unverifiable は売り手の形式不正な主張を tx_hash に持つ。 */
    const seedUnsettledPurchase = async (endpointId: string, status: string, txHash: string | null = null) => {
      const [row] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId,
          status,
          network: CHAIN,
          payTo: PAY_TO,
          payer: PAYER,
          amountUnits: "1000",
          spentUnits: "1000",
          attemptedAt,
          txHash,
          httpStatusPaid: 200,
        })
        .returning();
      return row.id;
    };
    const purchaseRow = async (id: string) =>
      (await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, id)))[0];

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

    // 2026-09-19 レビュー C1: 以前は「先に試行した行」へ貼っていた。EVM の索引には nonce が無いので、
    // 候補が 2 行以上ある tx はどちらのものか言えない。外れた行は照合器が nonce_not_used で落とす
    // ——推定で貼らない。
    await t.test("1 本の tx に候補の購入が 2 行あれば、どちらにも貼らない", async () => {
      await reset();
      const a = await seedFailedPurchase(await seedEndpoint());
      const b = await seedFailedPurchase(await seedEndpoint());
      await seedSettlement(`0x${"55".repeat(32)}`, "1000", new Date(attemptedAt.getTime() + 60_000));

      const summary = await recoverLateSettlements();
      assert.equal(summary.recovered, 0, "どちらの購入の決済か言えない tx を貼っている");
      for (const id of [a, b]) {
        const row = await purchaseRow(id);
        assert.equal(row.status, "settle_failed");
        assert.equal(row.txHash, null);
      }
    });

    // 2026-09-19: settle_failed 以外にも「署名したが決済を名指せていない」行がある。
    //   delivered_no_receipt        … 200 で品は来たがレシート無し（tx_hash は null）
    //   settle_claimed_unverifiable … 売り手の主張した識別子が形式不正（tx_hash にその原文）
    // どちらも署名は生きているので、索引に一致する決済が載れば同じ関門で回収する。
    await t.test("delivered_no_receipt も一致する決済で settle_claimed へ戻り、訂正ログに元の status が残る", async () => {
      await reset();
      const purchaseId = await seedUnsettledPurchase(await seedEndpoint(), "delivered_no_receipt");
      const tx = `0x${"66".repeat(32)}`;
      await seedSettlement(tx, "1000", new Date(attemptedAt.getTime() + 90_000));

      const summary = await recoverLateSettlements();
      assert.deepEqual(summary.links, [{ purchaseId, txHash: tx }]);
      const row = await purchaseRow(purchaseId);
      assert.equal(row.status, "settle_claimed", "settled を名乗らせてはいけない（未照合）");
      assert.equal(row.txHash, tx);
      assert.equal(row.settlementVerified, null);
      const late = (row.rawResponseMeta as { lateSettlement?: Record<string, unknown> }).lateSettlement;
      assert.equal(late?.priorStatus, "delivered_no_receipt");
      const log = await db.execute(sql`SELECT before, after FROM correction_log WHERE subject_id = ${purchaseId}`);
      const entries = (Array.isArray(log) ? log : (log as { rows?: unknown[] }).rows ?? []) as { before: Record<string, unknown>; after: Record<string, unknown> }[];
      assert.equal(entries.length, 1);
      assert.deepEqual(entries[0].before, { status: "delivered_no_receipt", txHash: null });
      assert.deepEqual(entries[0].after, { status: "settle_claimed", txHash: tx });
    });

    await t.test("settle_claimed_unverifiable は形式不正の主張を索引の tx に置き換え、原文を残す", async () => {
      await reset();
      const purchaseId = await seedUnsettledPurchase(await seedEndpoint(), "settle_claimed_unverifiable", "not-a-transaction-id");
      const tx = `0x${"77".repeat(32)}`;
      await seedSettlement(tx, "1000", new Date(attemptedAt.getTime() + 90_000));

      assert.equal((await recoverLateSettlements()).recovered, 1);
      const row = await purchaseRow(purchaseId);
      assert.equal(row.status, "settle_claimed");
      assert.equal(row.txHash, tx);
      const late = (row.rawResponseMeta as { lateSettlement?: Record<string, unknown> }).lateSettlement;
      assert.equal(late?.priorStatus, "settle_claimed_unverifiable");
      assert.equal(late?.replacedTxHash, "not-a-transaction-id");
    });

    await t.test("広げた status でも照合条件は同じ: 額・宛先・払い元・窓のどれか 1 つでも違えば結びつけない", async () => {
      const OTHER = "0x00000000000000000000000000000000000000aa";
      const inWindow = new Date(attemptedAt.getTime() + 90_000);
      const cases: { name: string; seed: () => Promise<void> }[] = [
        { name: "額が違う", seed: () => seedSettlement(`0x${"81".repeat(32)}`, "999", inWindow) },
        { name: "宛先が違う", seed: () => seedSettlement(`0x${"82".repeat(32)}`, "1000", inWindow, { payee: OTHER }) },
        { name: "払い元が違う", seed: () => seedSettlement(`0x${"83".repeat(32)}`, "1000", inWindow, { payer: OTHER }) },
        { name: "窓の外", seed: () => seedSettlement(`0x${"84".repeat(32)}`, "1000", new Date(attemptedAt.getTime() + 6 * 3600_000)) },
      ];
      for (const c of cases) {
        await reset();
        const noReceipt = await seedUnsettledPurchase(await seedEndpoint(), "delivered_no_receipt");
        const unverifiable = await seedUnsettledPurchase(await seedEndpoint(), "settle_claimed_unverifiable", "not-a-transaction-id");
        await c.seed();
        assert.equal((await recoverLateSettlements()).recovered, 0, c.name);
        assert.equal((await purchaseRow(noReceipt)).status, "delivered_no_receipt", c.name);
        const row = await purchaseRow(unverifiable);
        assert.equal(row.status, "settle_claimed_unverifiable", c.name);
        assert.equal(row.txHash, "not-a-transaction-id", c.name);
      }
    });

    await t.test("別の購入が既に使っている tx は、広げた status にも貼らない", async () => {
      await reset();
      const tx = `0x${"91".repeat(32)}`;
      await db.insert(schema.x402L1Purchases).values({
        endpointId: await seedEndpoint(),
        status: "settled",
        network: CHAIN,
        payTo: PAY_TO,
        payer: PAYER,
        amountUnits: "1000",
        spentUnits: "1000",
        txHash: tx,
        settlementVerified: true,
      });
      const noReceipt = await seedUnsettledPurchase(await seedEndpoint(), "delivered_no_receipt");
      const unverifiable = await seedUnsettledPurchase(await seedEndpoint(), "settle_claimed_unverifiable", "not-a-transaction-id");
      await seedSettlement(tx, "1000", new Date(attemptedAt.getTime() + 60_000));

      assert.equal((await recoverLateSettlements()).recovered, 0);
      assert.equal((await purchaseRow(noReceipt)).status, "delivered_no_receipt");
      assert.equal((await purchaseRow(unverifiable)).status, "settle_claimed_unverifiable");
    });

    await t.test("候補が status をまたいで 2 行以上ある tx も、どの行にも貼らない", async () => {
      await reset();
      const first = await seedFailedPurchase(await seedEndpoint());
      const second = await seedUnsettledPurchase(await seedEndpoint(), "delivered_no_receipt");
      const third = await seedUnsettledPurchase(await seedEndpoint(), "settle_claimed_unverifiable", "not-a-transaction-id");
      await seedSettlement(`0x${"92".repeat(32)}`, "1000", new Date(attemptedAt.getTime() + 60_000));

      const summary = await recoverLateSettlements();
      assert.equal(summary.recovered, 0, "どちらの購入の決済か言えない tx を貼っている");
      assert.equal((await purchaseRow(first)).status, "settle_failed");
      assert.equal((await purchaseRow(second)).status, "delivered_no_receipt");
      const row = await purchaseRow(third);
      assert.equal(row.status, "settle_claimed_unverifiable");
      assert.equal(row.txHash, "not-a-transaction-id");
    });

    await t.test("候補が 2 行の tx と 1 行の tx が並んでいれば、1 行の方だけ貼る", async () => {
      await reset();
      await seedFailedPurchase(await seedEndpoint());
      await seedFailedPurchase(await seedEndpoint());
      const [alone] = await db
        .insert(schema.x402L1Purchases)
        .values({ endpointId: await seedEndpoint(), status: "settle_failed", network: CHAIN, payTo: PAY_TO, payer: PAYER, amountUnits: "2000", spentUnits: "2000", attemptedAt, txHash: null })
        .returning();
      await seedSettlement(`0x${"94".repeat(32)}`, "1000", new Date(attemptedAt.getTime() + 60_000));
      const tx = `0x${"95".repeat(32)}`;
      await seedSettlement(tx, "2000", new Date(attemptedAt.getTime() + 60_000));

      assert.deepEqual((await recoverLateSettlements()).links, [{ purchaseId: alone.id, txHash: tx }]);
    });

    // レビュー C1 (b): 照合器が「この tx はこの購入のものではない」と取り消した tx は二度と拾わない。
    await t.test("照合器が取り消した tx（lateSettlement.rejectedTxHashes）は候補にしない。別の tx なら貼り、取り消しの記録は残る", async () => {
      await reset();
      const rejected = `0x${"A6".repeat(32)}`;
      const [seeded] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId: await seedEndpoint(),
          status: "settle_failed",
          network: CHAIN,
          payTo: PAY_TO,
          payer: PAYER,
          amountUnits: "1000",
          spentUnits: "1000",
          attemptedAt,
          txHash: null,
          rawResponseMeta: { phase: "paid", lateSettlement: { source: "settlements_index", priorStatus: "settle_failed", rejectedTxHashes: [rejected.toLowerCase()] } },
        })
        .returning();
      await seedSettlement(rejected, "1000", new Date(attemptedAt.getTime() + 60_000));
      assert.equal((await recoverLateSettlements()).recovered, 0, "取り消した tx をまた拾っている");
      assert.equal((await purchaseRow(seeded.id)).status, "settle_failed");

      const other = `0x${"a7".repeat(32)}`;
      await seedSettlement(other, "1000", new Date(attemptedAt.getTime() + 120_000));
      assert.deepEqual((await recoverLateSettlements()).links, [{ purchaseId: seeded.id, txHash: other }]);
      const late = ((await purchaseRow(seeded.id)).rawResponseMeta as { lateSettlement: Record<string, unknown> }).lateSettlement;
      assert.deepEqual(late.rejectedTxHashes, [rejected.toLowerCase()], "貼り直しで取り消しの記録が消えている");
      assert.equal(late.priorStatus, "settle_failed");
      assert.equal(late.txHash, other);
    });

    // レビュー W2: 回収した行は照合前。以前の照合の跡が残っていると照合器（settlement_verified IS NULL）が拾わない。
    await t.test("回収した行の settlement_verified / settlement_verify_reason は NULL に戻る", async () => {
      await reset();
      const [seeded] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId: await seedEndpoint(),
          status: "settle_failed",
          network: CHAIN,
          payTo: PAY_TO,
          payer: PAYER,
          amountUnits: "1000",
          spentUnits: "1000",
          attemptedAt,
          txHash: null,
          settlementVerified: false,
          settlementVerifyReason: "rpc_unavailable",
        })
        .returning();
      await seedSettlement(`0x${"a8".repeat(32)}`, "1000", new Date(attemptedAt.getTime() + 60_000));
      assert.equal((await recoverLateSettlements()).recovered, 1);
      const row = await purchaseRow(seeded.id);
      assert.equal(row.settlementVerified, null);
      assert.equal(row.settlementVerifyReason, null);
    });

    await t.test("対象外の status（決済を確定済み・否定済み・署名していない行）は一致しても触らない", async () => {
      await reset();
      const ids: Record<string, string> = {};
      for (const status of ["settle_claim_refuted", "request_error", "budget_denied", "in_flight", "price_mismatch"]) {
        ids[status] = await seedUnsettledPurchase(await seedEndpoint(), status);
      }
      await seedSettlement(`0x${"93".repeat(32)}`, "1000", new Date(attemptedAt.getTime() + 60_000));

      assert.equal((await recoverLateSettlements()).recovered, 0);
      for (const [status, id] of Object.entries(ids)) {
        const row = await purchaseRow(id);
        assert.equal(row.status, status);
        assert.equal(row.txHash, null);
      }
    });
  });
}
