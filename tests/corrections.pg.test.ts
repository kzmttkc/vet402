// ============================================================
// §10: 売り手異議 → 別経路の再測定 → 覆れば訂正ログ、覆らなければ原判定維持・
// 連続異議のレート制限。すべて人手なしで閉じる。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("corrections (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  test("corrections", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { submitDispute, disputeMessage } = await import("@/lib/observatory/disputes");
    const { listCorrections, recordCorrection } = await import("@/lib/observatory/corrections");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE correction_log, disputes, x402_l0_probes, x402_endpoints`);

    const account = privateKeyToAccount(`0x${"1".repeat(64)}`);
    const PAY_TO = account.address.toLowerCase();
    const raw = await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, price_asset)
      VALUES ('seller.example/api/x', 'https://seller.example/api/x', 'GET', 'eip155:8453', ${PAY_TO}, '1000', '0xusdc')
      RETURNING id::text AS id
    `);
    const endpointId = ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows) as { id: string }[])[0].id;
    // 公開 fail（2 連続 fail）を作る
    await db.execute(sql`
      INSERT INTO x402_l0_probes (endpoint_id, method, verdict, http_status, fail_reason, probed_at)
      VALUES (${endpointId}::uuid, 'GET', 'fail', 500, 'no_402', now() - interval '2 hours'),
             (${endpointId}::uuid, 'GET', 'fail', 500, 'no_402', now() - interval '1 hour')
    `);

    const envelope = Buffer.from(
      JSON.stringify({ x402Version: 2, accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0xusdc", payTo: PAY_TO }] }),
    ).toString("base64");
    const passFetch = async () => new Response("{}", { status: 402, headers: { "payment-required": envelope } });

    const dispute = async (n: number, fetchImpl: typeof passFetch) => {
      const issued = new Date().toISOString();
      const reason = `retest ${n}`;
      const message = disputeMessage({ endpointId, subject: "l0", reason, issued });
      const signature = await account.signMessage({ message });
      return submitDispute({ endpointId, subject: "l0", reason, issued, address: account.address, signature }, { fetchImpl });
    };

    await t.test("再測定で pass に覆ると訂正ログに before/after が残る", async () => {
      const r = await dispute(1, passFetch);
      assert.equal(r.ok, true);
      const rows = await listCorrections({ endpointId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].reason, "dispute_remeasure");
      assert.deepEqual(rows[0].before, { publishedVerdict: "fail" });
      assert.equal((rows[0].after as { publishedVerdict: string }).publishedVerdict, "pass");
      assert.equal(rows[0].dispute_id !== null, true);
    });

    await t.test("再測定は別経路（recheck UA）で行われ、通常プローブ行として残る", async () => {
      const rows = await db.execute(sql`SELECT raw_response_meta FROM x402_l0_probes WHERE endpoint_id = ${endpointId}::uuid ORDER BY probed_at DESC LIMIT 1`);
      const meta = ((Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows) as { raw_response_meta: Record<string, unknown> }[])[0].raw_response_meta;
      assert.equal(meta.trigger, "dispute");
      assert.equal(meta.route, "recheck_same_egress");
      assert.match(String(meta.client), /recheck/);
    });

    await t.test("覆らなければ訂正ログは増えない", async () => {
      const r = await dispute(2, passFetch); // 直近が pass なので published は pass のまま
      assert.equal(r.ok, true);
      assert.equal((await listCorrections({ endpointId })).length, 1);
    });

    await t.test("7 日で 3 件目以降の異議は rate_limited", async () => {
      const r3 = await dispute(3, passFetch);
      assert.equal(r3.ok, true);
      const r4 = await dispute(4, passFetch);
      assert.equal(r4.ok, false);
      assert.equal(!r4.ok && r4.reason, "rate_limited");
    });

    await t.test("settlement_backfill の訂正も同じ表に載る", async () => {
      const id = await recordCorrection({
        subjectType: "purchase",
        subjectId: "00000000-0000-0000-0000-000000000009",
        level: "l1",
        before: { status: "settle_claimed" },
        after: { status: "settle_claim_refuted" },
        reason: "settlement_backfill",
      });
      assert.ok(id);
      const all = await listCorrections({});
      assert.equal(all.length, 2);
    });
  });
}
