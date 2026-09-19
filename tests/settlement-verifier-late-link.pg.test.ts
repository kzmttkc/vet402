// ============================================================
// 照合ジョブ — 遅延回収（recover-late）で vet402 が結び付けた tx が nonce の束縛で落ちたとき（2026-09-19 レビュー C1）。
//
// `settle_claim_refuted` は「売り手が主張した tx に、期待した決済が無かった」という売り手についての所見で、
// Registry の L1 fail にもなる。遅延回収の tx は売り手が名指したものではない——払い元・宛先・額・窓が合う tx を
// vet402 が索引から推定で貼ったもの。その推定が外れた（nonce_not_used: その tx は別の購入の決済だった）責任を
// 売り手に付けない。
//
// 守ること:
//  1. raw_response_meta.lateSettlement を持つ行が nonce_not_used で落ちたら refuted にしない。status と tx_hash を
//     回収前（lateSettlement.priorStatus / replacedTxHash）へ戻し、settlement_verified / reason は NULL、
//     hooks.l1 は呼ばない、correction_log に取り消しを 1 行残す。
//  2. 取り消した tx は lateSettlement.rejectedTxHashes に残り、recover-late が同じ tx をまた拾わない。
//  3. priorStatus を持たない旧い行（2026-09-19 より前の回収は settle_failed だけが対象）は settle_failed へ戻す。
//  4. 回帰: 売り手が自分で名指した tx の nonce 不一致は今までどおり refuted で、hooks.l1 が settled=false で呼ばれる。
//  5. late-link の行でも、nonce が合えば従来どおり settled。
//  6. nonce 以外の確定的な否定（amount_mismatch・no_matching_transfer・tx_reverted）でも取り消す（2 巡目レビュー 1）。
//     late-link 行は「売り手が指した tx」ではないので、refuted の公開定義が成り立たない。ただし索引と照合器は
//     同じ 4 条件（chain・payer・payee・額）を見ているので、これは計器の故障か reorg でしか起きない——鳴らす。
//  7. 戻し先の tx_hash が別の行に取られていたら NULL で戻す（2 巡目レビュー 2）。部分一意 index
//     （network, lower(tx_hash)）に当たって throw すると、バッチ全体が止まる。
//  8. 1 行の失敗はバッチを止めない（summary.rowErrors に出る）。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/settlement-verifier-late-link.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("settlement verifier late link (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const PAY_TO = "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";
  const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
  const CHAIN = "eip155:8453";

  test("late-link の nonce 不一致は売り手の refuted にしない", async (t) => {
    const { runSettlementVerification } = await import("@/lib/observatory/settlement-verifier");
    const { recoverLateSettlements } = await import("@/lib/settlements/recover-late");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;

    const attemptedAt = new Date("2026-09-18T10:00:00Z");
    const reset = () => db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, observed_purchases, settlements, correction_log`);

    const seedEndpoint = async () => {
      const id = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id,
        resourceKey: `GET https://seller.example/api/${id}`,
        resourceUrl: `https://seller.example/api/${id}`,
        method: "GET",
        payTo: PAY_TO,
        network: CHAIN,
        status: "active",
        lastSeenAt: new Date(),
      });
      return id;
    };
    const seedPurchase = async (over: { status: string; txHash?: string | null; rawResponseMeta?: unknown }) => {
      const [row] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId: await seedEndpoint(),
          status: over.status,
          network: CHAIN,
          payTo: PAY_TO,
          payer: PAYER,
          amountUnits: "1000",
          spentUnits: "1000",
          txHash: over.txHash ?? null,
          authNonce: `0x${"7f".repeat(32)}`,
          httpStatusPaid: 200,
          payloadNonEmpty: true,
          l2Schema: "no_declaration",
          attemptedAt,
          rawResponseMeta: over.rawResponseMeta ?? { phase: "paid" },
        })
        .returning();
      return row.id;
    };
    const seedSettlement = async (txHash: string) => {
      await db.insert(schema.settlements).values({
        chain: CHAIN,
        txHash,
        purchaseId: `${CHAIN}:${txHash}`,
        asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        amount: "1000",
        payer: PAYER,
        payee: PAY_TO,
        blockTime: new Date(attemptedAt.getTime() + 90_000),
        source: "chain_index",
        attribution: "confirmed",
      });
    };
    const rowOf = async (id: string) => (await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, id)))[0];
    const correctionsOf = async (id: string) => {
      const raw = await db.execute(sql`SELECT before, after, reason FROM correction_log WHERE subject_id = ${id} ORDER BY created_at ASC, id ASC`);
      return ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { before: Record<string, unknown>; after: Record<string, unknown>; reason: string }[]);
    };
    /** 照合を 1 回走らせる。verify は常に同じ結果、hook は呼ばれた引数と server ログを記録する。 */
    type RefuteReason = Extract<import("@/lib/observatory/settlement-verify").SettlementVerifyResult, { ok: false }>["reason"];
    const verifyOnce = async (result: { ok: false; reason: RefuteReason } | { ok: true }) => {
      const l1Calls: { settled: boolean; txHash: string | null }[] = [];
      const logged: string[] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
      let summary;
      try {
        summary = await runSettlementVerification({
          deps: {
            verify: async () => (result.ok ? { ok: true, blockTimestamp: null, confirmations: 99n, blockNumber: 1n } : { ok: false, reason: result.reason, detail: "detail from the verifier" }),
            registryHooks: {
              l1: async (input) => {
                l1Calls.push({ settled: input.settled, txHash: input.txHash ?? null });
              },
              l2: async () => {},
            },
          },
        });
      } finally {
        console.error = origError;
      }
      return { summary, l1Calls, logged };
    };

    for (const c of [
      { prior: "settle_failed", priorTx: null },
      { prior: "delivered_no_receipt", priorTx: null },
      { prior: "settle_claimed_unverifiable", priorTx: "not-a-transaction-id" },
    ]) {
      await t.test(`${c.prior} から回収した行の nonce 不一致: refuted にせず回収前へ戻し、同じ tx を二度拾わない`, async () => {
        await reset();
        const id = await seedPurchase({ status: c.prior, txHash: c.priorTx });
        const tx = `0x${"d1".repeat(32)}`;
        await seedSettlement(tx);
        assert.deepEqual((await recoverLateSettlements()).links, [{ purchaseId: id, txHash: tx }]);
        assert.equal((await rowOf(id)).status, "settle_claimed");

        const { summary, l1Calls } = await verifyOnce({ ok: false, reason: "nonce_not_used" });
        assert.equal(summary.scanned, 1);
        assert.equal(summary.refuted, 0, "vet402 の推定が外れただけ。売り手の所見ではない");
        assert.equal(summary.lateLinksWithdrawn, 1);
        assert.deepEqual(l1Calls, [], "Registry へ fail を書かない");

        const row = await rowOf(id);
        assert.equal(row.status, c.prior);
        assert.equal(row.txHash, c.priorTx);
        assert.equal(row.settlementVerified, null);
        assert.equal(row.settlementVerifiedAt, null);
        assert.equal(row.settlementVerifyReason, null);
        const late = (row.rawResponseMeta as { phase?: string; lateSettlement: Record<string, unknown> });
        assert.equal(late.phase, "paid", "元の raw_response_meta を壊さない");
        assert.deepEqual(late.lateSettlement.rejectedTxHashes, [tx]);

        const log = await correctionsOf(id);
        assert.equal(log.length, 2, "回収と取り消しの 2 行");
        assert.deepEqual(log[1].before, { status: "settle_claimed", txHash: tx });
        assert.deepEqual(log[1].after, { status: c.prior, txHash: c.priorTx, lateLinkWithdrawn: "nonce_not_used" });

        assert.equal((await recoverLateSettlements()).recovered, 0, "取り消した tx をまた拾っている（往復する）");
        assert.equal((await rowOf(id)).status, c.prior);
      });
    }

    await t.test("priorStatus の無い旧い late-link 行は settle_failed へ戻す", async () => {
      await reset();
      const tx = `0x${"d2".repeat(32)}`;
      const id = await seedPurchase({
        status: "settle_claimed",
        txHash: tx,
        rawResponseMeta: { phase: "paid", lateSettlement: { source: "settlements_index", note: "the seller settled after we recorded settle_failed; the verifier decides whether it is ours", linkedAt: "2026-09-12T00:00:00Z" } },
      });
      const { summary, l1Calls } = await verifyOnce({ ok: false, reason: "nonce_not_used" });
      assert.equal(summary.refuted, 0);
      assert.equal(summary.lateLinksWithdrawn, 1);
      assert.deepEqual(l1Calls, []);
      const row = await rowOf(id);
      assert.equal(row.status, "settle_failed");
      assert.equal(row.txHash, null);
    });

    await t.test("回帰: 売り手が自分で名指した tx の nonce 不一致は今までどおり refuted で、hooks.l1 が呼ばれる", async () => {
      await reset();
      const tx = `0x${"d3".repeat(32)}`;
      const id = await seedPurchase({ status: "settle_claimed", txHash: tx });
      const { summary, l1Calls } = await verifyOnce({ ok: false, reason: "nonce_not_used" });
      assert.equal(summary.refuted, 1);
      assert.equal(summary.lateLinksWithdrawn, 0);
      assert.deepEqual(l1Calls, [{ settled: false, txHash: tx }]);
      const row = await rowOf(id);
      assert.equal(row.status, "settle_claim_refuted");
      assert.equal(row.settlementVerified, false);
      assert.equal(row.txHash, tx);
    });

    // 2 巡目レビュー 1: refuted の公開定義は「売り手が指した tx を再読したら転送が無かった」。late-link 行は
    // 前提が偽なので、理由を問わず取り消す。ただし nonce 以外は計器の故障か reorg でしか起きないので鳴らす。
    for (const reason of ["no_matching_transfer", "amount_mismatch", "tx_reverted", "payee_mismatch"] as const) {
      await t.test(`late-link 行の ${reason} も refuted にせず取り消し、計器の故障として鳴らす`, async () => {
        await reset();
        const id = await seedPurchase({ status: "delivered_no_receipt" });
        const tx = `0x${"e1".repeat(32)}`;
        await seedSettlement(tx);
        assert.deepEqual((await recoverLateSettlements()).links, [{ purchaseId: id, txHash: tx }]);

        const { summary, l1Calls, logged } = await verifyOnce({ ok: false, reason });
        assert.equal(summary.refuted, 0, "vet402 が貼った tx を売り手の所見にしている");
        assert.equal(summary.lateLinksWithdrawn, 1);
        assert.deepEqual(l1Calls, [], "Registry へ fail を書かない");
        const row = await rowOf(id);
        assert.equal(row.status, "delivered_no_receipt");
        assert.equal(row.txHash, null);
        assert.deepEqual((row.rawResponseMeta as { lateSettlement: Record<string, unknown> }).lateSettlement.rejectedTxHashes, [tx]);
        assert.ok(
          logged.some((l) => l.includes("late_link_unexpected_refutation") && l.includes(reason)),
          `計器の故障として鳴っていない: ${logged.join(" | ")}`,
        );
      });
    }

    await t.test("nonce_not_used の取り消しは鳴らさない（索引の一致だけでは決まらない正常な結果）", async () => {
      await reset();
      const id = await seedPurchase({ status: "settle_failed" });
      const tx = `0x${"e2".repeat(32)}`;
      await seedSettlement(tx);
      await recoverLateSettlements();
      const { summary, logged } = await verifyOnce({ ok: false, reason: "nonce_not_used" });
      assert.equal(summary.lateLinksWithdrawn, 1);
      assert.equal((await rowOf(id)).status, "settle_failed");
      assert.ok(!logged.some((l) => l.includes("late_link_unexpected_refutation")), `鳴らすべきでない: ${logged.join(" | ")}`);
    });

    // 2 巡目レビュー 2: 戻し先の tx_hash が別の行に取られていると、部分一意 index
    // （x402_l1_purchases_tx_unique）で throw してバッチ全体が止まる。
    await t.test("戻し先の tx_hash を別の行が持っていたら NULL で戻し、バッチは止まらない", async () => {
      await reset();
      const MALFORMED = "not-a-transaction-id";
      const late = await seedPurchase({ status: "settle_claimed_unverifiable", txHash: MALFORMED });
      const tx = `0x${"e3".repeat(32)}`;
      await seedSettlement(tx);
      assert.deepEqual((await recoverLateSettlements()).links, [{ purchaseId: late, txHash: tx }]);
      // 回収で tx_hash が空いた隙に、別の購入が同じ原文を主張した（売り手が同じ文字列を返す壁）。
      const squatter = await seedPurchase({ status: "settle_claimed", txHash: MALFORMED });

      const { summary, l1Calls } = await verifyOnce({ ok: false, reason: "nonce_not_used" });
      assert.equal(summary.scanned, 2, "バッチが途中で落ちている");
      assert.equal(summary.lateLinksWithdrawn, 1);
      assert.equal(summary.rowErrors, 0, "一意制約で throw している");
      const row = await rowOf(late);
      assert.equal(row.status, "settle_claimed_unverifiable");
      assert.equal(row.txHash, null, "衝突する原文を書き戻している");
      assert.equal((await rowOf(squatter)).status, "settle_claim_refuted", "売り手が名指した行は従来どおり");
      assert.deepEqual(l1Calls, [{ settled: false, txHash: MALFORMED }]);
    });

    await t.test("1 行の失敗はバッチを止めず、summary.rowErrors に出る", async () => {
      await reset();
      const first = await seedPurchase({ status: "settle_claimed", txHash: `0x${"e4".repeat(32)}` });
      const second = await seedPurchase({ status: "settle_claimed", txHash: `0x${"e5".repeat(32)}` });
      const logged: string[] = [];
      const origError = console.error;
      console.error = (...args: unknown[]) => logged.push(args.map(String).join(" "));
      let summary;
      try {
        summary = await runSettlementVerification({
          deps: {
            verify: async (input) => {
              if (input.txHash === `0x${"e4".repeat(32)}`) throw new Error("rpc client blew up");
              return { ok: true, blockTimestamp: null, confirmations: 99n, blockNumber: 1n };
            },
            registryHooks: { l1: async () => {}, l2: async () => {} },
          },
        });
      } finally {
        console.error = origError;
      }
      assert.equal(summary.rowErrors, 1);
      assert.equal(summary.verified, 1, "2 行目が処理されていない");
      assert.equal((await rowOf(first)).status, "settle_claimed", "落ちた行は触らない");
      assert.equal((await rowOf(second)).status, "settled");
      assert.ok(logged.some((l) => l.includes("rpc client blew up")), `黙って飲み込んでいる: ${logged.join(" | ")}`);
    });

    await t.test("late-link の行でも nonce が合えば従来どおり settled", async () => {
      await reset();
      const id = await seedPurchase({ status: "settle_failed" });
      const tx = `0x${"d4".repeat(32)}`;
      await seedSettlement(tx);
      await recoverLateSettlements();
      const { summary, l1Calls } = await verifyOnce({ ok: true });
      assert.equal(summary.verified, 1);
      assert.equal(summary.lateLinksWithdrawn, 0);
      assert.deepEqual(l1Calls, [{ settled: true, txHash: tx }]);
      assert.equal((await rowOf(id)).status, "settled");
    });
  });
}
