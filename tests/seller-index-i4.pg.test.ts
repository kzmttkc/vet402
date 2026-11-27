import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

// 2026-11-27 I4: the index gate against real SQL. The test inserts its own rows and removes them.
// Boundaries: 30-day window edge, a delivery that ages out, a settled-but-not-delivered host,
// and a payee claim that is removed.
const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("seller index gate (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("readIndexableSellerHosts: delivered in 30 days or claimed; undelivered hosts stay out", async () => {
    const { getDb } = await import("@/lib/db/client");
    const { readIndexableSellerHosts } = await import("@/lib/sellers/seller-index");
    const { resourceId, endpointHash, payeeId } = await import("@/lib/ids/canonical");
    const db = getDb();
    assert.ok(db);
    const PAYER = "0x1111111111111111111111111111111111111111";
    const rowsOf = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { id: string }[];

    const HOSTS = {
      fresh: "i4-fresh.example", // delivered 5 days ago
      edgeIn: "i4-edge-in.example", // delivered 30 days minus 1 minute ago
      edgeOut: "i4-edge-out.example", // delivered 30 days plus 1 minute ago
      stale: "i4-stale.example", // delivered 45 days ago, recent purchases failed
      settledOnly: "i4-settled-only.example", // settled, paid HTTP 500, never delivered
      claimed: "i4-claimed.example", // no purchases, payee wallet claimed
      offBoard: "i4-off-board.example", // delivered, but not on the board list
    };
    const payTo = (i: number) => `0x${(0xa0 + i).toString(16).padStart(40, "0")}`;
    const created: string[] = [];
    let k = 0;
    async function endpoint(host: string, wallet: string): Promise<string> {
      const url = `https://${host}/v1/i4`;
      const out = rowsOf(
        await db!.execute(sql`
          INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, price_asset,
                                      canonical_url, resource_id, endpoint_hash, payee_id)
          VALUES (${`${host}/v1/i4`}, ${url}, 'GET', 'eip155:8453', ${wallet}, '1000', '0xusdc',
                  ${url}, ${resourceId("GET", url)}, ${endpointHash(url)}, ${payeeId("eip155:8453", wallet)})
          RETURNING id::text AS id`),
      );
      created.push(out[0].id);
      return out[0].id;
    }
    async function purchase(endpointId: string, wallet: string, http: number, minutesAgo: number) {
      k += 1;
      const tx = `0x${k.toString(16).padStart(64, "b")}`;
      await db!.execute(sql`
        INSERT INTO x402_l1_purchases
          (endpoint_id, status, network, asset, pay_to, amount_units, spent_units, payer, tx_hash,
           attempted_at, settlement_verified_at, http_status_paid, payload_non_empty, raw_response_meta)
        VALUES (${endpointId}::uuid, 'settled', 'eip155:8453', '0xusdc', ${wallet}, '1000', '1000', ${PAYER}, ${tx},
                now() - make_interval(mins => ${minutesAgo}::int), now() - make_interval(mins => ${minutesAgo}::int),
                ${http}, true, ${JSON.stringify({})}::jsonb)`);
    }
    const DAY = 24 * 60;
    const w = Object.fromEntries(Object.keys(HOSTS).map((key, i) => [key, payTo(i)])) as Record<keyof typeof HOSTS, string>;
    await purchase(await endpoint(HOSTS.fresh, w.fresh), w.fresh, 200, 5 * DAY);
    await purchase(await endpoint(HOSTS.edgeIn, w.edgeIn), w.edgeIn, 200, 30 * DAY - 1);
    await purchase(await endpoint(HOSTS.edgeOut, w.edgeOut), w.edgeOut, 200, 30 * DAY + 1);
    const staleEp = await endpoint(HOSTS.stale, w.stale);
    await purchase(staleEp, w.stale, 200, 45 * DAY);
    await purchase(staleEp, w.stale, 500, 2 * DAY);
    const settledEp = await endpoint(HOSTS.settledOnly, w.settledOnly);
    await purchase(settledEp, w.settledOnly, 500, 1 * DAY);
    await purchase(settledEp, w.settledOnly, 202, 3 * DAY);
    await endpoint(HOSTS.claimed, w.claimed);
    await purchase(await endpoint(HOSTS.offBoard, w.offBoard), w.offBoard, 200, 1 * DAY);
    await db.execute(sql`
      INSERT INTO verified_payees (wallet, name, url, signature)
      VALUES (${w.claimed}, 'i4 test payee', ${`https://${HOSTS.claimed}`}, '0xsig')`);

    const board = [HOSTS.fresh, HOSTS.edgeIn, HOSTS.edgeOut, HOSTS.stale, HOSTS.settledOnly, HOSTS.claimed];
    try {
      const before = await readIndexableSellerHosts(db, board);
      assert.deepEqual(before, [HOSTS.claimed, HOSTS.edgeIn, HOSTS.fresh].sort((a, b) => a.localeCompare(b)));
      for (const out of [HOSTS.edgeOut, HOSTS.stale, HOSTS.settledOnly, HOSTS.offBoard]) {
        assert.equal(before.includes(out), false, `${out} must stay out of the index list`);
      }

      // Claim removed: the host drops out on the next read.
      await db.execute(sql`DELETE FROM verified_payees WHERE wallet = ${w.claimed}`);
      const afterUnclaim = await readIndexableSellerHosts(db, board);
      assert.equal(afterUnclaim.includes(HOSTS.claimed), false);

      // Delivery ages out: move the fresh host's only delivery to 31 days ago.
      await db.execute(sql`
        UPDATE x402_l1_purchases SET attempted_at = now() - interval '31 days'
        WHERE endpoint_id IN (SELECT id FROM x402_endpoints WHERE resource_key = ${`${HOSTS.fresh}/v1/i4`})`);
      const afterAge = await readIndexableSellerHosts(db, board);
      assert.deepEqual(afterAge, [HOSTS.edgeIn]);
    } finally {
      await db.execute(sql`DELETE FROM verified_payees WHERE wallet = ${w.claimed}`);
      for (const id of created) {
        await db.execute(sql`DELETE FROM x402_l1_purchases WHERE endpoint_id = ${id}::uuid`);
        await db.execute(sql`DELETE FROM x402_endpoints WHERE id = ${id}::uuid`);
      }
    }
  });
}
