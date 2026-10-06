// ============================================================
// vet402 Observatory L0 — catalog sync integration (design §3, S2+S3).
//
// Runs against a real local Postgres because the properties under test are
// DB properties: upsert identity, snapshot-based diffing across days, event
// idempotency on re-run. Gated behind TEST_DATABASE_URL so `npm test` stays
// green on machines without Postgres; locally:
//
//   createdb vet402_observatory_test
//   psql -d vet402_observatory_test -f scripts/sql/2026-08-14-observatory-l0.sql
//   TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//     npx tsx --test --test-force-exit --test-concurrency=1 tests/observatory-*.test.ts
// (--test-concurrency=1: the DB-backed observatory suites share one database
//  and TRUNCATE it; parallel files clobber each other. --test-force-exit: the
//  postgres pool keeps the event loop alive after the run.)
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("observatory sync integration (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  function item(n: number, extra: Record<string, unknown> = {}) {
    return {
      resource: `https://svc${n}.example/api`,
      description: `service ${n}`,
      accepts: [
        {
          amount: "1000",
          asset: "0xUSDC",
          network: "eip155:8453",
          payTo: `0xPAY${n}`,
          scheme: "exact",
        },
      ],
      extensions: { bazaar: { info: { input: { method: "GET" } } } },
      quality: { l30DaysTotalCalls: 500, l30DaysUniquePayers: 10 },
      ...extra,
    };
  }

  test("observatory sync: full lifecycle across days", async (t) => {
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");

    function fetchResultOf(items: unknown[], opts: { complete?: boolean; total?: number } = {}) {
      const parsed = items.map(parseCatalogItem);
      return {
        items: parsed,
        totalCount: opts.total ?? items.length,
        fetchedCount: items.length,
        complete: opts.complete ?? true,
      };
    }

    const db = getDb()!;
    // clean slate
    await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`);

    await t.test("day 1: first run creates endpoints + snapshot, zero events", async () => {
      const summary = await syncCatalog({
        fetchResult: fetchResultOf([item(1), item(2), item(3)]),
        today: "2026-08-14",
      });
      assert.equal(summary.upserted, 3);
      assert.equal(summary.events.length, 0);
      const endpoints = await db.select().from(schema.x402Endpoints);
      assert.equal(endpoints.length, 3);
      assert.equal(endpoints.every((e) => e.status === "active"), true);
      const snapshots = await db.select().from(schema.x402CatalogSnapshots);
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0].fetchedCount, 3);
    });

    await t.test("day 2: svc2 vanishes on a COMPLETE fetch → delisted event + status flip", async () => {
      const summary = await syncCatalog({
        fetchResult: fetchResultOf([item(1), item(3)]),
        today: "2026-08-15",
      });
      const delisted = summary.events.filter((e) => e.eventType === "delisted");
      assert.equal(delisted.length, 1);
      assert.equal(delisted[0].resourceKey, "svc2.example/api");
      const rows = await db.select().from(schema.x402Endpoints);
      const svc2 = rows.find((r) => r.resourceKey === "svc2.example/api")!;
      assert.equal(svc2.status, "delisted");
      assert.ok(svc2.delistedAt);
    });

    await t.test("day 2 re-run: idempotent — no duplicate delisted event", async () => {
      const summary = await syncCatalog({
        fetchResult: fetchResultOf([item(1), item(3)]),
        today: "2026-08-15",
      });
      assert.equal(summary.events.length, 0);
      const events = await db.select().from(schema.x402DelistingEvents);
      assert.equal(events.filter((e) => e.eventType === "delisted").length, 1);
    });

    await t.test("day 3 incomplete fetch: svc3 missing but NO delisting is recorded", async () => {
      const summary = await syncCatalog({
        fetchResult: fetchResultOf([item(1)], { complete: false, total: 3 }),
        today: "2026-08-16",
      });
      assert.equal(summary.events.filter((e) => e.eventType === "delisted").length, 0);
      const rows = await db.select().from(schema.x402Endpoints);
      const svc3 = rows.find((r) => r.resourceKey === "svc3.example/api")!;
      assert.equal(svc3.status, "active", "fetch gap must not delist");
    });

    await t.test("day 4: svc2 comes back → relisted, status restored", async () => {
      const summary = await syncCatalog({
        fetchResult: fetchResultOf([item(1), item(2), item(3)]),
        today: "2026-08-17",
      });
      const relisted = summary.events.filter((e) => e.eventType === "relisted");
      assert.equal(relisted.length, 1);
      assert.equal(relisted[0].resourceKey, "svc2.example/api");
      const rows = await db.select().from(schema.x402Endpoints);
      const svc2 = rows.find((r) => r.resourceKey === "svc2.example/api")!;
      assert.equal(svc2.status, "active");
      assert.equal(svc2.delistedAt, null);
    });

    await t.test("day 5: call-volume collapse 500→50 → settle_drop with evidence", async () => {
      const dropped = item(1, { quality: { l30DaysTotalCalls: 50, l30DaysUniquePayers: 2 } });
      const summary = await syncCatalog({
        fetchResult: fetchResultOf([dropped, item(2), item(3)]),
        today: "2026-08-18",
      });
      const drops = summary.events.filter((e) => e.eventType === "settle_drop");
      assert.equal(drops.length, 1);
      assert.equal(drops[0].resourceKey, "svc1.example/api");
      // stored quality updated → re-run produces no second event
      const again = await syncCatalog({
        fetchResult: fetchResultOf([dropped, item(2), item(3)]),
        today: "2026-08-18",
      });
      assert.equal(again.events.length, 0);
    });

    await t.test("day 6: a partial re-run never replaces the day's complete snapshot (but may replace an earlier partial one)", async () => {
      const keysOf = async (day: string) => {
        const rows = await db
          .select()
          .from(schema.x402CatalogSnapshots)
          .where(sql`${schema.x402CatalogSnapshots.snapshotDate} = ${day} and ${schema.x402CatalogSnapshots.source} = 'cdp_bazaar'`);
        return { n: (rows[0].resourceKeys as string[]).length, fetched: rows[0].fetchedCount, total: rows[0].totalCount };
      };
      const db = getDb()!;
      await syncCatalog({ fetchResult: fetchResultOf([item(1), item(2), item(3)]), today: "2026-08-19" });
      await syncCatalog({ fetchResult: fetchResultOf([item(1)], { complete: false, total: 3 }), today: "2026-08-19" });
      assert.deepEqual(await keysOf("2026-08-19"), { n: 3, fetched: 3, total: 3 }, "the full snapshot survives the partial re-run");
      // a partial first run of a day is written; a later partial re-run (more rows) replaces it; a complete one replaces both
      await syncCatalog({ fetchResult: fetchResultOf([item(1)], { complete: false, total: 3 }), today: "2026-08-20" });
      assert.equal((await keysOf("2026-08-20")).n, 1);
      await syncCatalog({ fetchResult: fetchResultOf([item(1), item(2)], { complete: false, total: 3 }), today: "2026-08-20" });
      assert.equal((await keysOf("2026-08-20")).n, 2);
      await syncCatalog({ fetchResult: fetchResultOf([item(1), item(2), item(3)]), today: "2026-08-20" });
      assert.deepEqual(await keysOf("2026-08-20"), { n: 3, fetched: 3, total: 3 });
    });
  });
}
