// ============================================================
// §7.3 逆引き（DB）: URL → resource、payee → endpoints、endpoint → payees、
// domain → endpoints、tx → settlement + resource。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("resolve lookup (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  test("resolve lookup", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { resolve, endpointsByPayee, payeesByEndpoint, getEndpoint } = await import("@/lib/resolve/lookup");
    const { ingestL1 } = await import("@/lib/settlements/ingest-l1");
    const { resourceId, endpointHash, payeeId } = await import("@/lib/ids/canonical");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE settlements, settlement_daily, x402_l1_purchases, x402_endpoints`);

    const URL = "https://seller.example/api/quote";
    const PAY_TO = "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";
    const RID = resourceId("GET", URL);
    const EH = endpointHash(URL);
    const PID = payeeId("eip155:8453", PAY_TO);
    const raw = await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, price_asset,
                                  canonical_url, resource_id, endpoint_hash, payee_id)
      VALUES ('seller.example/api/quote', ${URL}, 'GET', 'eip155:8453', ${PAY_TO}, '3000', '0xusdc', ${URL}, ${RID}, ${EH}, ${PID})
      RETURNING id::text AS id
    `);
    const uuid = ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows) as { id: string }[])[0].id;
    await db.execute(sql`
      INSERT INTO x402_l1_purchases (endpoint_id, status, network, asset, pay_to, amount_units, spent_units, payer, tx_hash)
      VALUES (${uuid}::uuid, 'settled', 'eip155:8453', '0xusdc', ${PAY_TO}, '3000', '3000', '0x0000000000000000000000000000000000000abc', ${"0x" + "9".repeat(64)})
    `);
    await ingestL1();

    await t.test("URL → resource（表記ゆれ・末尾スラッシュ・大文字 host でも同じ resource_id）", async () => {
      const r = await resolve("https://SELLER.example/api/quote/");
      assert.equal(r.query.kind, "url");
      assert.equal(r.resource?.resource_id, RID);
      assert.equal(r.resource?.endpoint_id, EH);
      assert.equal(r.resource?.observatory_id, uuid);
      assert.equal(r.resource?.payee_id, PID);
      assert.equal(r.resource?.catalog_status, "listed");
    });

    await t.test("payee → endpoints（裸の 0x でも chain:addr でも）", async () => {
      const a = await resolve(PAY_TO);
      assert.equal(a.endpoints?.length, 1);
      assert.equal(a.payees?.[0].payee_id, PID);
      const b = await endpointsByPayee(PID);
      assert.equal(b[0].resource_id, RID);
    });

    await t.test("endpoint → payees（sha でも uuid でも）", async () => {
      assert.deepEqual(await payeesByEndpoint(EH), [{ payee_id: PID, endpoints: 1 }]);
      assert.deepEqual(await payeesByEndpoint(uuid), [{ payee_id: PID, endpoints: 1 }]);
      assert.equal((await getEndpoint(EH))?.observatory_id, uuid);
    });

    await t.test("domain → endpoints", async () => {
      const r = await resolve("seller.example");
      assert.equal(r.query.kind, "domain");
      assert.equal(r.endpoints?.length, 1);
    });

    await t.test("tx → settlement + resource（L1 購入は test・confirmed）", async () => {
      const r = await resolve("0x" + "9".repeat(64));
      assert.equal(r.query.kind, "tx");
      assert.equal(r.settlement?.purchase_id, `eip155:8453:0x${"9".repeat(64)}`);
      assert.equal(r.settlement?.wash_flag, "test");
      assert.equal(r.settlement?.attribution, "confirmed");
      assert.equal(r.resource?.resource_id, RID);
    });

    await t.test("知らないものは空で返す（エラーにしない）", async () => {
      const r = await resolve("https://nobody.example/x");
      assert.equal(r.resource, undefined);
      assert.deepEqual(r.endpoints, []);
    });
  });
}
