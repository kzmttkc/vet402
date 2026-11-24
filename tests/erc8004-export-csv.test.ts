// ============================================================
// export.csv の任意列 erc8004_agent（段階 B 修正版）。
// 既定は 21 列のまま。`?include=erc8004_agent` のときだけ末尾に 22 列目。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import {
  EXPORT_CSV_COLUMNS,
  EXPORT_CSV_COLUMNS_SINCE_2026_11_17,
  EXPORT_CSV_OPTIONAL_COLUMNS,
} from "@/lib/observatory/export-columns";
import { ledgerExportCsvShape } from "@/lib/observatory/export-csv-ledger-shape";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

test("既定の EXPORT_CSV_COLUMNS は 21 列・末尾は response_bytes", () => {
  assert.equal(EXPORT_CSV_COLUMNS.length, 21);
  assert.deepEqual([...EXPORT_CSV_OPTIONAL_COLUMNS], [...EXPORT_CSV_COLUMNS_SINCE_2026_11_17]);
  assert.equal(EXPORT_CSV_COLUMNS[EXPORT_CSV_COLUMNS.length - 1], "response_bytes");
  assert.equal((EXPORT_CSV_COLUMNS as readonly string[]).includes("erc8004_agent"), false);
});

test("ledgerExportCsvShape: include なしは 21 列・SQL 追記なし", () => {
  const s = ledgerExportCsvShape(false);
  assert.deepEqual([...s.columns], [...EXPORT_CSV_COLUMNS]);
  assert.equal(s.extraSelectSql, "");
});

test("ledgerExportCsvShape: include ありは 22 列・末尾 erc8004_agent", () => {
  const s = ledgerExportCsvShape(true);
  assert.equal(s.columns.length, 22);
  assert.equal(s.columns[s.columns.length - 1], "erc8004_agent");
  assert.match(s.extraSelectSql, /AS erc8004_agent/);
});

test("export route は本体に erc8004 文字列を持たない（段階 A 契約）", () => {
  const route = read("src/app/api/v1/observatory/export.csv/route.ts");
  assert.equal(route.includes("erc8004"), false);
  assert.match(route, /const CSV_COLUMNS = EXPORT_CSV_COLUMNS;/);
});

test("invalid include は 400 invalid_include", async () => {
  const savedDb = process.env.DATABASE_URL;
  const savedProxy = process.env.PROXY_HEADER_SOURCE;
  delete process.env.DATABASE_URL;
  process.env.PROXY_HEADER_SOURCE = "generic";
  try {
    const { GET } = await import("@/app/api/v1/observatory/export.csv/route");
    const res = await GET(
      new NextRequest("https://vet402.com/api/v1/observatory/export.csv?include=score", {
        headers: { "x-real-ip": "203.0.113.50" },
      }),
    );
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "invalid_include", allowed: ["erc8004_agent"] });
  } finally {
    if (savedDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDb;
    if (savedProxy === undefined) delete process.env.PROXY_HEADER_SOURCE;
    else process.env.PROXY_HEADER_SOURCE = savedProxy;
  }
});

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("?include=erc8004_agent の CSV 列（skipped: TEST_DATABASE_URL not set）", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("?include=erc8004_agent: 22 列・一致行だけ値あり", async () => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const owner = "0xabcdef0000000000000000000000000000000001";
    const other = "0xabcdef0000000000000000000000000000000003";

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases, owner_agents, agents`);
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({
        resourceKey: "erc8004-export.example/api",
        resourceUrl: "https://erc8004-export.example/api",
        network: "eip155:8453",
        method: "GET",
        payTo: owner,
      })
      .returning();
    await db.execute(sql`INSERT INTO owner_agents (owner, agent_id) VALUES (${owner}, 94639)`);
    await db.insert(schema.x402L1Purchases).values([
      {
        endpointId: ep.id,
        status: "settled",
        httpStatusPaid: 200,
        txHash: `0x${"a".repeat(64)}`,
        attemptedAt: new Date(),
        network: "eip155:8453",
        payTo: owner,
        spentUnits: "1000",
        amountUnits: "1000",
        settlementVerified: true,
      },
      {
        endpointId: ep.id,
        status: "settled",
        httpStatusPaid: 200,
        txHash: `0x${"b".repeat(64)}`,
        attemptedAt: new Date(),
        network: "eip155:8453",
        payTo: other,
        spentUnits: "1000",
        amountUnits: "1000",
        settlementVerified: true,
      },
    ]);

    const { GET } = await import("@/app/api/v1/observatory/export.csv/route");

    const base = await GET(
      new NextRequest("https://vet402.com/api/v1/observatory/export.csv?days=90", {
        headers: { "x-forwarded-for": "203.0.113.51" },
      }),
    );
    assert.equal(base.status, 200);
    const baseLines = (await base.text()).split("\n").filter((l) => l.length > 0);
    assert.equal(baseLines[0], EXPORT_CSV_COLUMNS.join(","));
    assert.equal(baseLines[0]!.split(",").length, 21);

    const ext = await GET(
      new NextRequest("https://vet402.com/api/v1/observatory/export.csv?days=90&include=erc8004_agent", {
        headers: { "x-forwarded-for": "203.0.113.52" },
      }),
    );
    assert.equal(ext.status, 200);
    const extLines = (await ext.text()).split("\n").filter((l) => l.length > 0);
    const wantHeader = [...EXPORT_CSV_COLUMNS, ...EXPORT_CSV_COLUMNS_SINCE_2026_11_17].join(",");
    assert.equal(extLines[0], wantHeader);
    assert.equal(extLines.length, 3);

    const agentIdx = wantHeader.split(",").indexOf("erc8004_agent");
    // 2 行は同じ attempted_at なので並びは決まらない。tx_hash で引く。
    const rows = extLines.slice(1).map((l) => l.split(","));
    const matched = rows.find((r) => r.includes(`0x${"a".repeat(64)}`))!;
    const unmatched = rows.find((r) => r.includes(`0x${"b".repeat(64)}`))!;
    assert.ok(matched && unmatched);
    assert.equal(matched[agentIdx], "eip155:8453:94639");
    assert.equal(unmatched[agentIdx], "");
  });
}