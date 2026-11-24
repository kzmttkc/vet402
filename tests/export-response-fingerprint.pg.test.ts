// ============================================================
// F3: 支払い付き応答の指紋 — DB に書く経路と export.csv の末尾 2 列。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/export-response-fingerprint.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("export response fingerprint (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const payToFor = (n: string | number) => `0x${String(n).repeat(40).slice(0, 40)}`;

  test("raw_response_meta と export: responseSha256 / responseBytes", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const {
      responseBytesOf,
      responseSha256Of,
      responseBytesSql,
      responseSha256Sql,
    } = await import("@/lib/observatory/paid-response-fingerprint");
    const { EXPORT_CSV_COLUMNS } = await import("@/lib/observatory/export-columns");
    const db = getDb()!;

    const saved = { l1: process.env.OBSERVATORY_L1_ENABLED, pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY };
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    t.after(() => {
      restore("OBSERVATORY_L1_ENABLED", saved.l1);
      restore("OBSERVATORY_WALLET_PRIVATE_KEY", saved.pk);
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;

    const jaBody = JSON.stringify({ msg: "こんにちは" });
    const jaRaw = new TextEncoder().encode(jaBody);
    const jaSha = createHash("sha256").update(jaRaw).digest("hex");

    const SCHEMA = {
      properties: {
        input: { type: "http", method: "GET" },
        output: { properties: { example: { required: ["msg"], properties: { msg: { type: "string" } } } } },
      },
    };
    const item = (n: number) =>
      parseCatalogItem({
        resource: `https://fp${n}.example/api`,
        accepts: [{ amount: "3000", asset: BASE_USDC, network: "eip155:8453", payTo: payToFor(n) }],
        extensions: { bazaar: { info: { input: { method: "GET" } }, schema: SCHEMA } },
        quality: { l30DaysTotalCalls: 100, l30DaysUniquePayers: 10 },
      });
    const challengeDoc = (n: string) => ({
      x402Version: 2,
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: "3000", asset: BASE_USDC, payTo: payToFor(n), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
      resource: { url: `https://fp${n}.example/api` },
    });
    const wall402 = (n: string) =>
      new Response(JSON.stringify({ error: "payment required" }), {
        status: 402,
        headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challengeDoc(n))).toString("base64") },
      });

  let paidCount = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const n = /fp(\d)/.exec(url)?.[1] ?? "1";
      const sig = new Headers(init?.headers).get("PAYMENT-SIGNATURE") ?? new Headers(init?.headers).get("X-PAYMENT");
      if (!sig) return wall402(n);
      paidCount++;
      const body = n === "2" ? "" : n === "1" ? jaBody : '{"x":1}';
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "PAYMENT-RESPONSE": Buffer.from(
            JSON.stringify({ success: true, transaction: `0x${String(paidCount).padStart(64, "b")}`, network: "eip155:8453", payer: "0x1" }),
          ).toString("base64"),
        },
      });
    };

    const items = [item(1), item(2), item(3)];
    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
    );
    await syncCatalog({ fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true }, today: "2026-11-24" });
    await runL0ProbeBatch({ limit: 10, concurrency: 2, fetchImpl: async (url: string) => wall402(/fp(\d)/.exec(url)?.[1] ?? "1") });
    await runL1Batch({ limit: 10, fetchImpl, getPayerUsdcBalance: async () => 10_000_000n });

    type Row = { meta: Record<string, unknown> };
    const rowFor = async (n: number): Promise<Row> => {
      const raw = await db.execute(sql`
        SELECT pu.raw_response_meta AS meta FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE e.resource_url = ${`https://fp${n}.example/api`}`);
      const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Row[];
      assert.equal(rows.length, 1);
      return rows[0];
    };

    const r1 = await rowFor(1);
    assert.equal(r1.meta.responseSha256, jaSha);
    assert.equal(r1.meta.responseBytes, jaRaw.byteLength);
    assert.equal(responseSha256Of(r1.meta), jaSha);
    assert.equal(responseBytesOf(r1.meta), jaRaw.byteLength);

    const r2 = await rowFor(2);
    const emptySha = createHash("sha256").update(new Uint8Array(0)).digest("hex");
    assert.equal(r2.meta.responseSha256, emptySha);
    assert.equal(r2.meta.responseBytes, 0);

    const sqlRow = await db.execute(sql`
      SELECT e.resource_url,
             (${sql.raw(responseSha256Sql("pu"))}) AS response_sha256,
             (${sql.raw(responseBytesSql("pu"))}) AS response_bytes
      FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
      ORDER BY e.resource_url`);
    const sqlRows = (Array.isArray(sqlRow) ? sqlRow : ((sqlRow as { rows?: unknown[] }).rows ?? [])) as {
      resource_url: string;
      response_sha256: string | null;
      response_bytes: string | null;
    }[];
    assert.equal(sqlRows.find((x) => x.resource_url.endsWith("fp1.example/api"))?.response_sha256, jaSha);
    assert.equal(sqlRows.find((x) => x.resource_url.endsWith("fp2.example/api"))?.response_bytes, "0");

    const { GET } = await import("@/app/api/v1/observatory/export.csv/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest("https://vet402.com/api/v1/observatory/export.csv?days=30", { headers: { "x-forwarded-for": "203.0.113.88" } }));
    const lines = (await res.text()).trim().split("\n");
    assert.deepEqual(lines[0].split(","), [...EXPORT_CSV_COLUMNS]);
    const idxSha = EXPORT_CSV_COLUMNS.indexOf("response_sha256");
    const idxBytes = EXPORT_CSV_COLUMNS.indexOf("response_bytes");
    assert.equal(idxSha, 19);
    assert.equal(idxBytes, 20);
    const data = lines.slice(1).map((l) => l.split(","));
    assert.ok(data.some((cells) => cells[idxSha] === jaSha && cells[idxBytes] === String(jaRaw.byteLength)));
    assert.ok(data.some((cells) => cells[idxSha] === emptySha && cells[idxBytes] === "0"));
  });
}