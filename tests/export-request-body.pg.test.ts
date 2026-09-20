// ============================================================
// 公開 export の末尾の列と、遅延回収の件数の開示（2026-09-20／2026-09-21）— 実 DB で固定する。
//
//  1. export.csv: 既存 11 列は 1 文字も変えず、末尾に request_body / request_body_sha256 /
//     settlement_source（2026-09-20）と request_query / request_query_sha256（2026-09-21）。
//     記録の無い行は空で、empty・none・refused・seller_claim に倒さない。
//  2. SQL（requestBodyKindSql・requestQueryKindSql・settlementSourceSql）と JS（requestBodyKindOf・
//     requestQueryKindOf・settlementSourceOf）が同じ台帳の同じ行に同じ値を出す。
//  3. /api/v1/observatory/state の l1.settledLateLinked は「settled かつ vet402 の索引が tx を貼った行」
//     の件数で、取り消した遅延回収・まだ settle_claimed の行を含まない。
//  4. エンドポイント頁と purchases API の読み手（getEndpointDetail / getEndpointPurchases）も
//     同じ区別を行ごとに持つ。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_export_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/export-request-body.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("export request shape (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("export.csv: 要求の形と tx の出所", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { requestBodyKindOf, requestBodySha256Of, requestBodyKindSql, requestBodySha256Sql } = await import("@/lib/observatory/request-body");
    const { requestQueryKindOf, requestQuerySha256Of, requestQueryKindSql, requestQuerySha256Sql } = await import("@/lib/observatory/request-query");
    const { settlementSourceOf, settlementSourceSql } = await import("@/lib/observatory/settlement-source");
    const { getObservatoryStats, getEndpointDetail, getEndpointPurchases } = await import("@/lib/observatory/reader");
    const db = getDb()!;
    const rowsOf = <T>(raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "shape.example/api",
        resourceUrl: "https://shape.example/api",
        network: "eip155:8453",
        method: "POST",
        payTo: `0x${"7".repeat(40)}`,
      })
      .returning();

    const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
    const SHA = "b".repeat(64);
    const QSHA = "c".repeat(64);
    const recent = (mins: number) => new Date(Date.now() - mins * 60_000);
    type Seed = { label: string; status: string; http: number | null; txHash: string | null; meta: Record<string, unknown> | null; want: [string, string, string, string, string] };
    const seeds: Seed[] = [
      { label: "declared+sha", status: "settled", http: 200, txHash: tx(1), meta: { phase: "paid", requestBody: "declared", requestBodySha256: SHA }, want: ["declared", SHA, "seller_claim", "", ""] },
      { label: "declared (hash の記録が始まる前)", status: "settled", http: 200, txHash: tx(2), meta: { phase: "paid", requestBody: "declared" }, want: ["declared", "", "seller_claim", "", ""] },
      { label: "empty", status: "settle_failed", http: 400, txHash: null, meta: { phase: "paid", requestBody: "empty" }, want: ["empty", "", "", "", ""] },
      { label: "none (GET)", status: "settled", http: 200, txHash: tx(3), meta: { phase: "paid", requestBody: "none" }, want: ["none", "", "seller_claim", "", ""] },
      { label: "記録なし（旧い行）", status: "settled", http: 200, txHash: tx(4), meta: { phase: "paid" }, want: ["", "", "seller_claim", "", ""] },
      { label: "meta そのものが無い", status: "settle_failed", http: 500, txHash: null, meta: null, want: ["", "", "", "", ""] },
      { label: "壊れた hash は出さない", status: "settled", http: 200, txHash: tx(5), meta: { requestBody: "declared", requestBodySha256: "zz" }, want: ["declared", "", "seller_claim", "", ""] },
      { label: "empty に hash が付いていても出さない", status: "settled", http: 200, txHash: tx(6), meta: { requestBody: "empty", requestBodySha256: SHA }, want: ["empty", "", "seller_claim", "", ""] },
      { label: "遅延回収 → settled", status: "settled", http: 400, txHash: tx(7), meta: { requestBody: "declared", lateSettlement: { source: "settlements_index", priorStatus: "settle_failed", txHash: tx(7) } }, want: ["declared", "", "vet402_index", "", ""] },
      { label: "遅延回収（旧い行・txHash の記録なし）→ settled", status: "settled", http: 200, txHash: tx(8), meta: { lateSettlement: { source: "settlements_index" } }, want: ["", "", "vet402_index", "", ""] },
      { label: "遅延回収・照合前（settle_claimed）", status: "settle_claimed", http: 200, txHash: tx(9), meta: { lateSettlement: { txHash: tx(9).toUpperCase().replace("0X", "0x") } }, want: ["", "", "vet402_index", "", ""] },
      { label: "取り消した遅延回収（tx なしへ戻った）", status: "settle_failed", http: 400, txHash: null, meta: { lateSettlement: { txHash: tx(10), rejectedTxHashes: [tx(10)] } }, want: ["", "", "", "", ""] },
      { label: "取り消した遅延回収（売り手の原文へ戻った）", status: "settle_claimed_unverifiable", http: 200, txHash: "not-a-tx", meta: { lateSettlement: { txHash: tx(11), replacedTxHash: "not-a-tx", rejectedTxHashes: [tx(11)] } }, want: ["", "", "seller_claim", "", ""] },
      { label: "署名前に終わった行（有料の要求なし）", status: "no_eligible_accept", http: null, txHash: null, meta: { phase: "select" }, want: ["", "", "", "", ""] },
      // 2026-09-21 request_query の 2 列。本文の列と独立に出る（本文の記録が無い行にもクエリの記録は載りうる）。
      { label: "query declared+sha", status: "settled", http: 200, txHash: tx(12), meta: { phase: "paid", requestQuery: "declared", requestQuerySha256: QSHA }, want: ["", "", "seller_claim", "declared", QSHA] },
      { label: "query declared（hash 無し）", status: "settled", http: 200, txHash: tx(13), meta: { phase: "paid", requestQuery: "declared" }, want: ["", "", "seller_claim", "declared", ""] },
      { label: "query empty（売り手が宣言していない）", status: "settle_failed", http: 400, txHash: null, meta: { phase: "paid", requestQuery: "empty", requestQuerySha256: QSHA }, want: ["", "", "", "empty", ""] },
      { label: "query refused（宣言は在ったが規則で使わなかった）", status: "settle_failed", http: 400, txHash: null, meta: { phase: "paid", requestQuery: "refused" }, want: ["", "", "", "refused", ""] },
      { label: "query 記録なし（許可リストに無い network の行）", status: "settled", http: 200, txHash: tx(14), meta: { phase: "paid", requestBody: "empty" }, want: ["empty", "", "seller_claim", "", ""] },
      { label: "query の壊れた hash は出さない", status: "settled", http: 200, txHash: tx(15), meta: { phase: "paid", requestQuery: "declared", requestQuerySha256: QSHA.toUpperCase() }, want: ["", "", "seller_claim", "declared", ""] },
      { label: "本文とクエリが両方ある行", status: "settled", http: 200, txHash: tx(16), meta: { phase: "paid", requestBody: "declared", requestBodySha256: SHA, requestQuery: "declared", requestQuerySha256: QSHA }, want: ["declared", SHA, "seller_claim", "declared", QSHA] },
    ];
    for (const [i, s] of seeds.entries()) {
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id,
        status: s.status,
        httpStatusPaid: s.http,
        txHash: s.txHash,
        attemptedAt: recent(seeds.length - i), // 挿入順 = attempted_at 昇順 = export の行順
        network: "eip155:8453",
        spentUnits: "1000",
        amountUnits: "1000",
        rawResponseMeta: s.meta,
        ...(s.status === "settled" ? { settlementVerified: true } : {}),
      });
    }
    // export に出ない行（我々の都合）
    await db.insert(schema.x402L1Purchases).values({ endpointId: ep.id, status: "budget_denied", attemptedAt: recent(1), network: "eip155:8453" });

    await t.test("export.csv: 既存 11 列はそのまま・末尾 5 列・記録の無い行は空", async () => {
      const { GET } = await import("@/app/api/v1/observatory/export.csv/route");
      const { NextRequest } = await import("next/server");
      const res = await GET(new NextRequest("https://vet402.com/api/v1/observatory/export.csv?days=30", { headers: { "x-forwarded-for": "203.0.113.41" } }));
      assert.equal(res.status, 200);
      const lines = (await res.text()).trim().split("\n");
      assert.equal(
        lines[0],
        "attempted_at,resource_key,network,status,amount_units,spent_units,tx_hash,http_status_paid,latency_ms,l2_schema,held_reason," +
          "request_body,request_body_sha256,settlement_source,request_query,request_query_sha256",
      );
      assert.equal(lines.length - 1, seeds.length, "budget_denied は出ない");
      for (const [i, s] of seeds.entries()) {
        const cells = lines[i + 1].split(",");
        assert.equal(cells.length, 16, s.label);
        assert.equal(cells[3], s.status, `${s.label}: 既存列の位置は動いていない`);
        assert.equal(cells[6], s.txHash ?? "", s.label);
        assert.deepEqual(cells.slice(11), s.want, s.label);
      }
      // 本文そのものはどの列にも出ない（出すのは分類と hash だけ）。
      assert.ok(!lines.slice(1).some((l) => l.includes("{")));
    });

    await t.test("SQL と JS が同じ行に同じ値を出す", async () => {
      const raw = await db.execute(sql`
        SELECT pu.tx_hash, pu.raw_response_meta,
               (${sql.raw(requestBodyKindSql("pu"))}) AS request_body,
               (${sql.raw(requestBodySha256Sql("pu"))}) AS request_body_sha256,
               (${sql.raw(settlementSourceSql("pu"))}) AS settlement_source,
               (${sql.raw(requestQueryKindSql("pu"))}) AS request_query,
               (${sql.raw(requestQuerySha256Sql("pu"))}) AS request_query_sha256
        FROM x402_l1_purchases pu`);
      const rows = rowsOf<{ tx_hash: string | null; raw_response_meta: unknown; request_body: string | null; request_body_sha256: string | null; settlement_source: string | null; request_query: string | null; request_query_sha256: string | null }>(raw);
      assert.equal(rows.length, seeds.length + 1);
      for (const r of rows) {
        const meta = (typeof r.raw_response_meta === "string" ? JSON.parse(r.raw_response_meta) : r.raw_response_meta) as Record<string, unknown> | null;
        assert.equal(r.request_body, requestBodyKindOf(meta));
        assert.equal(r.request_body_sha256, requestBodySha256Of(meta));
        assert.equal(r.settlement_source, settlementSourceOf({ txHash: r.tx_hash, lateSettlement: meta?.lateSettlement ?? null }));
        assert.equal(r.request_query, requestQueryKindOf(meta));
        assert.equal(r.request_query_sha256, requestQuerySha256Of(meta));
      }
    });

    await t.test("state: l1.settledLateLinked は settled かつ索引が貼った行だけ", async () => {
      const stats = await getObservatoryStats();
      assert.equal(stats.l1.settledLateLinked, 2, "settle_claimed の 1 行と、取り消した 2 行は数えない");
      assert.ok(stats.l1.settledLateLinked <= stats.l1.settled);
      assert.equal(stats.l1.settled, seeds.filter((s) => s.status === "settled").length);
    });

    await t.test("エンドポイント頁と purchases の読み手も行ごとに同じ区別を持つ", async () => {
      const detail = await getEndpointDetail(ep.id);
      const purchases = await getEndpointPurchases(ep.id);
      for (const list of [detail!.purchases, purchases!.purchases]) {
        const byTx = new Map(list.map((p) => [p.txHash, p.settlementSource]));
        assert.equal(byTx.get(tx(1)), "seller_claim");
        assert.equal(byTx.get(tx(7)), "vet402_index");
        assert.equal(byTx.get(tx(8)), "vet402_index");
        assert.equal(byTx.get("not-a-tx"), "seller_claim");
        assert.ok(list.filter((p) => p.txHash === null).every((p) => p.settlementSource === null));
        // 内部の列は公開面へ出さない（結論だけ）。
        assert.ok(list.every((p) => !("lateSettlement" in p) && !("rawResponseMeta" in p)));
      }
    });
  });
}
