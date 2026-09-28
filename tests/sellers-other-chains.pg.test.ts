// ============================================================
// /sellers/[host] の Base 以外の売り手（2026-09-29）を本物の Postgres で固定する。
//
//   - Base の出品（active）がある host → 一覧に居る（Base の頁）
//   - Base の出品が無いが購入行がある host（Arc で買った・Base の出品が外れた）→ 購入 host の集合に居て、
//     出品ごとの最新の行をチェーン名つきで返す
//   - どちらも無い host → 集合に居ない（頁は 404）
//   - 読むだけ
//
// Run: TEST_DATABASE_URL=postgres:///vet402_observatory_test_rest \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/sellers-other-chains.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("sellers other chains (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("sellers: Base あり／Base 無し・購入あり／どちらも無し", async () => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { readPurchasedHosts, readSellerBoard, readSellerDetail, readSellerOtherChains } = await import("@/lib/sellers/reader");
    const { resolveSellerPage } = await import("@/lib/sellers/board");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);

    const ARC = "eip155:5042";
    const mk = async (key: string, network: string, status = "active") => {
      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({ resourceKey: key, resourceUrl: `https://${key}`, network, method: "GET", status, priceAmount: "1000" })
        .returning();
      return ep.id;
    };
    let txSeq = 0;
    const buy = (endpointId: string, s: { status: string; http?: number | null; at: string; network: string | null; tx?: boolean }) =>
      db.insert(schema.x402L1Purchases).values({
        endpointId,
        status: s.status,
        httpStatusPaid: s.http ?? null,
        txHash: s.tx ? `0x${(++txSeq).toString(16).padStart(64, "0")}` : null,
        attemptedAt: new Date(s.at),
        network: s.network,
        spentUnits: "0",
        amountUnits: "1000",
      });

    // 1. Base の出品がある売り手
    const base = await mk("shop.example/a", "eip155:8453");
    await buy(base, { status: "settled", http: 200, tx: true, at: "2026-09-20T00:00:00Z", network: "eip155:8453" });
    // 2. Base の出品が無い売り手: Arc の出品 2 つ（片方は 2 回買った）＋ Base の出品だったが外れたもの
    const g1 = await mk("edge.goldsky.example:8443/a", ARC);
    const g2 = await mk("Edge.Goldsky.Example/b", ARC);
    const gGone = await mk("edge.goldsky.example/old", "eip155:8453", "delisted");
    await mk("edge.goldsky.example/never", ARC); // 買っていない出品は並ばない
    await buy(g1, { status: "settle_failed", http: 500, at: "2026-09-18T00:00:00Z", network: ARC });
    await buy(g1, { status: "settled", http: 200, tx: true, at: "2026-09-26T00:00:00Z", network: ARC });
    await buy(g2, { status: "no_402", at: "2026-09-22T00:00:00Z", network: null });
    await buy(gGone, { status: "settle_failed", http: 404, at: "2026-09-10T00:00:00Z", network: "eip155:8453" });
    // 3. 購入行の無い売り手（出品だけ）
    await mk("quiet.example/x", ARC);

    const before = await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases`);
    const hosts = await readPurchasedHosts(db);
    assert.deepEqual(hosts, ["edge.goldsky.example", "shop.example"], "ports and case fold; hosts without a purchase row are out");

    const other = await readSellerOtherChains(db, "edge.goldsky.example");
    assert.ok(other);
    assert.deepEqual(
      other.listings.map((l) => [l.endpointId, l.chain, l.latest.facts.attemptedAt, l.latest.bucket]),
      [
        [g1, "Arc", "2026-09-26T00:00:00Z", "delivered"],
        [g2, "Arc", "2026-09-22T00:00:00Z", other.listings[1].latest.bucket],
        [gGone, "Base", "2026-09-10T00:00:00Z", other.listings[2].latest.bucket],
      ],
      "one row per listing (the latest), newest first; a row without network takes the catalog network",
    );
    assert.equal(other.listings[1].latest.facts.status, "no_402");
    assert.equal(await readSellerOtherChains(db, "quiet.example"), null);
    assert.equal(await readSellerOtherChains(db, "goldsky.example"), null, "exact host match only");

    const load = {
      board: () => readSellerBoard(db),
      detail: (h: string) => readSellerDetail(db, h),
      purchasedHosts: () => readPurchasedHosts(db),
      otherChains: (h: string) => readSellerOtherChains(db, h),
    };
    assert.equal((await resolveSellerPage("shop.example", load)).kind, "base");
    assert.equal((await resolveSellerPage("edge.goldsky.example", load)).kind, "other_chains");
    assert.equal((await resolveSellerPage("quiet.example", load)).kind, "none");
    assert.equal((await resolveSellerPage("nobody.example", load)).kind, "none");

    const after = await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases`);
    assert.deepEqual(after, before, "read-only");
  });
}
