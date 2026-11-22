// ============================================================
// vet402 が自分で足す出品（source = 'operator'・2026-11-22）を、実 DB で通しで確かめる。
//
// 守ること:
//   1. syncOperatorListings は一覧の行を source = 'operator' で x402_endpoints に入れ、snapshot も 'operator' で書く。
//   2. 通常の L1 の候補（Celo のレーン枠と主候補）に入る。特別な経路は無い。
//   3. 同じ上限が効く: その受取先・ホストが当日の売り手の上限（sellerDailyCapUnits）に届けば候補から外れる。
//   4. 配達フィードで listed_in = 'operator' と出て、?listed_in=operator で絞れる。
//   5. 一覧から消した行は次の同期で delisted になる。
// ネットワークにも支払いにも触れない（DB だけ）。
//
// Run: TEST_DATABASE_URL=postgres:///vet402_test_oplist \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/operator-listings.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("operator listings (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("operator の行は入り、通常の L1 の候補に同じ上限で入り、フィードに operator と出る", async () => {
    const { syncOperatorListings } = await import("@/lib/observatory/operator-sync");
    const { OPERATOR_SOURCE } = await import("@/lib/observatory/operator-listings");
    const { l1TargetsSqlBuilders } = await import("@/lib/observatory/l1-runner");
    const { CHAIN_DAILY_CAPS, sellerDailyCapUnits } = await import("@/lib/observatory/budget");
    const { readDeliverySellersFeed } = await import("@/lib/delivery/sellers-feed");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const rowsOf = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];

    const PAY_TO = "0x20faAca5F980E29639A0FCC6dcA6988E18ed333B";
    const listing = (path: string) => ({
      url: `https://gateway.example${path}`,
      method: "GET" as const,
      network: "eip155:42220",
      payTo: PAY_TO,
      asset: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
      amount: "5000",
      extra: { name: "USDC", version: "2" },
      maxTimeoutSeconds: 300,
      reason: "test",
      addedOn: "2026-11-22",
    });
    const A = listing("/v1/a");
    const B = listing("/v1/b");

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases, x402_catalog_snapshots, x402_delisting_events CASCADE`);

    // ---- 1. 同期 ----
    const first = await syncOperatorListings({ listings: [A, B], today: "2026-11-21" });
    assert.equal(first.upserted, 2);
    assert.equal(first.complete, true);
    const eps = rowsOf(await db.execute(sql`SELECT id::text AS id, resource_key, source, method, network, pay_to, price_amount, status FROM x402_endpoints ORDER BY resource_key`));
    assert.deepEqual(
      eps.map((r) => [r.resource_key, r.source, r.method, r.network, r.pay_to, r.price_amount, r.status]),
      [
        ["gateway.example/v1/a", "operator", "GET", "eip155:42220", PAY_TO.toLowerCase(), "5000", "active"],
        ["gateway.example/v1/b", "operator", "GET", "eip155:42220", PAY_TO.toLowerCase(), "5000", "active"],
      ],
    );
    const snaps = rowsOf(await db.execute(sql`SELECT source, total_count, complete FROM x402_catalog_snapshots`));
    assert.deepEqual(snaps.map((s) => [s.source, Number(s.total_count), s.complete]), [[OPERATOR_SOURCE, 2, true]]);
    const idA = String(eps[0].id);
    const idB = String(eps[1].id);

    // ---- 2. 通常の L1 の候補に入る（L0 の pass は他の出どころと同じ条件） ----
    await db.execute(sql`INSERT INTO x402_l0_probes (endpoint_id, method, verdict) SELECT id, 'GET', 'pass' FROM x402_endpoints`);
    const b = l1TargetsSqlBuilders({ limit: 100, laneExclusions: [], firstPurchasesSelectable: true, censusFirstSelectable: true });
    const celoLane = { chain: "celo" as const, networkLike: CHAIN_DAILY_CAPS.celo.networkLike, limit: 100 };
    const ids = async (q: ReturnType<typeof b.targetsSql>) => rowsOf(await db.execute(q)).map((r) => String(r.id)).sort();
    for (const daily of [true, false]) {
      assert.deepEqual(await ids(b.targetsSql(daily, celoLane)), [idA, idB].sort(), `celo lane daily=${daily}`);
      assert.deepEqual(await ids(b.targetsSql(daily, undefined, undefined, undefined, b.primaryExtra)), [idA, idB].sort(), `primary daily=${daily}`);
    }

    // ---- 3. 同じ上限: A の購入で受取先が当日の売り手の上限に届けば、まだ買っていない B も外れる ----
    const cap = sellerDailyCapUnits();
    await db.execute(sql`
      INSERT INTO x402_l1_purchases (endpoint_id, network, status, pay_to, amount_units, spent_units, attempted_at)
      VALUES (${idA}::uuid, 'eip155:42220', 'settled', ${PAY_TO.toLowerCase()}, ${String(cap)}, ${String(cap)}, now())
    `);
    for (const daily of [true, false]) {
      assert.deepEqual(await ids(b.targetsSql(daily, celoLane)), [], `celo lane after cap daily=${daily}`);
      assert.deepEqual(await ids(b.targetsSql(daily, undefined, undefined, undefined, b.primaryExtra)), [], `primary after cap daily=${daily}`);
    }

    // ---- 4. 配達フィード ----
    await db.execute(sql`UPDATE x402_l1_purchases SET http_status_paid = 200, payload_non_empty = true, tx_hash = ${"0x" + "cd".repeat(32)}, payer = ${"0x" + "88".repeat(20)}`);
    const all = await readDeliverySellersFeed(db, { network: null, minDelivered: null, listedIn: null, cursor: null });
    const rowA = all.rows.find((r) => r.url === A.url);
    assert.ok(rowA, "operator row is in the feed");
    assert.equal(rowA.listed_in, "operator");
    const only = await readDeliverySellersFeed(db, { network: null, minDelivered: null, listedIn: "operator", cursor: null });
    assert.deepEqual(only.rows.map((r) => r.url), [A.url]);

    // ---- 5. 一覧から消した行は次の同期で delisted ----
    const second = await syncOperatorListings({ listings: [A], today: "2026-11-22" });
    assert.deepEqual(second.events.filter((e) => e.eventType === "delisted").map((e) => e.resourceKey), ["gateway.example/v1/b"]);
    const statusB = rowsOf(await db.execute(sql`SELECT status FROM x402_endpoints WHERE id = ${idB}::uuid`));
    assert.equal(statusB[0].status, "delisted");
  });
}
