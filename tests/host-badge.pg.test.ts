import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

// 2026-11-11: 試験が自分で行を入れて数える。以前は試験用の DB に既存の購入行があることを前提にしていて、空の CI の DB で落ちた。
const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("readHostBadgeStats (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("readHostBadgeStats counts settled calls in 30 days and answered = 2xx other than 202", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { readHostBadgeStats } = await import("@/lib/sellers/reader");
    const { resourceId, endpointHash, payeeId } = await import("@/lib/ids/canonical");
    const db = getDb();
    assert.ok(db);
    const HOST = "host-badge-test.example";
    const OTHER = "host-badge-other.example";
    const PAY_TO = "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea";
    const PAYER = "0x1111111111111111111111111111111111111111";
    const rowsOf = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { id: string }[];

    async function endpoint(host: string, path: string): Promise<string> {
      const url = `https://${host}${path}`;
      const out = rowsOf(
        await db!.execute(sql`
          INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, price_asset,
                                      canonical_url, resource_id, endpoint_hash, payee_id)
          VALUES (${`${host}${path}`}, ${url}, 'GET', 'eip155:8453', ${PAY_TO}, '1000', '0xusdc',
                  ${url}, ${resourceId("GET", url)}, ${endpointHash(url)}, ${payeeId("eip155:8453", PAY_TO)})
          RETURNING id::text AS id`),
      );
      return out[0].id;
    }
    let n = 0;
    async function purchase(endpointId: string, http: number, daysAgo: number) {
      n += 1;
      const tx = `0x${n.toString(16).padStart(64, "a")}`;
      const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
      await db!.execute(sql`
        INSERT INTO x402_l1_purchases
          (endpoint_id, status, network, asset, pay_to, amount_units, spent_units, payer, tx_hash,
           attempted_at, settlement_verified_at, http_status_paid, raw_response_meta)
        VALUES (${endpointId}::uuid, 'settled', 'eip155:8453', '0xusdc', ${PAY_TO}, '1000', '1000', ${PAYER}, ${tx},
                ${at}::timestamptz, ${at}::timestamptz, ${http}, ${JSON.stringify({})}::jsonb)`);
    }

    const a = await endpoint(HOST, "/v1/a");
    const b = await endpoint(HOST, "/v1/b");
    const o = await endpoint(OTHER, "/v1/a");
    await purchase(a, 200, 1); // answered
    await purchase(a, 202, 2); // settled, not answered (202 Accepted)
    await purchase(b, 500, 3); // settled, not answered
    await purchase(b, 200, 40); // outside the 30-day window
    await purchase(o, 200, 1); // another host

    try {
      const stats = await readHostBadgeStats(db, HOST);
      assert.deepEqual(stats, { settled: 3, answered: 1 });
      const none = await readHostBadgeStats(db, "host-badge-none.example");
      assert.deepEqual(none, { settled: 0, answered: 0 });
    } finally {
      for (const id of [a, b, o]) {
        await db.execute(sql`DELETE FROM x402_l1_purchases WHERE endpoint_id = ${id}::uuid`);
        await db.execute(sql`DELETE FROM x402_endpoints WHERE id = ${id}::uuid`);
      }
    }
  });
}
