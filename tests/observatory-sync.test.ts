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
      // an empty day (first page never answered: 0 of 0) is replaced by a later partial run; a later empty run never wipes rows
      await syncCatalog({ fetchResult: fetchResultOf([], { complete: false, total: 0 }), today: "2026-08-21" });
      assert.deepEqual(await keysOf("2026-08-21"), { n: 0, fetched: 0, total: 0 });
      await syncCatalog({ fetchResult: fetchResultOf([item(1), item(2)], { complete: false, total: 3 }), today: "2026-08-21" });
      assert.equal((await keysOf("2026-08-21")).n, 2);
      await syncCatalog({ fetchResult: fetchResultOf([], { complete: false, total: 0 }), today: "2026-08-21" });
      assert.equal((await keysOf("2026-08-21")).n, 2, "an empty re-run does not wipe a partial snapshot");
    });

    await t.test("CDP と Circle の同じ resource は 1 行。片方から消えても active が残る", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`);
      const baseAccept = {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x1111111111111111111111111111111111111111",
      };
      const gwAccept = {
        scheme: "exact",
        network: "eip155:5042",
        amount: "100000",
        asset: "0x3600000000000000000000000000000000000000",
        payTo: "0xBd7b9f3e0CD3E1f6e698D0eeBb99F96E093BdeE3",
        maxTimeoutSeconds: 604900,
        extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000ee" },
      };
      const cdpItem = parseCatalogItem({
        resource: "https://api.seller.example/v1/item",
        description: "from cdp",
        accepts: [baseAccept],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
      });
      const circleItem = parseCatalogItem({
        resource: "https://API.Seller.example/v1/item/",
        metadata: { method: "POST", description: "from circle" },
        accepts: [baseAccept, gwAccept],
      });
      const gwOnly = parseCatalogItem({
        resource: "https://gw-only.example/only",
        metadata: { method: "GET", description: "gateway only" },
        accepts: [gwAccept],
      });
      const other = (n: number) => parseCatalogItem({
        resource: `https://other${n}.example/api`,
        accepts: [baseAccept],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
      });
      assert.equal(cdpItem.resourceKey, circleItem.resourceKey);
      const pack = (items: ReturnType<typeof parseCatalogItem>[], opts: { complete?: boolean; total?: number } = {}) => ({
        items,
        totalCount: opts.total ?? items.length,
        fetchedCount: items.length,
        complete: opts.complete ?? true,
      });
      const rowsFor = async (key: string) => {
        const rows = await db.select().from(schema.x402Endpoints).where(sql`${schema.x402Endpoints.resourceKey} = ${key}`);
        return rows;
      };
      const hasGateway = (raw: unknown) =>
        Array.isArray(raw) && raw.some((a) => (a as { extra?: { name?: string }; network?: string }).extra?.name === "GatewayWalletBatched" && (a as { network?: string }).network === "eip155:5042");

      await syncCatalog({ fetchResult: pack([cdpItem]), today: "2026-10-01", source: "cdp_bazaar" });
      await syncCatalog({ fetchResult: pack([circleItem, gwOnly]), today: "2026-10-01", source: "circle_discovery" });
      let shared = await rowsFor(cdpItem.resourceKey);
      assert.equal(shared.length, 1);
      assert.equal(shared[0]?.status, "active");
      assert.equal(shared[0]?.source, "cdp_bazaar");
      assert.equal(hasGateway(shared[0]?.rawAccepts), true);
      const only = await rowsFor(gwOnly.resourceKey);
      assert.equal(only.length, 1);
      assert.equal(only[0]?.source, "circle_discovery");
      assert.equal(only[0]?.status, "active");

      await syncCatalog({ fetchResult: pack([other(1)]), today: "2026-10-02", source: "cdp_bazaar" });
      shared = await rowsFor(cdpItem.resourceKey);
      assert.equal(shared[0]?.status, "active", "Circle の完全な snapshot がまだ載せているので active");

      await syncCatalog({ fetchResult: pack([other(2)], { complete: false, total: 2 }), today: "2026-10-02", source: "circle_discovery" });
      await syncCatalog({ fetchResult: pack([other(1)]), today: "2026-10-03", source: "cdp_bazaar" });
      shared = await rowsFor(cdpItem.resourceKey);
      assert.equal(shared[0]?.status, "active", "Circle の不完全な取得は直前の完全な snapshot の鍵を不在にしない");
      assert.equal((await rowsFor(gwOnly.resourceKey))[0]?.status, "active");

      await syncCatalog({ fetchResult: pack([circleItem, gwOnly]), today: "2026-10-03", source: "circle_discovery" });
      await syncCatalog({ fetchResult: pack([other(3)]), today: "2026-10-04", source: "circle_discovery" });
      shared = await rowsFor(cdpItem.resourceKey);
      assert.equal(shared.length, 1);
      assert.equal(shared[0]?.status, "delisted", "両方の完全な snapshot から消えたら持ち主の行も delist");
      // 10/3 の Circle は鍵を載せ、CDP の最新の完全な取得には無い。持ち主は Circle に移ってから delist する。
      assert.equal(shared[0]?.source, "circle_discovery");
      assert.equal((await rowsFor(gwOnly.resourceKey))[0]?.status, "delisted");

      await syncCatalog({ fetchResult: pack([cdpItem]), today: "2026-10-05", source: "cdp_bazaar" });
      await syncCatalog({ fetchResult: pack([circleItem]), today: "2026-10-05", source: "circle_discovery" });
      shared = await rowsFor(cdpItem.resourceKey);
      assert.equal(shared.length, 1);
      assert.equal(shared[0]?.status, "active");
      assert.equal(shared[0]?.source, "cdp_bazaar");
      assert.equal(hasGateway(shared[0]?.rawAccepts), true);

      await syncCatalog({ fetchResult: pack([other(3)]), today: "2026-10-06", source: "circle_discovery" });
      shared = await rowsFor(cdpItem.resourceKey);
      assert.equal(shared[0]?.status, "active", "CDP がまだ載せているので Circle から消えても active");

      const mppItem = parseCatalogItem({
        resource: "https://api.seller.example/v1/item",
        description: "mpp",
        accepts: [baseAccept],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
      });
      await syncCatalog({ fetchResult: pack([mppItem]), today: "2026-10-06", source: "mpp_directory" });
      shared = await rowsFor(cdpItem.resourceKey);
      assert.deepEqual(shared.map((r) => r.source).sort(), ["cdp_bazaar", "mpp_directory"]);

      const first = parseCatalogItem({
        resource: "https://first-circle.example/only",
        metadata: { method: "GET", description: "circle first" },
        accepts: [gwAccept],
      });
      const later = parseCatalogItem({
        resource: "https://FIRST-CIRCLE.example/only/",
        description: "cdp later",
        accepts: [baseAccept],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
      });
      assert.equal(first.resourceKey, later.resourceKey);
      await syncCatalog({ fetchResult: pack([first]), today: "2026-10-07", source: "circle_discovery" });
      await syncCatalog({ fetchResult: pack([later]), today: "2026-10-07", source: "cdp_bazaar" });
      const owned = await rowsFor(first.resourceKey);
      assert.equal(owned.length, 1);
      assert.equal(owned[0]?.source, "circle_discovery");
      assert.equal(owned[0]?.status, "active");
      assert.equal(hasGateway(owned[0]?.rawAccepts), true);
      const accepts = owned[0]?.rawAccepts as { network?: string }[];
      assert.equal(accepts.some((a) => a.network === "eip155:8453"), true);
    });

    const baseAccept = {
      scheme: "exact",
      network: "eip155:8453",
      amount: "1000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x1111111111111111111111111111111111111111",
    };
    const gwAccept = {
      scheme: "exact",
      network: "eip155:5042",
      amount: "100000",
      asset: "0x3600000000000000000000000000000000000000",
      payTo: "0xBd7b9f3e0CD3E1f6e698D0eeBb99F96E093BdeE3",
      maxTimeoutSeconds: 604900,
      extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x77777777Dcc4d5A8B6E418Fd04D8997ef11000ee" },
    };
    const solAccept = {
      scheme: "exact",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      amount: "2000",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      payTo: "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd",
    };
    const pack = (items: ReturnType<typeof parseCatalogItem>[], opts: { complete?: boolean; total?: number } = {}) => ({
      items,
      totalCount: opts.total ?? items.length,
      fetchedCount: items.length,
      complete: opts.complete ?? true,
    });
    const cdpOf = (resource: string, accepts: unknown[], description = "from cdp") =>
      parseCatalogItem({
        resource,
        description,
        accepts,
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
      });
    const circleOf = (resource: string, accepts: unknown[], method = "POST", description = "from circle") =>
      parseCatalogItem({ resource, metadata: { method, description }, accepts });
    const rowsFor = async (key: string) => {
      const rows = await db.select().from(schema.x402Endpoints).where(sql`resource_key = ${key}`);
      return rows;
    };
    const delistCount = async () => {
      const events = await db.select().from(schema.x402DelistingEvents);
      return events.filter((e) => e.eventType === "delisted").length;
    };
    const SHARED = "https://shared-review.example/v1/item";

    await t.test("持ち主の不完全な取得でも、兄弟の鍵の和に無ければ delist する", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`);
      const cdp = cdpOf(SHARED, [baseAccept]);
      const circle = circleOf(SHARED, [baseAccept, gwAccept]);
      await syncCatalog({ fetchResult: pack([cdp]), today: "2026-11-01", source: "cdp_bazaar" });
      await syncCatalog({ fetchResult: pack([circle]), today: "2026-11-01", source: "circle_discovery" });
      await syncCatalog({ fetchResult: pack([cdpOf("https://other.example/a", [baseAccept])]), today: "2026-11-02", source: "cdp_bazaar" });
      await syncCatalog({ fetchResult: pack([circle]), today: "2026-11-02", source: "circle_discovery" });
      let row = (await rowsFor(cdp.resourceKey))[0];
      assert.equal(row?.status, "active");
      await syncCatalog({
        fetchResult: pack([cdpOf("https://other.example/a", [baseAccept])], { complete: false, total: 5 }),
        today: "2026-11-03",
        source: "cdp_bazaar",
      });
      row = (await rowsFor(cdp.resourceKey))[0];
      assert.equal(row?.status, "active", "CDP の欠けた取得だけでは落とさない");
      const summary = await syncCatalog({
        fetchResult: pack([circleOf("https://other.example/b", [gwAccept])]),
        today: "2026-11-03",
        source: "circle_discovery",
      });
      row = (await rowsFor(cdp.resourceKey))[0];
      assert.equal(row?.status, "delisted");
      assert.equal(summary.events.filter((e) => e.eventType === "delisted").length, 1);
      await syncCatalog({
        fetchResult: pack([circleOf("https://other.example/b", [gwAccept])]),
        today: "2026-11-04",
        source: "circle_discovery",
      });
      assert.equal(await delistCount(), 1, "翌日も事象は増えない");
    });

    await t.test("同じ日に 2 回走っても delisted の事象は 1 行", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`);
      const cdp = cdpOf(SHARED, [baseAccept]);
      const circle = circleOf(SHARED, [gwAccept]);
      await syncCatalog({ fetchResult: pack([circle]), today: "2026-11-10", source: "circle_discovery" });
      await syncCatalog({ fetchResult: pack([cdp]), today: "2026-11-10", source: "cdp_bazaar" });
      await syncCatalog({ fetchResult: pack([]), today: "2026-11-11", source: "cdp_bazaar" });
      const morning = await syncCatalog({ fetchResult: pack([]), today: "2026-11-11", source: "circle_discovery" });
      assert.equal(morning.events.filter((e) => e.eventType === "delisted").length, 1);
      const afternoon = await syncCatalog({ fetchResult: pack([]), today: "2026-11-11", source: "cdp_bazaar" });
      assert.equal(afternoon.events.filter((e) => e.eventType === "delisted").length, 0);
      assert.equal(await delistCount(), 1);
    });

    await t.test("持ち主を移し、accepts は積み上がらない", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`);
      const circle = circleOf(SHARED, [gwAccept], "POST", "from circle");
      const cdp = cdpOf(SHARED, [baseAccept], "from cdp");
      await syncCatalog({ fetchResult: pack([circle]), today: "2026-11-20", source: "circle_discovery" });
      await syncCatalog({ fetchResult: pack([cdp]), today: "2026-11-20", source: "cdp_bazaar" });
      await syncCatalog({ fetchResult: pack([]), today: "2026-11-21", source: "circle_discovery" });
      await syncCatalog({ fetchResult: pack([cdp]), today: "2026-11-21", source: "cdp_bazaar" });
      const row = (await rowsFor(cdp.resourceKey))[0];
      assert.equal(row?.source, "cdp_bazaar");
      assert.equal(row?.method, "GET");
      assert.equal(row?.description, "from cdp");
      assert.equal(row?.priceAmount, "1000");
      const accepts = row?.rawAccepts as { extra?: { name?: string }; network?: string }[];
      assert.ok(Array.isArray(accepts));
      assert.equal(accepts.some((a) => a.extra?.name === "GatewayWalletBatched"), false);
      assert.equal(accepts.some((a) => a.network === "eip155:8453"), true);
      const bySource = row?.acceptsBySource as Record<string, unknown>;
      assert.equal(bySource.circle_discovery, undefined);
      assert.ok(Array.isArray(bySource.cdp_bazaar));
    });

    await t.test("source ごとの accepts は相手の実行で消えず、slice は置き換わる", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`);
      const cdp = cdpOf(SHARED, [baseAccept]);
      const circle = circleOf(SHARED, [gwAccept]);
      await syncCatalog({ fetchResult: pack([cdp]), today: "2026-11-25", source: "cdp_bazaar" });
      await syncCatalog({ fetchResult: pack([circle]), today: "2026-11-25", source: "circle_discovery" });
      await syncCatalog({ fetchResult: pack([cdp]), today: "2026-11-26", source: "cdp_bazaar" });
      let row = (await rowsFor(cdp.resourceKey))[0];
      let accepts = row?.rawAccepts as { extra?: { name?: string }; network?: string }[];
      assert.equal(accepts.some((a) => a.extra?.name === "GatewayWalletBatched"), true, "CDP の実行は Circle の accept を残す");
      const circleNext = circleOf(SHARED, [solAccept]);
      await syncCatalog({ fetchResult: pack([circleNext]), today: "2026-11-26", source: "circle_discovery" });
      row = (await rowsFor(cdp.resourceKey))[0];
      accepts = row?.rawAccepts as { extra?: { name?: string }; network?: string }[];
      assert.equal(accepts.some((a) => a.extra?.name === "GatewayWalletBatched"), false);
      assert.equal(accepts.some((a) => a.network === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), true);
      assert.equal(accepts.some((a) => a.network === "eip155:8453"), true);
      assert.equal(row?.source, "cdp_bazaar");
    });

    await t.test("両方の不完全な日を挟むと、次の完全な取得の突き合わせで delist する", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`);
      const cdp = cdpOf(SHARED, [baseAccept]);
      const circle = circleOf(SHARED, [gwAccept]);
      const otherCdp = cdpOf("https://keep.example/a", [baseAccept]);
      const otherCircle = circleOf("https://keep.example/b", [gwAccept]);
      await syncCatalog({ fetchResult: pack([cdp, otherCdp]), today: "2026-12-01", source: "cdp_bazaar" });
      await syncCatalog({ fetchResult: pack([circle, otherCircle]), today: "2026-12-01", source: "circle_discovery" });
      await syncCatalog({ fetchResult: pack([otherCdp], { complete: false, total: 9 }), today: "2026-12-02", source: "cdp_bazaar" });
      await syncCatalog({ fetchResult: pack([otherCircle], { complete: false, total: 9 }), today: "2026-12-02", source: "circle_discovery" });
      assert.equal((await rowsFor(cdp.resourceKey))[0]?.status, "active");
      await syncCatalog({ fetchResult: pack([otherCdp]), today: "2026-12-03", source: "cdp_bazaar" });
      assert.equal((await rowsFor(cdp.resourceKey))[0]?.status, "active", "Circle の完全な取得がまだ無い");
      const summary = await syncCatalog({ fetchResult: pack([otherCircle]), today: "2026-12-03", source: "circle_discovery" });
      assert.equal((await rowsFor(cdp.resourceKey))[0]?.status, "delisted");
      assert.equal(summary.events.filter((e) => e.eventType === "delisted" && e.resourceKey === cdp.resourceKey).length, 1);
    });

    await t.test("今日の不完全なページで見た鍵は突き合わせで落とさない", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`);
      const cdp = cdpOf(SHARED, [baseAccept]);
      const circle = circleOf(SHARED, [gwAccept]);
      await syncCatalog({ fetchResult: pack([cdp]), today: "2026-12-10", source: "cdp_bazaar" });
      await syncCatalog({ fetchResult: pack([circle]), today: "2026-12-10", source: "circle_discovery" });
      await syncCatalog({ fetchResult: pack([cdp], { complete: false, total: 4 }), today: "2026-12-11", source: "cdp_bazaar" });
      await syncCatalog({ fetchResult: pack([]), today: "2026-12-11", source: "circle_discovery" });
      assert.equal((await rowsFor(cdp.resourceKey))[0]?.status, "active");
      assert.equal(await delistCount(), 0);
    });

    await t.test("page_shape の snapshot は件数が揃っても完全にしない", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`);
      const cdp = cdpOf(SHARED, [baseAccept]);
      const circle = circleOf(SHARED, [gwAccept]);
      await syncCatalog({ fetchResult: pack([circle], { complete: false, total: 8 }), today: "2026-12-15", source: "circle_discovery" });
      await syncCatalog({ fetchResult: pack([cdp]), today: "2026-12-15", source: "cdp_bazaar" });
      await syncCatalog({
        fetchResult: pack([circleOf("https://other.example/c", [gwAccept])], { complete: false, total: 1 }),
        today: "2026-12-16",
        source: "circle_discovery",
      });
      const snaps = await db.select().from(schema.x402CatalogSnapshots).where(sql`source = 'circle_discovery' and snapshot_date = '2026-12-16'`);
      assert.equal(snaps[0]?.complete, false);
      assert.equal(snaps[0]?.fetchedCount, snaps[0]?.totalCount);
      await syncCatalog({ fetchResult: pack([]), today: "2026-12-16", source: "cdp_bazaar" });
      assert.equal((await rowsFor(cdp.resourceKey))[0]?.status, "active");
    });

    await t.test("記録しなかった delist は summary に出さない", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`);
      const cdp = cdpOf(SHARED, [baseAccept]);
      await syncCatalog({ fetchResult: pack([cdp]), today: "2026-12-20", source: "cdp_bazaar" });
      await db.execute(sql`DELETE FROM x402_endpoints`);
      const summary = await syncCatalog({ fetchResult: pack([]), today: "2026-12-21", source: "cdp_bazaar" });
      assert.equal(summary.events.filter((e) => e.eventType === "delisted").length, 0);
      assert.equal(await delistCount(), 0);
    });

    await t.test("別名は持ち主の method だけで作る", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_resource_aliases`);
      const { resourceId } = await import("@/lib/ids/canonical");
      const cdp = cdpOf(SHARED, [baseAccept]);
      const circle = circleOf(SHARED, [gwAccept], "POST");
      await syncCatalog({ fetchResult: pack([cdp]), today: "2026-12-22", source: "cdp_bazaar" });
      await syncCatalog({ fetchResult: pack([circle]), today: "2026-12-22", source: "circle_discovery" });
      const postId = resourceId("POST", SHARED);
      const getId = resourceId("GET", SHARED);
      assert.notEqual(postId, getId);
      const aliases = await db.select().from(schema.x402ResourceAliases);
      assert.equal(aliases.some((a) => a.resourceId === postId || a.aliasId === postId), false);
      assert.equal(aliases.some((a) => a.resourceId === getId), true);
    });

    await t.test("自分の取得が不完全な日は、完全な取得の後に入った鍵を delist しない", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`);
      const kept = cdpOf("https://kept.example/a", [baseAccept]);
      const fresh = cdpOf("https://fresh-partial.example/k", [baseAccept]);
      const circleOther = circleOf("https://circle-other.example/b", [gwAccept]);
      await syncCatalog({ fetchResult: pack([kept]), today: "2027-01-01", source: "cdp_bazaar" });
      await syncCatalog({ fetchResult: pack([circleOther]), today: "2027-01-01", source: "circle_discovery" });
      await syncCatalog({
        fetchResult: pack([kept, fresh], { complete: false, total: 9 }),
        today: "2027-01-02",
        source: "cdp_bazaar",
      });
      assert.equal((await rowsFor(fresh.resourceKey))[0]?.status, "active");
      await syncCatalog({
        fetchResult: pack([kept], { complete: false, total: 9 }),
        today: "2027-01-03",
        source: "cdp_bazaar",
      });
      const row = (await rowsFor(fresh.resourceKey))[0];
      assert.equal(row?.status, "active", "3 日目の部分取得は K のページを読んでいないだけで delist しない");
      assert.equal(
        (await db.select().from(schema.x402DelistingEvents)).filter((e) => e.eventType === "delisted" && e.endpointId === row?.id).length,
        0,
      );
      const day4 = await syncCatalog({ fetchResult: pack([kept, fresh]), today: "2027-01-04", source: "cdp_bazaar" });
      assert.equal((await rowsFor(fresh.resourceKey))[0]?.status, "active");
      assert.equal(day4.events.filter((e) => e.resourceKey === fresh.resourceKey && e.eventType === "relisted").length, 0);
    });

    await t.test("兄弟の不完全な取得は、最新の完全な取得以降の鍵を不在にしない", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`);
      const cdpKept = cdpOf("https://cdp-kept.example/a", [baseAccept]);
      const circleKept = circleOf("https://circle-kept.example/b", [gwAccept]);
      const fresh = circleOf("https://circle-fresh.example/k", [gwAccept]);
      await syncCatalog({ fetchResult: pack([cdpKept]), today: "2027-02-01", source: "cdp_bazaar" });
      await syncCatalog({ fetchResult: pack([circleKept]), today: "2027-02-01", source: "circle_discovery" });
      await syncCatalog({
        fetchResult: pack([circleKept, fresh], { complete: false, total: 9 }),
        today: "2027-02-02",
        source: "circle_discovery",
      });
      await syncCatalog({
        fetchResult: pack([circleKept], { complete: false, total: 9 }),
        today: "2027-02-03",
        source: "circle_discovery",
      });
      const summary = await syncCatalog({ fetchResult: pack([cdpKept]), today: "2027-02-03", source: "cdp_bazaar" });
      assert.equal((await rowsFor(fresh.resourceKey))[0]?.status, "active");
      assert.equal(summary.events.filter((e) => e.resourceKey === fresh.resourceKey && e.eventType === "delisted").length, 0);
    });

    await t.test("持ち主の移動で resource_id が変わっても古い id が新しい行に解決され、空の quality と declared_input は残る", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_resource_aliases`);
      const { resourceId } = await import("@/lib/ids/canonical");
      const { getResource } = await import("@/lib/resolve/lookup");
      const url = "https://owner-move.example/v1/item";
      const cdp = parseCatalogItem({
        resource: url,
        description: "from cdp",
        accepts: [baseAccept],
        quality: { l30DaysTotalCalls: 42, l30DaysUniquePayers: 7, lastCalledAt: "2026-11-01T00:00:00.000Z" },
        extensions: { bazaar: { info: { input: { method: "GET", queryParams: { q: "1" }, body: { a: 1 } } } } },
      });
      const circle = circleOf(url, [gwAccept], "POST", "from circle");
      assert.equal(circle.qualityCalls30d, null);
      assert.equal(circle.declaredInput?.query, "empty");
      assert.equal(circle.declaredInput?.body, "empty");
      await syncCatalog({ fetchResult: pack([cdp]), today: "2027-03-01", source: "cdp_bazaar" });
      await syncCatalog({ fetchResult: pack([circle]), today: "2027-03-01", source: "circle_discovery" });
      const before = (await rowsFor(cdp.resourceKey))[0];
      assert.equal(before?.source, "cdp_bazaar");
      assert.equal(before?.qualityCalls30d, 42);
      const oldId = resourceId("GET", url);
      const newId = resourceId("POST", url);
      assert.equal(before?.resourceId, oldId);
      assert.notEqual(oldId, newId);
      await syncCatalog({ fetchResult: pack([cdpOf("https://other-move.example/a", [baseAccept])]), today: "2027-03-02", source: "cdp_bazaar" });
      await syncCatalog({ fetchResult: pack([circle]), today: "2027-03-02", source: "circle_discovery" });
      const after = (await rowsFor(cdp.resourceKey))[0];
      assert.equal(after?.source, "circle_discovery");
      assert.equal(after?.method, "POST");
      assert.equal(after?.resourceId, newId);
      assert.equal(after?.qualityCalls30d, 42);
      assert.equal(after?.qualityPayers30d, 7);
      assert.deepEqual(after?.declaredInput, before?.declaredInput);
      const resolved = await getResource(oldId);
      assert.equal(resolved?.resource_id, newId);
      assert.equal(resolved?.observatory_id, after?.id);
    });

    await t.test("CDP と Circle の同じ resource_key は一意で、MPP は別行のまま", async () => {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events`);
      const cdp = cdpOf(SHARED, [baseAccept]);
      await syncCatalog({ fetchResult: pack([cdp]), today: "2026-12-25", source: "cdp_bazaar" });
      await assert.rejects(
        db.execute(sql`
          INSERT INTO x402_endpoints (resource_key, resource_url, source, status)
          VALUES (${cdp.resourceKey}, ${SHARED}, 'circle_discovery', 'active')
        `),
      );
      await db.execute(sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, source, status)
        VALUES (${cdp.resourceKey}, ${SHARED}, 'mpp_directory', 'active')
      `);
      const rows = await rowsFor(cdp.resourceKey);
      assert.deepEqual(rows.map((r) => r.source).sort(), ["cdp_bazaar", "mpp_directory"]);
    });
  });
}
