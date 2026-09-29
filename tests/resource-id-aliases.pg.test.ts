// ============================================================
// 表記の揺れで BLOCK を素通りしない（2026-09-29 監査 7 周目・高）——本物の DB で、route まで通す。
//
//  1. catalog-sync が別名の表を埋める
//  2. SDK が生の URL から作る id（末尾スラッシュ・ホストの大文字・:443・クエリの並び）で /decision を引くと、
//     BLOCK の出品が BLOCK として返る（以前は 404 → SDK が「カタログ外」として受取人スコアで払えた）
//  3. 同じホストの隣の出品（ALLOW）へは写らない
//  4. それでも無い id の 404 は、url= のホストに掲載があれば host_known: true、無ければ false、url 無しは null。
//     error は not_found のまま（凍結中の SDK が読む語）
//
// Run: TEST_DATABASE_URL=postgres:///vet402_observatory_test_r7c \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/resource-id-aliases.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
const sdkId = (method: string, url: string) => createHash("sha256").update(`${method} ${url}`, "utf8").digest("hex");

if (!TEST_DB) {
  test("resource id aliases (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("resource id aliases end to end", async (t) => {
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { getDb } = await import("@/lib/db/client");
    const { decisionCache } = await import("@/lib/decision/cache");
    const { GET } = await import("@/app/api/v1/resources/[resourceId]/decision/route");
    const { NextRequest } = await import("next/server");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const rows = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];

    await db.execute(sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_resource_aliases, ip_rate_limits`);
    const accepts = [{ amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", network: "eip155:8453", payTo: "0x" + "22".repeat(20) }];
    const post = { extensions: { bazaar: { info: { input: { method: "POST" } } } } };
    const items = [
      parseCatalogItem({ resource: "https://api.exa.ai/search", accepts, ...post }), // BLOCK
      parseCatalogItem({ resource: "https://api.exa.ai/contents", accepts, ...post }), // ALLOW の隣
      parseCatalogItem({ resource: "https://q.example/x?a=1&b=2", accepts }), // BLOCK・クエリ
    ];
    await syncCatalog({ fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true }, today: "2026-09-29" });

    const obs = async (url: string) =>
      String(rows(await db.execute(sql`SELECT id::text AS id FROM x402_endpoints WHERE canonical_url = ${url}`))[0].id);
    const blockId = await obs("https://api.exa.ai/search");
    const allowId = await obs("https://api.exa.ai/contents");
    const queryId = await obs("https://q.example/x?a=1&b=2");
    const seed = (observatoryId: string, recommendation: string) =>
      decisionCache.set(`${observatoryId}|payer|-|0|0|0`, {
        result: { recommendation, reason_codes: recommendation === "BLOCK" ? ["l0_fail"] : ["l0_pass"], facts: {}, evidence: [], rules_version: "test", degraded: false } as never,
        expiresAt: Date.now() + 60_000,
      });

    let ip = 0;
    const call = async (rid: string, query = "") => {
      seed(blockId, "BLOCK");
      seed(allowId, "ALLOW");
      seed(queryId, "BLOCK");
      // 鍵なしの IP 枠（10/分）に掛からないよう、呼ぶたびに IP を変える
      const req = new NextRequest(`http://localhost/api/v1/resources/${rid}/decision?role=payer${query}`, {
        headers: { "x-forwarded-for": `198.51.100.${++ip}` },
      });
      const res = await GET(req, { params: Promise.resolve({ resourceId: rid }) });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    process.env.PROXY_HEADER_SOURCE = "generic";

    await t.test("catalog-sync が別名を入れる（出品ごとに 1 行以上・全部その出品の正規 id を指す）", async () => {
      const r = rows(await db.execute(sql`SELECT resource_id, count(*)::int AS n FROM x402_resource_aliases GROUP BY resource_id`));
      assert.equal(r.length, 3);
      assert.ok(r.every((x) => Number(x.n) >= 3));
    });

    const spellings: [string, string, string][] = [
      ["末尾スラッシュ", "POST", "https://api.exa.ai/search/"],
      ["ホストの大文字", "POST", "https://API.EXA.AI/search"],
      ["既定ポート :443", "POST", "https://api.exa.ai:443/search"],
      ["全部の組み合わせ", "POST", "https://API.EXA.AI:443/search/"],
      ["クエリの並び", "GET", "https://q.example/x?b=2&a=1"],
      ["クエリの並び＋末尾スラッシュ", "GET", "https://q.example/x/?b=2&a=1"],
    ];
    for (const [label, method, url] of spellings) {
      await t.test(`${label}: SDK の生の id でも BLOCK が BLOCK として返る（${method} ${url}）`, async () => {
        const r = await call(sdkId(method, url));
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.recommendation, "BLOCK");
        const subject = r.body.subject as { id?: string } | undefined;
        if (subject?.id) assert.notEqual(subject.id, sdkId(method, url), "subject は正規の id で返す");
      });
    }

    await t.test("隣の出品（ALLOW）へは写らない: /contents の揺れは ALLOW、/search の揺れは BLOCK", async () => {
      assert.equal((await call(sdkId("POST", "https://api.exa.ai/contents/"))).body.recommendation, "ALLOW");
      assert.equal((await call(sdkId("POST", "https://api.exa.ai/search/"))).body.recommendation, "BLOCK");
      // method 違いは別の資源（GET の /search は掲載されていない）
      assert.equal((await call(sdkId("GET", "https://api.exa.ai/search/"))).status, 404);
    });

    await t.test("404: url= のホストに掲載があれば host_known: true・error は not_found のまま", async () => {
      const unknown = "https://api.exa.ai/answer";
      const r = await call(sdkId("POST", unknown), `&url=${encodeURIComponent(unknown)}`);
      assert.equal(r.status, 404);
      assert.equal(r.body.error, "not_found");
      assert.equal(r.body.host_known, true);
      assert.match(String(r.body.message), /resolve/);
      // ホストの大文字でも同じホスト
      assert.equal((await call(sdkId("POST", "https://API.EXA.AI/answer"), `&url=${encodeURIComponent("https://API.EXA.AI/answer")}`)).body.host_known, true);
    });

    await t.test("404: 掲載の無いホストは host_known: false、url 無しは null（分からない）", async () => {
      const other = "https://unlisted.example/x";
      const r = await call(sdkId("GET", other), `&url=${encodeURIComponent(other)}`);
      assert.equal(r.status, 404);
      assert.equal(r.body.host_known, false);
      const bare = await call(sdkId("GET", other));
      assert.equal(bare.status, 404);
      assert.equal(bare.body.error, "not_found");
      assert.equal(bare.body.host_known, null);
    });

    await t.test("別名の表が無い DB でも止まらない（従来の 404 に落ちるだけ）", async () => {
      await db.execute(sql`ALTER TABLE x402_resource_aliases RENAME TO x402_resource_aliases_off`);
      try {
        const r = await call(sdkId("POST", "https://api.exa.ai/search/"));
        assert.equal(r.status, 404);
        assert.equal(r.body.error, "not_found");
        // 正規の id は従来どおり引ける
        const ok = await call(sdkId("POST", "https://api.exa.ai/search"));
        assert.equal(ok.body.recommendation, "BLOCK");
      } finally {
        await db.execute(sql`ALTER TABLE x402_resource_aliases_off RENAME TO x402_resource_aliases`);
      }
    });

    decisionCache.clear();
  });
}
