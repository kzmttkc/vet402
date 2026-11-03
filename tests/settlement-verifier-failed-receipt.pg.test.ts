// ============================================================
// 照合器 — settle_failed のまま受領証の tx を持つ行（2026-11-03・数字の監査 結論 #1 型 (b)）。
//
// 本番: api.getretold.com …/invoke（Base・10-24 12:01:52Z・http 402・10,000）は settle_failed・tx 0x1b84c1bd… で、チェーンでは
// USDC が購入元 → 受取先へ 10,000 動いていた。svm402.com/holdcheck（Solana・405）も同じ。3 行とも settlement_verified IS NULL で、
// 照合器（settle_claimed と settled だけ）に一度も掛からなかった。
//
// 守ること:
//  1. 受領証の tx を行の期待値（払い元・宛先・額・nonce）で読み、一致したら settled。訂正ログは settlement_backfill
//     （before: settle_failed + tx、after: settled + tx + failedReceiptVerified）。raw_response_meta.failedReceiptVerified が付く。
//  2. 一致しなければ status・tx・settlement_verified は変えない。refute しない（売り手は失敗と答えていて決済を主張していない）。
//     訂正ログも書かない。印（failedReceiptCheck.mismatches）だけ増え、FAILED_RECEIPT_MAX_CHECKS 回で読むのをやめる。
//  3. 一時的な理由（rpc_unavailable …）は mismatches に数えない。読んだ回数（checks）は理由を問わず数え、FAILED_RECEIPT_MAX_READS で
//     読むのをやめる（毎日選ばれて古い順の枠を取り続けない）。settle_failed の行は別の小さな枠（FAILED_RECEIPT_ROWS_PER_RUN）で
//     settle_claimed / settled の後ろ。
//  4. 同じ tx を別の行が主張していれば読まない。
//  5. 従来の settle_claimed の行の経路は変わらない。
//  6. auth_nonce の無い行と Stellar（額・宛先だけで照合する）の行は読まない——tx が実在してもこの購入のものと言えない。
// Run: TEST_DATABASE_URL=postgres://localhost/<自分用のテスト DB> \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/settlement-verifier-failed-receipt.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("settlement verifier failed receipt (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
  const PAY_TO = "0xb2be1a7c4d9e6f3a8c5b2d7e9f1a3c5b7d9e1f3a";
  const BASE = "eip155:8453";
  const AMOUNT = "10000";
  const TX = "0x1b84c1bdc4d2e4a6d847edfef50fd554f74b6de9d4e97108eeb37bf4c910c985";
  const NONCE = `0x${"7c".repeat(32)}`;
  const AT = new Date("2026-10-24T12:01:52Z");
  const BLOCK_TIME = new Date("2026-10-24T12:01:55Z");

  test("settle_failed + 受領証の tx は、一致したときだけ settled", async (t) => {
    const { runSettlementVerification, FAILED_RECEIPT_MAX_CHECKS, FAILED_RECEIPT_MAX_READS, FAILED_RECEIPT_ROWS_PER_RUN } = await import("@/lib/observatory/settlement-verifier");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;

    const reset = () => db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, observed_purchases, settlements, correction_log`);
    const seedRow = async (over: { status?: string; tx?: string | null; http?: number; meta?: unknown; verified?: boolean; network?: string; nonce?: string | null; attemptedAt?: Date } = {}) => {
      const endpointId = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id: endpointId,
        resourceKey: `api.getretold.example/${endpointId}`,
        resourceUrl: `https://api.getretold.example/${endpointId}`,
        method: "POST",
        payTo: PAY_TO,
        network: over.network ?? BASE,
        status: "active",
        lastSeenAt: new Date(),
      });
      const id = randomUUID();
      await db.insert(schema.x402L1Purchases).values({
        id,
        endpointId,
        resourceKey: `api.getretold.example/${endpointId}`,
        network: over.network ?? BASE,
        status: over.status ?? "settle_failed",
        attemptedAt: over.attemptedAt ?? AT,
        payer: PAYER,
        payTo: PAY_TO,
        amountUnits: AMOUNT,
        spentUnits: AMOUNT,
        authNonce: over.nonce === undefined ? NONCE : over.nonce,
        txHash: over.tx === undefined ? TX : over.tx,
        httpStatusPaid: over.http ?? 402,
        payloadNonEmpty: false,
        l2Schema: "not_checked",
        rawResponseMeta: over.meta === undefined ? { phase: "paid", status: 402 } : over.meta,
        ...(over.verified ? { settlementVerified: true, settlementVerifiedAt: new Date() } : {}),
      } as never);
      return id;
    };
    const read = async (id: string) => (await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, id)))[0];
    const corrections = async (id: string) => {
      const raw = await db.execute(sql`SELECT before, after, reason FROM correction_log WHERE subject_type = 'purchase' AND subject_id = ${id} ORDER BY created_at, id`);
      return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { before: unknown; after: unknown; reason: string }[];
    };
    type Verify = NonNullable<NonNullable<Parameters<typeof runSettlementVerification>[0]>["deps"]>["verify"];
    const ok: Verify = async () => ({ ok: true, blockNumber: 37_000_000n, blockTimestamp: BLOCK_TIME, confirmations: 5_000n });
    const runWith = (verify: Verify) => {
      const l1: { settled: boolean; txHash: string | null }[] = [];
      const inputs: unknown[] = [];
      const summary = runSettlementVerification({
        deps: {
          verify: async (input) => (inputs.push(input), verify!(input)),
          registryHooks: { l1: async (x) => void l1.push({ settled: x.settled, txHash: x.txHash ?? null }), l2: async () => {} },
        },
      });
      return { summary, l1, inputs };
    };

    await t.test("1: 一致 → settled・訂正ログ 1 行（settlement_backfill）・hook と証拠", async () => {
      await reset();
      const id = await seedRow();
      const { summary, l1, inputs } = runWith(ok);
      const s = await summary;
      assert.equal(s.scanned, 1);
      assert.equal(s.verified, 1);
      assert.equal(s.failedReceiptSettled, 1);
      assert.equal(s.refuted, 0);
      assert.deepEqual(inputs, [{ txHash: TX, network: BASE, expectedPayTo: PAY_TO, expectedPayer: PAYER, expectedAmountUnits: AMOUNT, expectedAuthNonce: NONCE }], "期待値は行のもの（署名した値）");
      const row = await read(id);
      assert.equal(row.status, "settled");
      assert.equal(row.settlementVerified, true);
      assert.equal(row.txHash, TX);
      assert.equal(row.httpStatusPaid, 402, "応答の記録は変えない（402 のまま・届いたとは言わない）");
      const meta = row.rawResponseMeta as { phase?: string; failedReceiptVerified?: { priorStatus?: string }; settlementBlockTime?: string };
      assert.equal(meta.phase, "paid");
      assert.equal(meta.failedReceiptVerified?.priorStatus, "settle_failed");
      assert.equal(meta.settlementBlockTime, BLOCK_TIME.toISOString());
      const log = await corrections(id);
      assert.equal(log.length, 1);
      assert.equal(log[0].reason, "settlement_backfill");
      assert.deepEqual(log[0].before, { status: "settle_failed", txHash: TX });
      assert.deepEqual(log[0].after, { status: "settled", blockNumber: "37000000", txHash: TX, failedReceiptVerified: true });
      const { settlementPathOf } = await import("@/lib/observatory/corrections");
      assert.equal(settlementPathOf(log[0]), "verified_settled", "公開の /corrections では verified_settled の経路");
      assert.deepEqual(l1, [{ settled: true, txHash: TX }]);
      const evidence = await db.select().from(schema.observedPurchases);
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].deliveryVerified, false);
      // 二度目は選ばれない（settlement_verified が付いた）。
      const again = await runWith(ok).summary;
      assert.equal(again.scanned, 0);
    });

    await t.test("2: 不一致 → 変えない・refute しない・訂正ログ無し。上限の回数で読むのをやめる", async () => {
      await reset();
      const id = await seedRow();
      const before = await read(id);
      const mismatch: Verify = async () => ({ ok: false, reason: "nonce_not_used" });
      for (let i = 1; i <= FAILED_RECEIPT_MAX_CHECKS; i++) {
        const { summary, l1 } = runWith(mismatch);
        const s = await summary;
        assert.equal(s.scanned, 1, `read ${i}`);
        assert.equal(s.refuted, 0);
        assert.equal(s.verified, 0);
        assert.equal(s.failedReceiptLeft, 1);
        assert.deepEqual(l1, []);
        const row = await read(id);
        assert.equal(row.status, "settle_failed");
        assert.equal(row.txHash, TX);
        assert.equal(row.settlementVerified, null);
        assert.equal(row.settlementVerifyReason, before.settlementVerifyReason);
        const meta = row.rawResponseMeta as { failedReceiptCheck?: { mismatches?: number; checks?: number; lastReason?: string } };
        assert.equal(meta.failedReceiptCheck?.mismatches, i);
        assert.equal(meta.failedReceiptCheck?.checks, i);
        assert.equal(meta.failedReceiptCheck?.lastReason, "nonce_not_used");
        assert.equal((await corrections(id)).length, 0);
      }
      const over = await runWith(mismatch).summary;
      assert.equal(over.scanned, 0, "上限に達した行は選ばない");
      // ハッシュの形でない受領証の tx も確定的な不一致として数える（鳴らさない）。
      await reset();
      const odd = await seedRow({ tx: "first-can" });
      const malformed: Verify = async () => ({ ok: false, reason: "malformed_tx" });
      const s = await runWith(malformed).summary;
      assert.equal(s.instrumentFailure, null);
      assert.equal((await read(odd)).status, "settle_failed");
      assert.equal(((await read(odd)).rawResponseMeta as { failedReceiptCheck?: { mismatches?: number } }).failedReceiptCheck?.mismatches, 1);
    });

    await t.test("3: 一時的な理由は mismatches に数えない。読んだ回数は数え、上限で読むのをやめる", async () => {
      await reset();
      const id = await seedRow();
      const before = await read(id);
      let reads = 0;
      for (const reason of ["rpc_unavailable", "insufficient_confirmations", "chain_not_yet_verifiable", "tx_not_found"] as const) {
        const s = await runWith(async () => ({ ok: false, reason })).summary;
        reads++;
        assert.equal(s.scanned, 1, reason);
        assert.equal(s.failedReceiptLeft, 1, reason);
        const row = await read(id);
        assert.equal(row.status, "settle_failed", reason);
        assert.equal(row.txHash, TX, reason);
        assert.equal(row.settlementVerified, null, reason);
        assert.equal(row.settlementVerifyReason, before.settlementVerifyReason, reason);
        const meta = row.rawResponseMeta as { failedReceiptCheck?: { mismatches?: number; checks?: number; lastReason?: string } };
        assert.deepEqual({ checks: meta.failedReceiptCheck?.checks, mismatches: meta.failedReceiptCheck?.mismatches, lastReason: meta.failedReceiptCheck?.lastReason }, { checks: reads, mismatches: 0, lastReason: reason });
        assert.equal((await corrections(id)).length, 0, reason);
      }
      while (reads < FAILED_RECEIPT_MAX_READS) {
        await runWith(async () => ({ ok: false, reason: "rpc_unavailable" })).summary;
        reads++;
      }
      const over = await runWith(ok).summary;
      assert.equal(over.scanned, 0, "読んだ回数が上限に達した行は選ばない");
      assert.equal((await read(id)).status, "settle_failed");
    });

    await t.test("4: 同じ tx を別の行が主張していれば読まない（読んだ回数は数える）", async () => {
      await reset();
      // 一意 index（2026-09-04 以降）はこの形を作らせない。それ以前の行を再現するため index を外して入れ、終わったら必ず戻す。
      await db.execute(sql`DROP INDEX IF EXISTS x402_l1_purchases_tx_unique`);
      try {
        const id = await seedRow();
        await seedRow({ status: "settled", verified: true, meta: { phase: "paid", status: 200 } });
        const { summary, inputs } = runWith(ok);
        await summary;
        assert.equal(inputs.filter((i) => (i as { txHash: string }).txHash === TX).length, 0);
        const row = await read(id);
        assert.equal(row.status, "settle_failed");
        const meta = row.rawResponseMeta as { failedReceiptCheck?: { mismatches?: number; checks?: number } };
        assert.deepEqual({ checks: meta.failedReceiptCheck?.checks, mismatches: meta.failedReceiptCheck?.mismatches }, { checks: 1, mismatches: 0 });
      } finally {
        await reset();
        await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS x402_l1_purchases_tx_unique ON x402_l1_purchases (network, lower(tx_hash)) WHERE tx_hash IS NOT NULL`);
      }
    });

    await t.test("6: auth_nonce の無い行と Stellar の行は読まない。settle_failed の枠は小さく、settle_claimed の後ろ", async () => {
      await reset();
      const noNonce = await seedRow({ nonce: null, tx: `0x${"11".repeat(32)}` });
      const blank = await seedRow({ nonce: "   ", tx: `0x${"12".repeat(32)}` });
      const stellar = await seedRow({ network: "stellar:pubnet", tx: "a".repeat(64) });
      const { summary, inputs } = runWith(ok);
      const s = await summary;
      assert.equal(s.scanned, 0);
      assert.deepEqual(inputs, []);
      for (const id of [noNonce, blank, stellar]) {
        const row = await read(id);
        assert.equal(row.status, "settle_failed");
        assert.equal((row.rawResponseMeta as { failedReceiptCheck?: unknown }).failedReceiptCheck, undefined, "読んだ印も付かない");
      }
      // 枠: settle_failed の行が FAILED_RECEIPT_ROWS_PER_RUN + 1 行あっても、1 回に読むのは上限まで。settle_claimed の行が先。
      await reset();
      const claimed = await seedRow({ status: "settle_claimed", http: 200, meta: { phase: "paid", status: 200 }, attemptedAt: new Date(AT.getTime() + 86_400_000) });
      for (let i = 0; i < FAILED_RECEIPT_ROWS_PER_RUN + 1; i++) await seedRow({ tx: `0x${(i + 32).toString(16).padStart(2, "0").repeat(32)}`, attemptedAt: new Date(AT.getTime() + i * 1000) });
      const second = runWith(ok);
      const s2 = await second.summary;
      assert.equal(s2.scanned, FAILED_RECEIPT_ROWS_PER_RUN + 1);
      assert.equal((second.inputs[0] as { txHash: string }).txHash, TX, "settle_claimed の行（新しくても）が先");
      assert.equal((await read(claimed)).status, "settled");
      assert.equal(s2.failedReceiptSettled, FAILED_RECEIPT_ROWS_PER_RUN);
    });

    await t.test("5: 従来の settle_claimed の行の経路は変わらない（不一致は refuted・訂正の形も従来どおり）", async () => {
      await reset();
      const claimed = await seedRow({ status: "settle_claimed", http: 200, meta: { phase: "paid", status: 200 } });
      const s = await runWith(ok).summary;
      assert.equal(s.verified, 1);
      assert.equal(s.failedReceiptSettled, 0);
      const log = await corrections(claimed);
      assert.deepEqual(log[0].before, { status: "settle_claimed" });
      assert.deepEqual(log[0].after, { status: "settled", blockNumber: "37000000" });
      await reset();
      const refutable = await seedRow({ status: "settle_claimed", http: 200, meta: { phase: "paid", status: 200 } });
      const s2 = await runWith(async () => ({ ok: false, reason: "nonce_not_used" })).summary;
      assert.equal(s2.refuted, 1);
      assert.equal((await read(refutable)).status, "settle_claim_refuted");
    });

    await reset();
  });
}
