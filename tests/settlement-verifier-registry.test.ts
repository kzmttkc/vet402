// ============================================================
// 2026-09-02 監査 P1-7: ERC-8004 Validation Registry の発火点。
//
// 以前は l1-runner が購入直後に `settled = claimedAndWellFormed`（売り手の
// 自己申告）を verdict として hook を呼んでいた。オンチェーンに載せる事実は
// 「我々がチェーンで確認した」ものだけ——発火点は settlement-verifier の
// settled / settle_claim_refuted 確定後に限る。ここではそれを DB 実走で固定する。
// viem（チェーン照合）と hook 本体は注入で差し替える。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("settlement-verifier registry firing (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  const PAY_TO = "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";
  const PAYER = "0x1111111111111111111111111111111111111111";
  const TX = `0x${"ab".repeat(32)}`;

  test("registry hook fires only after on-chain settlement is confirmed", async (t) => {
    const { runSettlementVerification } = await import("@/lib/observatory/settlement-verifier");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql, eq } = await import("drizzle-orm");
    const db = getDb()!;

    type L1Call = { endpointId: string; payTo: string | null; settled: boolean; txHash?: string | null; network?: string | null };
    type L2Call = { endpointId: string; payTo: string | null; l2: "conform" | "mismatch"; txHash?: string | null; network?: string | null };

    async function seed(l2Schema: string) {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_l1_purchases, observed_purchases, settlements, correction_log`,
      );
      const endpointId = randomUUID();
      await db.insert(schema.x402Endpoints).values({
        id: endpointId,
        resourceKey: `GET https://seller.example/api/${endpointId}`,
        resourceUrl: `https://seller.example/api/${endpointId}`,
        method: "GET",
        payTo: PAY_TO,
        network: "eip155:8453",
        status: "active",
        lastSeenAt: new Date(),
      });
      const [row] = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId,
          status: "settle_claimed",
          network: "eip155:8453",
          payTo: PAY_TO,
          payer: PAYER,
          amountUnits: "1000",
          spentUnits: "1000",
          txHash: TX,
          httpStatusPaid: 200,
          payloadNonEmpty: true,
          l2Schema,
        })
        .returning();
      return { endpointId, purchaseId: row.id };
    }

    function hooks() {
      const l1: L1Call[] = [];
      const l2: L2Call[] = [];
      return {
        l1,
        l2,
        deps: {
          registryHooks: {
            l1: async (input: L1Call) => {
              l1.push(input);
            },
            l2: async (input: L2Call) => {
              l2.push(input);
            },
          },
        },
      };
    }

    await t.test("settled 確定 → L1 hook（settled:true）と L2 hook（conform）が 1 回ずつ", async () => {
      const { endpointId, purchaseId } = await seed("match");
      const h = hooks();
      const summary = await runSettlementVerification({
        limit: 10,
        deps: {
          ...h.deps,
          verify: async () => ({ ok: true, blockTimestamp: new Date(), confirmations: 100n, blockNumber: 1n }),
        },
      });
      assert.equal(summary.verified, 1);
      const [after] = await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, purchaseId));
      assert.equal(after.status, "settled");
      assert.deepEqual(h.l1, [{ endpointId, payTo: PAY_TO, settled: true, txHash: TX, network: "eip155:8453" }]);
      assert.deepEqual(h.l2, [{ endpointId, payTo: PAY_TO, l2: "conform", txHash: TX, network: "eip155:8453" }]);
    });

    await t.test("settled 確定・L2 mismatch → L2 hook は mismatch", async () => {
      const { endpointId } = await seed("mismatch");
      const h = hooks();
      await runSettlementVerification({
        limit: 10,
        deps: {
          ...h.deps,
          verify: async () => ({ ok: true, blockTimestamp: new Date(), confirmations: 100n, blockNumber: 1n }),
        },
      });
      assert.equal(h.l1.length, 1);
      assert.deepEqual(h.l2, [{ endpointId, payTo: PAY_TO, l2: "mismatch", txHash: TX, network: "eip155:8453" }]);
    });

    await t.test("settled 確定・L2 未検査 → L2 hook は呼ばない（未検査を conform と書かない）", async () => {
      await seed("not_checked");
      const h = hooks();
      await runSettlementVerification({
        limit: 10,
        deps: {
          ...h.deps,
          verify: async () => ({ ok: true, blockTimestamp: new Date(), confirmations: 100n, blockNumber: 1n }),
        },
      });
      assert.equal(h.l1.length, 1);
      assert.equal(h.l2.length, 0);
    });

    await t.test("refuted 確定 → L1 hook（settled:false）で fail を記録・L2 hook は呼ばない", async () => {
      const { endpointId, purchaseId } = await seed("match");
      const h = hooks();
      const summary = await runSettlementVerification({
        limit: 10,
        deps: { ...h.deps, verify: async () => ({ ok: false, reason: "no_matching_transfer" }) },
      });
      assert.equal(summary.refuted, 1);
      const [after] = await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, purchaseId));
      assert.equal(after.status, "settle_claim_refuted");
      assert.deepEqual(h.l1, [{ endpointId, payTo: PAY_TO, settled: false, txHash: TX, network: "eip155:8453" }]);
      assert.equal(h.l2.length, 0);
    });

    await t.test("一時的な失敗（tx_not_found）→ 何も発火しない（自己申告のままでは書かない）", async () => {
      const { purchaseId } = await seed("match");
      const h = hooks();
      const summary = await runSettlementVerification({
        limit: 10,
        deps: { ...h.deps, verify: async () => ({ ok: false, reason: "tx_not_found" }) },
      });
      assert.equal(summary.deferred, 1);
      const [after] = await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, purchaseId));
      assert.equal(after.status, "settle_claimed");
      assert.equal(h.l1.length, 0);
      assert.equal(h.l2.length, 0);
    });

    await t.test("hook が投げても照合の結果は変わらない（graceful）", async () => {
      const { purchaseId } = await seed("match");
      const summary = await runSettlementVerification({
        limit: 10,
        deps: {
          registryHooks: {
            l1: async () => {
              throw new Error("boom");
            },
            l2: async () => {
              throw new Error("boom");
            },
          },
          verify: async () => ({ ok: true, blockTimestamp: new Date(), confirmations: 100n, blockNumber: 1n }),
        },
      });
      assert.equal(summary.verified, 1);
      const [after] = await db.select().from(schema.x402L1Purchases).where(eq(schema.x402L1Purchases.id, purchaseId));
      assert.equal(after.status, "settled");
    });
  });
}
