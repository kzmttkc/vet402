// ============================================================
// GET /api/v1/observatory/export.csv?days=365 — ハッカソン提出物向けの形の凍結（2026-11-10）。
//
// 2026-11-11 00:00 UTC 〜 2026-11-18 23:59 UTC に読み手がこの CSV を取る前提で、
// 見出し行（列名と順序）・Content-Type・認証なし・`days` クエリの扱いを
// いまの実装の値で固定する。実装は変えず試験だけ足す。
//
// 列を足す・並べ替える・名前を変えると、この file の FROZEN_* とずれて落ちる。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import { EXPORT_CSV_COLUMNS } from "@/lib/observatory/export-columns";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** 見出し行の正典（2026-11-10 時点の export-columns.ts と route の join と一致）。 */
const FROZEN_CSV_COLUMNS = [
  "attempted_at",
  "resource_key",
  "network",
  "status",
  "amount_units",
  "spent_units",
  "tx_hash",
  "http_status_paid",
  "latency_ms",
  "l2_schema",
  "held_reason",
  "request_body",
  "request_body_sha256",
  "settlement_source",
  "request_query",
  "request_query_sha256",
  "confirmed_units",
  "purchase_id",
  "l2_reading",
] as const;

const FROZEN_CSV_HEADER_LINE = FROZEN_CSV_COLUMNS.join(",");
const EXPORT_CONTENT_TYPE = "text/csv; charset=utf-8";

test("凍結: 列名と順序は 19 列・export-columns.ts の EXPORT_CSV_COLUMNS と同じ", () => {
  assert.equal(FROZEN_CSV_COLUMNS.length, 19);
  assert.deepEqual([...EXPORT_CSV_COLUMNS], [...FROZEN_CSV_COLUMNS]);
  assert.equal(FROZEN_CSV_HEADER_LINE, EXPORT_CSV_COLUMNS.join(","));
});

test("凍結: route は EXPORT_CSV_COLUMNS だけから見出し行とセル順を作る", () => {
  const route = read("src/app/api/v1/observatory/export.csv/route.ts");
  assert.match(route, /const CSV_COLUMNS = EXPORT_CSV_COLUMNS;/);
  assert.ok(route.includes('const lines = [CSV_COLUMNS.join(",")]'), "見出しは CSV_COLUMNS.join");
  assert.ok(route.includes('CSV_COLUMNS.map((c) => csvCell(out[c])).join(",")'), "データ行も同じ列順");
  assert.ok(route.includes(`"content-type": "${EXPORT_CONTENT_TYPE}"`), "成功時の Content-Type");
  assert.equal(/authorization|api[_-]?key|bearer/i.test(route), false, "ルート内で認証を要求しない");
});

test("凍結: OpenAPI は security: []（鍵なしの公開読み取り）", () => {
  const openapi = read("docs/openapi.yaml");
  const start = openapi.indexOf("operationId: exportObservatoryLedgerCsv");
  assert.ok(start >= 0, "exportObservatoryLedgerCsv");
  const slice = openapi.slice(start, start + 12_000);
  assert.match(slice, /security: \[\]/);
  assert.match(slice, /text\/csv:/);
});

test("凍結: ?days=365 は正規形（308・400 にならず DB まで届く）", async () => {
  const savedDb = process.env.DATABASE_URL;
  const savedProxy = process.env.PROXY_HEADER_SOURCE;
  delete process.env.DATABASE_URL;
  process.env.PROXY_HEADER_SOURCE = "generic";
  try {
    const { GET } = await import("@/app/api/v1/observatory/export.csv/route");
    const res = await GET(
      new NextRequest("https://vet402.com/api/v1/observatory/export.csv?days=365", {
        headers: { "x-real-ip": "203.0.113.110" },
      }),
    );
    assert.notEqual(res.status, 308, "365 は 1..366 の正規形");
    assert.notEqual(res.status, 400, "365 は invalid_days にならない");
    assert.notEqual(res.status, 401, "認証なしで 401 は返さない");
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.deepEqual(body, { error: "observatory_unavailable" });
  } finally {
    if (savedDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDb;
    if (savedProxy === undefined) delete process.env.PROXY_HEADER_SOURCE;
    else process.env.PROXY_HEADER_SOURCE = savedProxy;
  }
});

test("凍結: `days` だけが許可されたクエリ名（知らない名前は 400 invalid_query）", async () => {
  const savedDb = process.env.DATABASE_URL;
  const savedProxy = process.env.PROXY_HEADER_SOURCE;
  delete process.env.DATABASE_URL;
  process.env.PROXY_HEADER_SOURCE = "generic";
  try {
    const { GET } = await import("@/app/api/v1/observatory/export.csv/route");
    const bad = await GET(
      new NextRequest("https://vet402.com/api/v1/observatory/export.csv?days=365&cb=1", {
        headers: { "x-real-ip": "203.0.113.111" },
      }),
    );
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "invalid_query", allowed: ["days"] });
  } finally {
    if (savedDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDb;
    if (savedProxy === undefined) delete process.env.PROXY_HEADER_SOURCE;
    else process.env.PROXY_HEADER_SOURCE = savedProxy;
  }
});

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("凍結: 200 応答の見出し行と Content-Type（skipped: TEST_DATABASE_URL not set）", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("凍結: ?days=365 の 200 は text/csv で、先頭行は FROZEN_CSV_HEADER_LINE", async () => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "contract-freeze.example/api",
        resourceUrl: "https://contract-freeze.example/api",
        network: "eip155:8453",
        method: "GET",
        payTo: `0x${"8".repeat(40)}`,
      })
      .returning();
    await db.insert(schema.x402L1Purchases).values({
      endpointId: ep.id,
      status: "settled",
      httpStatusPaid: 200,
      txHash: `0x${"9".repeat(64)}`,
      attemptedAt: new Date(),
      network: "eip155:8453",
      spentUnits: "1000",
      amountUnits: "1000",
      settlementVerified: true,
    });

    const { GET } = await import("@/app/api/v1/observatory/export.csv/route");
    const res = await GET(
      new NextRequest("https://vet402.com/api/v1/observatory/export.csv?days=365", {
        headers: { "x-forwarded-for": "203.0.113.112" },
      }),
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), EXPORT_CONTENT_TYPE);
    const firstLine = (await res.text()).split("\n")[0]!;
    assert.equal(firstLine, FROZEN_CSV_HEADER_LINE);
    assert.equal(res.headers.get("x-vet402-window-days"), "365");
  });
}
