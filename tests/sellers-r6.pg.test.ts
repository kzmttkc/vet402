// ============================================================
// 2026-09-29 敵対的監査 6 周目: /sellers の読み取りの新しい 2 つの列を本物の Postgres で固定する。
//   example_input  宣言の入力（スキーマの input・raw_accepts の input・URL のクエリ）に、値の全体が例示用のドメイン
//                  （fix-modes.ts の EXAMPLE_DOMAIN_PATTERN を ~* で当てる・JS の isExampleDomainValue と同じ答え）
//   次に買う目安の材料  最新の購入行（チェーンを問わない）・settled の数・冷却（署名後の新しい 3 件）・最新の L0
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test_r6b \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/sellers-r6.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("sellers r6 reader (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("sellers r6 reader: example_input と次に買う目安の材料", async () => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { readSellerDetail } = await import("@/lib/sellers/reader");
    const { EXAMPLE_DOMAIN_PATTERN, isExampleDomainValue } = await import("@/lib/sellers/fix-modes");
    const db = getDb()!;

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);

    // JS と Postgres で同じ答え
    const samples = [
      "https://example.com",
      "example.com",
      "jane@example.com",
      "https://api.example.com/v1?x=1",
      "https://seller.example/api",
      "for example https://example.com",
      "https://example.co.uk",
      "https://myexample.com",
      "github.com",
    ];
    for (const s of samples) {
      const raw = await db.execute(sql`SELECT (${s}::text ~* ${EXAMPLE_DOMAIN_PATTERN}) AS m`);
      const rows = (Array.isArray(raw) ? raw : (raw as { rows: unknown[] }).rows) as { m: boolean }[];
      assert.equal(rows[0].m, isExampleDomainValue(s), s);
    }

    const mk = async (key: string, o: { url?: string; declaredSchema?: unknown; rawAccepts?: unknown; network?: string } = {}) => {
      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: key,
          resourceUrl: o.url ?? `https://${key}`,
          network: o.network ?? "eip155:8453",
          method: "GET",
          status: "active",
          declaredSchema: o.declaredSchema ?? null,
          rawAccepts: o.rawAccepts ?? null,
          priceAmount: "1000",
        })
        .returning();
      return ep.id;
    };
    const buy = async (endpointId: string, status: string, at: string, network: string | null = "eip155:8453") =>
      db.insert(schema.x402L1Purchases).values({
        endpointId,
        status,
        httpStatusPaid: status === "settled" ? 200 : 500,
        txHash: status === "settled" ? `0x${Math.random().toString(16).slice(2).padEnd(64, "0").slice(0, 64)}` : null,
        attemptedAt: new Date(at),
        network,
        spentUnits: "0",
        amountUnits: "1000",
      });

    const inSchema = await mk("ex.example-shop.test/a", {
      declaredSchema: { properties: { input: { properties: { body: { properties: { url: { type: "string", examples: ["https://example.com/page"] } } } } } } },
    });
    const inAccepts = await mk("ex.example-shop.test/b", {
      rawAccepts: [{ scheme: "exact", network: "eip155:8453", outputSchema: { input: { queryParams: { url: "example.com" } }, output: {} } }],
    });
    const inUrl = await mk("ex.example-shop.test/c", { url: "https://ex.example-shop.test/c?site=example.org" });
    const onlyDescription = await mk("ex.example-shop.test/d", {
      declaredSchema: { properties: { input: { properties: { body: { properties: { origin: { type: "string", description: "for example https://example.com" } } } } } } },
      rawAccepts: [{ scheme: "exact", outputSchema: { input: {}, output: { example: { url: "https://example.com/article" } } } }],
    });
    for (const id of [inSchema, inAccepts, inUrl, onlyDescription]) await buy(id, "settle_failed", "2026-09-20T12:00:00Z");

    // 次に買う目安: settled 3 件（成熟）・Solana の行が最新・L0 の最新は fail
    await buy(onlyDescription, "settled", "2026-09-01T00:00:00Z");
    await buy(onlyDescription, "settled", "2026-09-02T00:00:00Z");
    await buy(onlyDescription, "settled", "2026-09-03T00:00:00Z");
    await buy(onlyDescription, "no_eligible_accept", "2026-09-25T08:00:00Z", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
    await db.insert(schema.x402L0Probes).values([
      { endpointId: onlyDescription, probedAt: new Date("2026-09-24T00:00:00Z"), method: "GET", verdict: "pass" },
      { endpointId: onlyDescription, probedAt: new Date("2026-09-26T00:00:00Z"), method: "GET", verdict: "fail" },
    ]);
    // 冷却: 署名後の新しい 3 件が全部 決済なし（その前の settled は数えない）
    await buy(inSchema, "settled", "2026-09-01T00:00:00Z");
    await buy(inSchema, "settle_failed", "2026-09-21T12:00:00Z");
    await buy(inSchema, "request_error", "2026-09-22T12:00:00Z");

    const d = await readSellerDetail(db, "ex.example-shop.test");
    assert.ok(d);
    const byId = new Map(d.listings.map((l) => [l.endpointId, l]));
    const ex = (id: string) => byId.get(id)?.latest?.facts.exampleInput;
    assert.equal(ex(inSchema), true, "スキーマの input の見本値");
    assert.equal(ex(inAccepts), true, "raw_accepts の input の見本値");
    assert.equal(ex(inUrl), true, "URL のクエリの値");
    assert.equal(ex(onlyDescription), false, "説明文の中の言及・output の見本は当てない");
    assert.equal(byId.get(inSchema)?.latest?.mode?.key !== undefined, true);

    const nb = (id: string) => byId.get(id)?.nextBuyFacts;
    assert.deepEqual(nb(onlyDescription), {
      lastAttemptAnyAt: "2026-09-25T08:00:00Z",
      settledCount: 3,
      cooldown: false,
      latestL0Verdict: "fail",
    });
    assert.equal(nb(inSchema)?.cooldown, true);
    assert.equal(nb(inAccepts)?.cooldown, false, "署名後の行が 1 件だけなら冷却しない");
    assert.equal(nb(inAccepts)?.latestL0Verdict, null);
    assert.deepEqual(byId.get(onlyDescription)?.nextBuy, {
      kind: "window",
      notBefore: "2026-10-25 08:00 UTC",
      windowDays: 30,
      basis: "mature",
      l0: "fail",
      open: false,
    });
    assert.deepEqual(byId.get(inSchema)?.nextBuy, { kind: "cooldown" });
  });
}
