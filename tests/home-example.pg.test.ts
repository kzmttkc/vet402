import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("home example (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("readHomeExample: settled but undelivered purchases do not appear on the home surface", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { readHomeExample } = await import("@/lib/observatory/home-example");
    const { resourceId, endpointHash, payeeId } = await import("@/lib/ids/canonical");
    const db = getDb();
    assert.ok(db);
    const PAYER = "0x1111111111111111111111111111111111111111";
    const rowsOf = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { id: string }[];
    const HOST = "c1-home-undelivered.example";
    const payTo = "0xdddddddddddddddddddddddddddddddddddddddd";
    const url = `https://${HOST}/v1/home`;
    const ep = rowsOf(
      await db.execute(sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, price_asset,
                                    canonical_url, resource_id, endpoint_hash, payee_id)
        VALUES (${`${HOST}/v1/home`}, ${url}, 'GET', 'eip155:8453', ${payTo}, '1000', '0xusdc',
                ${url}, ${resourceId("GET", url)}, ${endpointHash(url)}, ${payeeId("eip155:8453", payTo)})
        RETURNING id::text AS id`),
    )[0].id;
    await db.execute(sql`
      INSERT INTO x402_l1_purchases
        (endpoint_id, status, network, asset, pay_to, amount_units, spent_units, payer, tx_hash,
         attempted_at, settlement_verified_at, http_status_paid, payload_non_empty, raw_response_meta)
      VALUES (${ep}::uuid, 'settled', 'eip155:8453', '0xusdc', ${payTo}, '1000', '1000', ${PAYER}, ${`0x${"e".repeat(64)}`},
              now() - interval '10 minutes', now() - interval '10 minutes',
              500, true, ${JSON.stringify({})}::jsonb)`);
    const deliveredHost = "c1-home-delivered.example";
    const payTo2 = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const url2 = `https://${deliveredHost}/v1/home`;
    const ep2 = rowsOf(
      await db.execute(sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, price_asset,
                                    canonical_url, resource_id, endpoint_hash, payee_id)
        VALUES (${`${deliveredHost}/v1/home`}, ${url2}, 'GET', 'eip155:8453', ${payTo2}, '1000', '0xusdc',
                ${url2}, ${resourceId("GET", url2)}, ${endpointHash(url2)}, ${payeeId("eip155:8453", payTo2)})
        RETURNING id::text AS id`),
    )[0].id;
    await db.execute(sql`
      INSERT INTO x402_l1_purchases
        (endpoint_id, status, network, asset, pay_to, amount_units, spent_units, payer, tx_hash,
         attempted_at, settlement_verified_at, http_status_paid, payload_non_empty, raw_response_meta)
      VALUES (${ep2}::uuid, 'settled', 'eip155:8453', '0xusdc', ${payTo2}, '1000', '1000', ${PAYER}, ${`0x${"f".repeat(64)}`},
              now() - interval '30 minutes', now() - interval '30 minutes',
              200, true, ${JSON.stringify({})}::jsonb)`);
    try {
      const home = await readHomeExample();
      assert.ok(home, "a delivered row exists in the window");
      assert.equal(home.receipt.host, deliveredHost);
      assert.equal(home.receipt.delivered, true);
      for (const row of home.latest) {
        assert.equal(row.delivered, true, `latest row ${row.purchaseId} must be delivered`);
        assert.notEqual(row.host, HOST);
      }
    } finally {
      await db.execute(sql`DELETE FROM x402_l1_purchases WHERE endpoint_id IN (${ep}::uuid, ${ep2}::uuid)`);
      await db.execute(sql`DELETE FROM x402_endpoints WHERE id IN (${ep}::uuid, ${ep2}::uuid)`);
    }
  });
}