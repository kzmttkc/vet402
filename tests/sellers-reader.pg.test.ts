// ============================================================
// /sellers の読み取り（src/lib/sellers/reader.ts）を本物の Postgres で固定する。
//
//   - 売り手の単位: ポート違いは同じ売り手（SQL の式が census と同じ規則で畳む）
//   - Base の出品だけ（代表 network が Base・active）。他チェーンで買った行は入れない
//   - 1 出品は最新の行で数える。合計が出品数と、種類ごとの合計が失敗の数と一致する
//   - raw_response_meta と宣言から、分類に要る事実（本文の記録・本文の宣言・支払い前の HTTP・selection）を読む
//   - 読むだけ（書き込みをしない）
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_sellers_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/sellers-reader.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("sellers reader (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("sellers reader: 売り手の単位・Base の出品・最新の行・分類の事実", async () => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { readSellerBoard, readSellerDetail } = await import("@/lib/sellers/reader");
    const db = getDb()!;

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);
    const BODY_SCHEMA = { properties: { input: { properties: { body: { type: "object" } } } } };
    const mk = async (key: string, o: { network?: string; status?: string; method?: string; declaredSchema?: unknown } = {}) => {
      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: key,
          resourceUrl: `https://${key}`,
          network: o.network ?? "eip155:8453",
          method: o.method ?? "GET",
          status: o.status ?? "active",
          declaredSchema: o.declaredSchema ?? null,
          priceAmount: "1000",
        })
        .returning();
      return ep.id;
    };
    let txSeq = 0;
    const tx = () => `0x${(++txSeq).toString(16).padStart(64, "0")}`;
    const buy = async (
      endpointId: string,
      s: { status: string; http?: number | null; tx?: boolean; at: string; network?: string | null; meta?: unknown },
    ) =>
      db.insert(schema.x402L1Purchases).values({
        endpointId,
        status: s.status,
        httpStatusPaid: s.http ?? null,
        txHash: s.tx ? tx() : null,
        attemptedAt: new Date(s.at),
        network: s.network === undefined ? "eip155:8453" : s.network,
        rawResponseMeta: s.meta ?? null,
        spentUnits: "0",
        amountUnits: "1000",
      });

    // 売り手 A（ポート違いを含む 4 出品）
    const a1 = await mk("Shop.Example:4449/a", { method: "POST", declaredSchema: BODY_SCHEMA });
    const a2 = await mk("shop.example:4450/b");
    const a3 = await mk("shop.example/c");
    const a4 = await mk("shop.example/d"); // まだ買っていない
    // 売り手 A の出品だが Base でない・active でない → 入らない
    const aSol = await mk("shop.example/sol", { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });
    const aGone = await mk("shop.example/gone", { status: "delisted" });
    // 売り手 B
    const b1 = await mk("b.example/x");

    // a1: 本文を送る前の POST 422（vet402 の側）→ その後、本文を送って届いた（最新）
    await buy(a1, { status: "settle_failed", http: 422, at: "2026-09-10T00:00:00Z", meta: { phase: "paid" } });
    await buy(a1, { status: "settled", http: 200, tx: true, at: "2026-09-28T01:00:00Z", meta: { phase: "paid", requestBody: "declared", selection: "retest" } });
    // a2: 最新は Solana で買った行（入れない）→ Base の最新は残高切れの 402
    await buy(a2, { status: "settle_failed", http: 402, at: "2026-09-14T00:00:00Z" });
    await buy(a2, { status: "settled", http: 200, tx: true, at: "2026-09-20T00:00:00Z", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });
    // a3: 支払い前に 404（network なし）
    await buy(a3, { status: "no_402", at: "2026-09-27T00:00:00Z", network: null, meta: { phase: "unpaid", status: 404, selection: "census" } });
    // 入らない出品の行
    await buy(aSol, { status: "settled", http: 200, tx: true, at: "2026-09-27T00:00:00Z" });
    await buy(aGone, { status: "settled", http: 200, tx: true, at: "2026-09-27T00:00:00Z" });
    // b1: 本文を宣言していない GET の 400（seller の側）
    await buy(b1, { status: "settle_failed", http: 400, at: "2026-09-10T00:00:00Z" });

    const before = await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases`);
    const board = await readSellerBoard(db);
    const hosts = board.sellers.map((s) => s.host).sort();
    assert.deepEqual(hosts, ["b.example", "shop.example"], "ports and case fold into one seller");
    const shop = board.sellers.find((s) => s.host === "shop.example")!;
    assert.equal(shop.listings, 4, "non-Base and delisted listings are left out");
    assert.equal(shop.delivered, 1);
    assert.equal(shop.vet402, 1, "a2: payer_unfunded");
    assert.equal(shop.seller, 1, "a3: gone");
    assert.equal(shop.notBought, 1);
    assert.equal(shop.lastAttemptAt, "2026-09-28T01:00:00Z");
    assert.equal(shop.retestDue, false, "the most recent row delivered");
    const failed = board.totals.seller + board.totals.vet402 + board.totals.unsorted;
    assert.equal(board.groups.reduce((x, g) => x + g.listings, 0), failed);
    assert.deepEqual(
      board.groups.map((g) => g.key).sort(),
      ["gone", "input_rejected", "payer_unfunded"],
    );

    const d = await readSellerDetail(db, "shop.example");
    assert.ok(d);
    assert.equal(d.listings.length, 4);
    const la1 = d.listings.find((l) => l.endpointId === a1)!;
    assert.equal(la1.latest?.bucket, "delivered");
    assert.equal(la1.latest?.facts.bodyRecorded, true);
    assert.equal(la1.latest?.facts.selection, "retest");
    assert.equal(la1.earlier[0].mode?.key, "body_not_sent", "declared body + POST + no record + before the cutover");
    assert.equal(la1.earlier[0].facts.declaresBody, true);
    assert.equal(la1.deliveredAfterFailure, true);
    const la2 = d.listings.find((l) => l.endpointId === a2)!;
    assert.equal(la2.latest?.mode?.key, "payer_unfunded");
    assert.equal(la2.earlier.length, 0, "the Solana row is not a Base row");
    const la3 = d.listings.find((l) => l.endpointId === a3)!;
    assert.equal(la3.latest?.facts.unpaidStatus, 404);
    assert.equal(la3.latest?.mode?.key, "gone");
    assert.equal(la3.latest?.facts.selection, "census");
    assert.equal(d.listings.find((l) => l.endpointId === a4)!.latest, null);
    assert.equal(await readSellerDetail(db, "nobody.example"), null);
    // ホストの一致は完全一致（部分一致で他の売り手を引かない）
    assert.equal(await readSellerDetail(db, "example"), null);

    const after = await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases`);
    assert.deepEqual(after, before, "read-only");
  });

  test("vet402 の側（payer_unfunded・body_not_sent）の判定は retest の RETEST_SELLERS_SQL と同じ売り手を選ぶ", async () => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { RETEST_SELLERS_SQL } = await import("@/lib/observatory/l1-runner");
    const { readSellerBoard } = await import("@/lib/sellers/reader");
    const db = getDb()!;
    const rowsOf = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);
    const BODY = { properties: { input: { properties: { body: { type: "object" } } } } };
    let n = 0;
    let txSeq = 1000;
    // 境目の両側を 1 売り手 1 行で置く（各売り手の最新の行＝その行）。
    const cases: { method: string; body: boolean; status: string; http: number | null; tx?: boolean; at: string; meta?: unknown }[] = [
      { method: "POST", body: true, status: "settle_failed", http: 400, at: "2026-09-16T23:25:54Z" }, // (b)
      { method: "POST", body: true, status: "settle_failed", http: 422, at: "2026-09-10T00:00:00Z" }, // (b)
      { method: "POST", body: true, status: "settle_failed", http: 400, at: "2026-09-16T23:25:55Z" }, // 境界の時刻は含まない
      { method: "POST", body: true, status: "settle_failed", http: 401, at: "2026-09-10T00:00:00Z" }, // 401 は入らない
      { method: "POST", body: true, status: "settle_failed", http: 404, at: "2026-09-10T00:00:00Z" }, // 404 は入らない
      { method: "GET", body: true, status: "settle_failed", http: 400, at: "2026-09-10T00:00:00Z" }, // GET は入らない
      { method: "POST", body: false, status: "settle_failed", http: 400, at: "2026-09-10T00:00:00Z" }, // 宣言なしは入らない
      { method: "POST", body: true, status: "settle_failed", http: 400, at: "2026-09-10T00:00:00Z", meta: { requestBody: "empty" } }, // 記録ありは入らない
      { method: "POST", body: true, status: "settled", http: 400, tx: true, at: "2026-09-10T00:00:00Z" }, // 決済済みは入らない
      { method: "POST", body: true, status: "settle_failed", http: 400, tx: true, at: "2026-09-10T00:00:00Z" }, // tx ありは入らない
      { method: "GET", body: false, status: "settle_failed", http: 402, at: "2026-09-14T00:00:00Z" }, // (a) payer_unfunded
      { method: "GET", body: false, status: "settle_failed", http: 503, at: "2026-09-15T23:48:59Z" }, // (a)
      { method: "GET", body: false, status: "settle_failed", http: 402, at: "2026-09-15T23:49:00Z" }, // 期間外
    ];
    for (const c of cases) {
      n++;
      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({ resourceKey: `rt${n}.example/x`, resourceUrl: `https://rt${n}.example/x`, network: "eip155:8453", method: c.method, declaredSchema: c.body ? BODY : null, priceAmount: "1000" })
        .returning();
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id,
        status: c.status,
        httpStatusPaid: c.http,
        txHash: c.tx ? `0x${(++txSeq).toString(16).padStart(64, "0")}` : null,
        attemptedAt: new Date(c.at),
        network: "eip155:8453",
        rawResponseMeta: c.meta ?? null,
        spentUnits: "0",
        amountUnits: "1000",
      });
    }
    const retestHosts = rowsOf(await db.execute(RETEST_SELLERS_SQL)).map((r) => String(r.host)).sort();
    const board = await readSellerBoard(db);
    const oursHosts = board.sellers.filter((s) => s.retestDue).map((s) => s.host).sort();
    assert.deepEqual(oursHosts, retestHosts);
    assert.deepEqual(retestHosts, ["rt1.example", "rt11.example", "rt12.example", "rt2.example"]);
  });
}
