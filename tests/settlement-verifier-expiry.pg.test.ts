// ============================================================
// 照合ジョブ — 売り手が名指した tx の期限（2026-09-29 敵対的監査 5 周目・台帳のコード）。
//
// tx_not_found は「まだ見えていない」として status を倒さずに毎日読み直していたので、売り手が名指した tx がチェーンに
// 無いまま照合待ちが続いた（api.wines.bet: 2026-09-12 から 17 日）。受領証の tx がハッシュの形ですらない行
// （ccs-seller の "first-can"）は照合器の対象ですらなかった。
//
// 守ること:
//  1. 購入から SELLER_NAMED_TX_NOT_FOUND_AFTER_DAYS 日たっても tx_not_found の行は settle_claim_refuted・
//     settlement_verified=false・理由は "seller_named_tx_not_found: …checked through <日付>…"。訂正ログに 1 行（同じ文）。
//     Registry へは書かない（チェーンで否定を読んだのではない）。
//  2. 期限前の tx_not_found は従来どおり status を倒さない（理由だけ）。
//  3. settle_claimed_unverifiable（tx がハッシュの形でない）は期限の後に同じ語で確定。チェーンは読まない。期限前は触らない。
//  4. 遅延回収で vet402 が貼った tx は期限でも refuted にしない（取り消しの経路）。
//  5. 売り手が success:false のまま名指した tx は申告どおりの失敗へ戻す（declineSellerNamedTx の経路）。
//  6. readEndpointsWithUndeliveredL1（sitemap の除外）は isDelivered と同じ: settled かつ 2xx 以外の行を 1 つでも持つ出品。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/settlement-verifier-expiry.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("settlement verifier expiry (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const PAY_TO = "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";
  const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
  const CHAIN = "eip155:8453";
  const DAY = 86_400_000;

  test("売り手の名指した tx: 期限の後は seller-named tx not found として確定・期限前は触らない", async () => {
    const { runSettlementVerification } = await import("@/lib/observatory/settlement-verifier");
    const { SELLER_NAMED_TX_NOT_FOUND, SELLER_NAMED_TX_NOT_FOUND_AFTER_DAYS } = await import("@/lib/sellers/fix-modes");
    const { readEndpointsWithUndeliveredL1 } = await import("@/lib/sellers/reader");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, observed_purchases, settlements, correction_log`);

    const old = new Date(Date.now() - (SELLER_NAMED_TX_NOT_FOUND_AFTER_DAYS + 10) * DAY);
    const fresh = new Date(Date.now() - 2 * DAY);
    const seedEndpoint = async () => {
      const id = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id,
        resourceKey: `seller.example/api/${id}`,
        resourceUrl: `https://seller.example/api/${id}`,
        method: "GET",
        payTo: PAY_TO,
        network: CHAIN,
        status: "active",
        lastSeenAt: new Date(),
      });
      return id;
    };
    let n = 0;
    const seed = async (over: { status: string; txHash: string; attemptedAt: Date; rawResponseMeta?: unknown; httpStatusPaid?: number | null }) => {
      n++;
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
          txHash: over.txHash,
          authNonce: `0x${n.toString(16).padStart(2, "0").repeat(32)}`,
          httpStatusPaid: over.httpStatusPaid === undefined ? 200 : over.httpStatusPaid,
          payloadNonEmpty: true,
          l2Schema: "no_declaration",
          attemptedAt: over.attemptedAt,
          rawResponseMeta: over.rawResponseMeta ?? { phase: "paid" },
        })
        .returning();
      return row;
    };
    const tx = (c: string) => `0x${c.repeat(64)}`;
    const oldClaim = await seed({ status: "settle_claimed", txHash: tx("1"), attemptedAt: old });
    const freshClaim = await seed({ status: "settle_claimed", txHash: tx("2"), attemptedAt: fresh });
    const oldMalformed = await seed({ status: "settle_claimed_unverifiable", txHash: "first-can", attemptedAt: old });
    const freshMalformed = await seed({ status: "settle_claimed_unverifiable", txHash: "second-can", attemptedAt: fresh });
    const lateLinked = await seed({
      status: "settle_claimed",
      txHash: tx("3"),
      attemptedAt: old,
      rawResponseMeta: { phase: "paid", lateSettlement: { priorStatus: "settle_failed", txHash: tx("3") } },
    });
    const promoted = await seed({
      status: "settle_claimed",
      txHash: tx("4"),
      attemptedAt: old,
      rawResponseMeta: { phase: "paid", namedTxPromotion: { priorStatus: "delivered_no_receipt" } },
    });
    const delivered = await seed({ status: "settled", txHash: tx("5"), attemptedAt: fresh });
    await db.update(schema.x402L1Purchases).set({ settlementVerified: true }).where(eq(schema.x402L1Purchases.id, delivered.id));

    const readCalls: string[] = [];
    const l1Calls: unknown[] = [];
    const origError = console.error;
    console.error = () => {};
    let summary;
    try {
      summary = await runSettlementVerification({
        deps: {
          verify: async (input) => {
            readCalls.push(input.txHash);
            return { ok: false, reason: "tx_not_found" };
          },
          registryHooks: { l1: async (i) => void l1Calls.push(i), l2: async () => {} },
        },
      });
    } finally {
      console.error = origError;
    }
    const rowOf = async (id: string) => (await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, id)))[0];
    const corrections = async (id: string) => {
      const raw = await db.execute(sql`SELECT before, after FROM correction_log WHERE subject_id = ${id}`);
      return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { before: Record<string, unknown>; after: Record<string, unknown> }[];
    };

    // 1
    const a = await rowOf(oldClaim.id);
    assert.equal(a.status, "settle_claim_refuted");
    assert.equal(a.settlementVerified, false);
    assert.ok(a.settlementVerifiedAt);
    assert.match(a.settlementVerifyReason ?? "", new RegExp(`^${SELLER_NAMED_TX_NOT_FOUND}: transaction ${tx("1")} not found on ${CHAIN}, checked through \\d{4}-\\d{2}-\\d{2} \\(purchase \\d{4}-\\d{2}-\\d{2}, ${SELLER_NAMED_TX_NOT_FOUND_AFTER_DAYS}-day limit\\)$`));
    const ca = await corrections(oldClaim.id);
    assert.equal(ca.length, 1);
    assert.equal(ca[0].before.status, "settle_claimed");
    assert.equal(ca[0].after.status, "settle_claim_refuted");
    assert.equal(ca[0].after.reason, SELLER_NAMED_TX_NOT_FOUND);
    assert.match(String(ca[0].after.note), /was not found on-chain within \d+ days of the purchase/);
    assert.equal(l1Calls.length, 0, "Registry へは書かない");
    // 2
    const b = await rowOf(freshClaim.id);
    assert.equal(b.status, "settle_claimed");
    assert.equal(b.settlementVerified, null);
    assert.equal(b.settlementVerifyReason, "tx_not_found");
    assert.equal((await corrections(freshClaim.id)).length, 0);
    // 3
    const c = await rowOf(oldMalformed.id);
    assert.equal(c.status, "settle_claim_refuted");
    assert.match(c.settlementVerifyReason ?? "", /^seller_named_tx_not_found: the receipt's transaction id "first-can" is not a transaction hash, checked through /);
    assert.equal((await corrections(oldMalformed.id)).length, 1);
    assert.ok(!readCalls.includes("first-can"), "ハッシュの形でない tx はチェーンに読みに行かない");
    const d = await rowOf(freshMalformed.id);
    assert.equal(d.status, "settle_claimed_unverifiable", "期限前は触らない");
    assert.equal(d.settlementVerified, null);
    // 4
    const e = await rowOf(lateLinked.id);
    assert.equal(e.status, "settle_failed", "遅延回収の tx は取り消し（売り手の申告の否定にしない）");
    assert.equal(e.settlementVerified, null);
    // 5
    const f = await rowOf(promoted.id);
    assert.equal(f.status, "delivered_no_receipt", "success:false の申告は申告どおりの失敗へ");
    assert.match(f.settlementVerifyReason ?? "", /^seller_declared_unsettled: tx_not_found/);
    assert.equal(summary.sellerNamedTxExpired, 2);
    assert.equal(summary.refuted, 0);
    assert.equal(summary.rowErrors, 0);

    // 2 回目: 確定した行はもう拾わない（settlement_verified が NULL でない）。
    const again = await runSettlementVerification({
      deps: { verify: async () => ({ ok: false, reason: "tx_not_found" }), registryHooks: { l1: async () => {}, l2: async () => {} } },
    });
    assert.equal(again.sellerNamedTxExpired, 0);
    assert.equal((await corrections(oldClaim.id)).length, 1);

    // 6
    const undelivered = await readEndpointsWithUndeliveredL1(db);
    assert.ok(!undelivered.has(delivered.endpointId), "settled かつ 2xx だけの出品は外さない");
    for (const r of [oldClaim, freshClaim, oldMalformed, freshMalformed, lateLinked, promoted]) assert.ok(undelivered.has(r.endpointId));
    const nullHttp = await seed({ status: "settled", txHash: tx("6"), attemptedAt: fresh, httpStatusPaid: null });
    assert.ok((await readEndpointsWithUndeliveredL1(db)).has(nullHttp.endpointId), "HTTP が NULL の settled は届いていない側");
  });
}
