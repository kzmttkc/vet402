// ============================================================
// 2026-09-29 第4巡の敵対的監査: 逆方向の誤り（売り手に不利）を遅延照合で塞ぐ（recover-late.ts）。
//   1. 入れ替え可能な組（agent-budget-guard / ai-agent-payment-safety-stack 型）: 同じ payer・payTo・額の購入 n 行と
//      索引の着金 n 本が全部の組で候補なら、nonce の無い行だけ時刻順に対にして貼る。
//   2. 索引に無い着金（fiatdock 型）: チェーンを直接読む（読み手は偽物）。読めた行には印を付けて二度と読まない。
//   3. 売り手が名指した tx（wazir 型）: 2xx の delivered_no_receipt を売り手の申告として settle_claimed へ。
// あわせて /sellers の 2 回確定の材料（readSellerFailureDays）と記録頁の分類（readRecordSides）を実 DB で当てる。
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test_r4b \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/late-settlement-r4.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("late settlement r4 (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const PAY_TO = "0x60c402878efcecae5733a88075328aa2320c39be";
  const PAYER = "0x6777e11fb0a7917b8110b7dab9188aa3f6d23986";
  const CHAIN = "eip155:8453";
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

  test("recover-late 第4巡", async (t) => {
    const late = await import("@/lib/settlements/recover-late");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;

    const reset = () => db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, settlements, correction_log`);
    const seedEndpoint = async (payTo = PAY_TO) => {
      const id = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id,
        resourceKey: `seller.example/api/${id}`,
        resourceUrl: `https://seller.example/api/${id}`,
        method: "GET",
        payTo,
        network: CHAIN,
        status: "active",
        lastSeenAt: new Date(),
      });
      return id;
    };
    const seedRow = async (
      endpointId: string,
      over: { status?: string; attemptedAt: Date; http?: number | null; tx?: string | null; nonce?: string | null; amount?: string; payTo?: string },
    ) => {
      const [row] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId,
          status: over.status ?? "delivered_no_receipt",
          network: CHAIN,
          asset: USDC,
          payTo: over.payTo ?? PAY_TO,
          payer: PAYER,
          amountUnits: over.amount ?? "30000",
          spentUnits: over.amount ?? "30000",
          attemptedAt: over.attemptedAt,
          txHash: over.tx ?? null,
          httpStatusPaid: over.http === undefined ? 200 : over.http,
          authNonce: over.nonce ?? null,
        })
        .returning();
      return row.id;
    };
    const seedSettlement = async (txHash: string, blockTime: Date, amount = "30000", payTo = PAY_TO) => {
      await db.insert(schema.settlements).values({
        chain: CHAIN,
        txHash,
        purchaseId: `${CHAIN}:${txHash}`,
        asset: USDC.toLowerCase(),
        amount,
        payer: PAYER,
        payee: payTo,
        blockTime,
        source: "chain_index",
        attribution: "confirmed",
      });
    };
    const get = async (id: string) => (await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, id)))[0];
    /** その購入の訂正ログ（独立レビュー BLOCK: 貼った行には必ず同じ文で訂正がある）。 */
    const corrections = async (id: string) => {
      const raw = await db.execute(sql`SELECT before, after FROM correction_log WHERE subject_type = 'purchase' AND subject_id = ${id} ORDER BY created_at`);
      return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { before: unknown; after: unknown }[];
    };
    const tx = (b: string) => `0x${b.repeat(32)}`;

    await t.test("1: 2 行・索引の着金 2 本・全部の組が候補・nonce なし → 時刻順に貼る", async () => {
      await reset();
      const a = await seedEndpoint();
      const b = await seedEndpoint();
      const guard = await seedRow(a, { attemptedAt: new Date("2026-08-31T12:09:22Z") });
      const stack = await seedRow(b, { attemptedAt: new Date("2026-08-31T12:09:25Z") });
      await seedSettlement(tx("95"), new Date("2026-08-31T12:09:25Z"));
      await seedSettlement(tx("d7"), new Date("2026-08-31T12:09:27Z"));
      const s = await late.recoverLateSettlements();
      assert.equal(s.recoveredBySet, 2);
      const g = await get(guard);
      const k = await get(stack);
      assert.equal(g.status, "settle_claimed");
      assert.equal(g.txHash, tx("95"));
      assert.equal(k.txHash, tx("d7"));
      const meta = g.rawResponseMeta as { lateSettlement?: { matchedBy?: string; priorStatus?: string } };
      assert.equal(meta.lateSettlement?.matchedBy, "interchangeable_set");
      assert.equal(meta.lateSettlement?.priorStatus, "delivered_no_receipt");
      for (const id of [guard, stack]) {
        const log = await corrections(id);
        assert.equal(log.length, 1, "貼り付けと訂正ログは同じ文");
        assert.deepEqual(log[0].before, { status: "delivered_no_receipt", txHash: null });
        assert.equal((log[0].after as { status: string }).status, "settle_claimed");
      }
    });

    await t.test("1: nonce のある組・行 2 本に着金 1 本は貼らない（推定しない）", async () => {
      await reset();
      const a = await seedEndpoint();
      const r1 = await seedRow(a, { attemptedAt: new Date("2026-09-20T00:00:00Z"), nonce: `0x${"01".repeat(32)}` });
      const r2 = await seedRow(a, { attemptedAt: new Date("2026-09-20T00:00:03Z"), nonce: `0x${"02".repeat(32)}` });
      await seedSettlement(tx("aa"), new Date("2026-09-20T00:00:04Z"));
      await seedSettlement(tx("bb"), new Date("2026-09-20T00:00:06Z"));
      await late.recoverLateSettlements();
      assert.equal((await get(r1)).txHash, null);
      assert.equal((await get(r2)).txHash, null);
      await reset();
      const c = await seedEndpoint();
      const x1 = await seedRow(c, { attemptedAt: new Date("2026-08-20T00:00:00Z") });
      const x2 = await seedRow(c, { attemptedAt: new Date("2026-08-20T00:00:03Z") });
      await seedSettlement(tx("cc"), new Date("2026-08-20T00:00:04Z"));
      const s = await late.recoverLateSettlements();
      assert.equal(s.recovered, 0);
      assert.equal((await get(x1)).txHash, null);
      assert.equal((await get(x2)).txHash, null);
    });

    await t.test("2: 索引に無い着金はチェーンを直接読んで貼る。読めた行には印、読めなければ印を付けない", async () => {
      await reset();
      const payTo = "0x313722afe5b161a850b5fc48d916cd91fb9dbb12";
      const e = await seedEndpoint(payTo);
      const at = new Date("2026-08-14T10:10:17Z");
      const fiat = await seedRow(e, { attemptedAt: at, amount: "10000", payTo });
      const calls: unknown[] = [];
      const reader: import("@/lib/settlements/recover-late").TransferReader = async (q) => {
        calls.push(q);
        return [
          { txHash: tx("4f"), from: PAYER, to: payTo, value: "10000", blockTime: "2026-08-14T10:10:19.000Z" },
          { txHash: tx("99"), from: PAYER, to: payTo, value: "20000", blockTime: "2026-08-14T10:10:21.000Z" },
        ];
      };
      const s = await late.recoverLateSettlements({ readTransfers: reader });
      assert.equal(s.recoveredFromChain, 1);
      const row = await get(fiat);
      assert.equal(row.status, "settle_claimed");
      assert.equal(row.txHash, tx("4f"), "額が違う着金は貼らない");
      assert.equal((row.rawResponseMeta as { lateSettlement?: { source?: string } }).lateSettlement?.source, "chain_read");
      assert.equal(calls.length, 1);
      assert.equal((await corrections(fiat)).length, 1, "直読みの貼り付けも訂正ログと同じ文");
      assert.equal(typeof (calls[0] as { timeoutMs?: number }).timeoutMs, "number", "残り時間を読みに渡す");

      // 着金が無い行: 印を付け、次の実行では読まない
      await reset();
      const e2 = await seedEndpoint(payTo);
      const none = await seedRow(e2, { attemptedAt: at, amount: "10000", payTo });
      let n = 0;
      const empty: import("@/lib/settlements/recover-late").TransferReader = async () => {
        n++;
        return [];
      };
      await late.recoverLateSettlements({ readTransfers: empty });
      await late.recoverLateSettlements({ readTransfers: empty });
      assert.equal(n, 1, "着金が窓に無かった行（決まった行）は二度と読まない");
      const r = await get(none);
      assert.equal(r.txHash, null);
      assert.deepEqual(Object.keys((r.rawResponseMeta as Record<string, unknown>) ?? {}), ["lateChainRead"]);
      assert.equal((r.rawResponseMeta as { lateChainRead: { decided: boolean } }).lateChainRead.decided, true);

      // 独立レビュー WARNING 2: 窓に着金はあるが、その着金を別の行が既に持っている（隣が先に貼った）行は決まっていない。
      // 読み直す（上限 CHAIN_READ_MAX_TRIES 回）。
      await reset();
      const e5 = await seedEndpoint(payTo);
      const taken = await seedRow(e5, { attemptedAt: at, amount: "10000", payTo });
      await seedRow(e5, { status: "settle_claimed", attemptedAt: new Date(at.getTime() + 1_000), amount: "10000", payTo, tx: tx("4f") });
      let k = 0;
      const same: import("@/lib/settlements/recover-late").TransferReader = async () => {
        k++;
        return [{ txHash: tx("4f"), from: PAYER, to: payTo, value: "10000", blockTime: "2026-08-14T10:10:19.000Z" }];
      };
      for (let i = 0; i < 5; i++) await late.recoverLateSettlements({ readTransfers: same });
      assert.equal(k, late.CHAIN_READ_MAX_TRIES, "決まらなかった行は上限まで読み直す");
      const tk = await get(taken);
      assert.equal(tk.txHash, null);
      assert.deepEqual(
        { decided: (tk.rawResponseMeta as { lateChainRead: { decided: boolean; tries: number } }).lateChainRead.decided, tries: (tk.rawResponseMeta as { lateChainRead: { tries: number } }).lateChainRead.tries },
        { decided: false, tries: late.CHAIN_READ_MAX_TRIES },
      );

      // 読めない（null）なら印を付けない
      await reset();
      const e3 = await seedEndpoint(payTo);
      const failed = await seedRow(e3, { attemptedAt: at, amount: "10000", payTo });
      await late.recoverLateSettlements({ readTransfers: async () => null });
      assert.equal((await get(failed)).rawResponseMeta, null);

      // 窓が閉じていない行（直近 35 分）は読まない
      await reset();
      const e4 = await seedEndpoint(payTo);
      await seedRow(e4, { attemptedAt: new Date(Date.now() - 5 * 60_000), amount: "10000", payTo });
      let m = 0;
      await late.recoverLateSettlements({ readTransfers: async () => (m++, []) });
      assert.equal(m, 0);
    });

    await t.test("3: 2xx で売り手が名指した tx は売り手の申告として照合へ（lateSettlement を付けない）。4xx は触らない", async () => {
      await reset();
      const e = await seedEndpoint();
      const wazir = await seedRow(e, { attemptedAt: new Date("2026-09-17T12:53:16Z"), tx: tx("d2"), amount: "5000" });
      const refused = await seedRow(e, { status: "settle_failed", attemptedAt: new Date("2026-09-17T12:54:00Z"), tx: tx("e3"), http: 400, amount: "5000" });
      const s = await late.recoverLateSettlements();
      assert.equal(s.promotedNamedTx, 1);
      const w = await get(wazir);
      assert.equal(w.status, "settle_claimed");
      assert.equal(w.txHash, tx("d2"));
      const meta = w.rawResponseMeta as Record<string, unknown>;
      assert.equal("lateSettlement" in meta, false, "tx を名指したのは売り手（tx from our index と書かせない）");
      assert.equal((meta.namedTxPromotion as { priorStatus?: string }).priorStatus, "delivered_no_receipt");
      assert.equal((await corrections(wazir)).length, 1, "照合へ回したことも訂正ログと同じ文");
      assert.equal((await get(refused)).status, "settle_failed");
      const again = await late.recoverLateSettlements();
      assert.equal(again.promotedNamedTx, 0);

      // 独立レビュー WARNING 3: 照合で合わなければ、売り手の申告（success:false）どおりの失敗に戻す。refuted にしない。
      const { runSettlementVerification } = await import("@/lib/observatory/settlement-verifier");
      const l1Calls: unknown[] = [];
      const summary = await runSettlementVerification({
        deps: {
          verify: async () => ({ ok: false, reason: "no_matching_transfer", detail: "fake" }),
          registryHooks: { l1: async (x) => void l1Calls.push(x), l2: async () => {} },
        },
      });
      assert.equal(summary.refuted, 0);
      assert.equal(summary.sellerDeclaredUnsettled, 1);
      assert.equal(l1Calls.length, 0, "Registry へ fail を書かない");
      const back = await get(wazir);
      assert.equal(back.status, "delivered_no_receipt");
      assert.equal(back.txHash, tx("d2"));
      assert.equal(back.settlementVerified, false);
      assert.match(back.settlementVerifyReason ?? "", /^seller_declared_unsettled: no_matching_transfer/);
      assert.equal((await corrections(wazir)).length, 2);
      const third = await late.recoverLateSettlements();
      assert.equal(third.promotedNamedTx, 0, "戻した行は二度と照合へ回さない");
    });

    await t.test("/sellers: 2 回確定の日付と記録頁の分類を実 DB から", async () => {
      await reset();
      const { readSellerFailureDays, readRecordSides } = await import("@/lib/sellers/reader");
      const e = await seedEndpoint();
      const proven = {
        status: "settle_failed",
        http: 500,
        amount: "10000",
      };
      // 関門の後の 5xx（入力の記録あり・ヘッダ宣言なし）× 別の日 2 回
      for (const at of ["2026-09-20T00:00:00Z", "2026-09-22T00:00:00Z"]) {
        const id = await seedRow(e, { ...proven, attemptedAt: new Date(at) });
        await db.execute(sql`UPDATE x402_l1_purchases SET raw_response_meta = '{"phase":"paid","status":500,"requestBody":"none","requestQuery":"empty","contentType":"text/html"}'::jsonb, raw_settlement = '{"success":false,"errorReason":"x","transaction":null}'::jsonb, payer = '0xc9c7b38c0942914fc8ea12063bc92dcd3b581670' WHERE id = ${id}::uuid`);
      }
      await db.execute(sql`UPDATE x402_endpoints SET raw_accepts = ${JSON.stringify([{ payTo: PAY_TO, maxTimeoutSeconds: 10 }])}::jsonb WHERE id = ${e}::uuid`);
      const days = await readSellerFailureDays(db, [e]);
      assert.deepEqual([...(days.get(e) ?? [])].sort(), ["2026-09-20", "2026-09-22"]);
      const sides = await readRecordSides(db, e);
      assert.equal(sides.confirmedSeller, 2);
      const first = [...sides.rows.values()][0];
      assert.equal(first.bucket, "seller");
      assert.match(first.evidence?.answer ?? "", /^HTTP 500 · Content-Type text\/html · PAYMENT-RESPONSE: success false, errorReason x, names no transaction\.$/);
    });
  });
}
