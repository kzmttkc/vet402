// ============================================================
// L1 ランナー: 支払い付き応答の本文の読み取り上限と L2 の記録（2026-09-29・監査 6 周目）。
//
// 守ること（台帳の行で確かめる）:
//  1. 16,000 バイトを超え上限（256 KiB）以内の JSON は読み切って L2 = match。bodyBytes に読んだバイト数。
//  2. 上限を超えた JSON は L2 = not_checked、l2.reason = body_over_cap、bodyTruncated = true、欠落キーは空。
//     支払いの記録（status・spent_units）は本文の長さで変わらない。
//  3. 最後まで読めて閉じていない JSON は売り手の不具合: mismatch（reason unparseable）。欠けたキーを作らない。
//  4. 本文を途中まで受け取って読み取りが落ちた応答は not_checked（body_read_error）。0 バイトなら従来どおり。
//     どちらも payload_non_empty は false のまま（「払ったのに届かない」に数える条件を変えない）。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test_r6g \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-paid-body-cap.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 paid body cap (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const payToFor = (n: string | number) => `0x${String(n).repeat(40).slice(0, 40)}`;

  /** 指定バイト数以上の JSON オブジェクト（count と items を持つ）。 */
  const longJson = (minBytes: number): string => {
    for (let n = Math.ceil(minBytes / 70); ; n *= 2) {
      const items = Array.from({ length: n }, (_, i) => ({ id: i, name: `asset-${i}-${"x".repeat(40)}` }));
      const s = JSON.stringify({ count: n, items });
      if (Buffer.byteLength(s, "utf8") >= minBytes) return s;
    }
  };

  test("L1 paid body cap", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { L1_PAID_BODY_CAP_BYTES } = await import("@/lib/observatory/l2-check");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const saved = { l1: process.env.OBSERVATORY_L1_ENABLED, pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY };
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    t.after(() => {
      restore("OBSERVATORY_L1_ENABLED", saved.l1);
      restore("OBSERVATORY_WALLET_PRIVATE_KEY", saved.pk);
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;

    const SCHEMA = {
      properties: {
        input: { type: "http", method: "GET" },
        output: { properties: { example: { required: ["count", "items"], properties: { count: { type: "number" }, items: { type: "array" } } } } },
      },
    };
    const item = (n: number) =>
      parseCatalogItem({
        resource: `https://seller${n}.example/api`,
        accepts: [{ amount: "3000", asset: BASE_USDC, network: "eip155:8453", payTo: payToFor(n) }],
        extensions: { bazaar: { info: { input: { method: "GET" } }, schema: SCHEMA } },
        quality: { l30DaysTotalCalls: 100 * n, l30DaysUniquePayers: 10 },
      });
    const challengeDoc = (n: string) => ({
      x402Version: 2,
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: "3000", asset: BASE_USDC, payTo: payToFor(n), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
      resource: { url: `https://seller${n}.example/api` },
    });
    const wall402 = (n: string) =>
      new Response(JSON.stringify({ error: "payment required" }), {
        status: 402,
        headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challengeDoc(n))).toString("base64") },
      });
    /** seller1 = 40 KB の JSON、seller2 = 上限を超える JSON、seller3 = 上限の内側で閉じない JSON。 */
    const BODIES: Record<string, string> = {
      "1": longJson(40_000),
      "2": longJson(L1_PAID_BODY_CAP_BYTES + 10_000),
      "3": '{"count": 3, "items": [1, 2',
    };
    /** seller4 = 途中まで送って切れる本文、seller5 = 1 バイトも送らずに切れる本文。 */
    const failingStream = (chunk: string) => {
      let sent = false;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent && chunk !== "") {
            sent = true;
            controller.enqueue(new TextEncoder().encode(chunk));
            return;
          }
          controller.error(new Error("socket hang up"));
        },
      });
    };
    let paidCount = 0;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      const n = /seller(\d)/.exec(url)?.[1] ?? "1";
      const headers = new Headers(init?.headers);
      const sig = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
      if (!sig) return wall402(n);
      paidCount++;
      const body = n === "4" ? failingStream('{"count": 1, "items": [') : n === "5" ? failingStream("") : BODIES[n];
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "PAYMENT-RESPONSE": Buffer.from(
            JSON.stringify({ success: true, transaction: `0x${String(paidCount).padStart(64, "b")}`, network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" }),
          ).toString("base64"),
        },
      });
    };

    const items = [item(1), item(2), item(3), item(4), item(5)];
    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
    );
    await syncCatalog({ fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true }, today: "2026-09-29" });
    await runL0ProbeBatch({ limit: 10, concurrency: 2, fetchImpl: async (url: string) => wall402(/seller(\d)/.exec(url)?.[1] ?? "1") });
    await runL1Batch({ limit: 10, fetchImpl, getPayerUsdcBalance: async () => 10_000_000n });

    type Row = { status: string; spent_units: string; l2_schema: string | null; meta: Record<string, unknown> };
    const rowFor = async (n: number): Promise<Row> => {
      const raw = await db.execute(sql`
        SELECT pu.status, pu.spent_units, pu.l2_schema, pu.raw_response_meta AS meta
        FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE e.resource_url = ${`https://seller${n}.example/api`}`);
      const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Row[];
      assert.equal(rows.length, 1, `seller${n} は 1 行`);
      return rows[0];
    };

    await t.test("16,000 バイトを超え上限以内の JSON は読み切って match", async () => {
      const r = await rowFor(1);
      assert.equal(r.status, "settle_claimed");
      assert.equal(r.l2_schema, "match");
      assert.equal(r.meta.bodyBytes, Buffer.byteLength(BODIES["1"], "utf8"));
      assert.ok((r.meta.bodyBytes as number) > 16_000);
      assert.equal(r.meta.bodyCapBytes, L1_PAID_BODY_CAP_BYTES);
      assert.equal("bodyTruncated" in r.meta, false);
    });

    await t.test("上限を超えた JSON は not_checked（body_over_cap）。切ったことが記録に残る。支払いの記録は変わらない", async () => {
      const r = await rowFor(2);
      assert.equal(r.status, "settle_claimed");
      assert.equal(r.spent_units, "3000");
      assert.equal(r.l2_schema, "not_checked");
      assert.equal(r.meta.bodyTruncated, true);
      assert.equal(r.meta.bodyBytes, L1_PAID_BODY_CAP_BYTES);
      const l2 = r.meta.l2 as { reason: string; missing: string[] };
      assert.equal(l2.reason, "body_over_cap");
      assert.deepEqual(l2.missing, []);
      assert.equal(typeof r.meta.bodyHead, "string");
      assert.equal((r.meta.bodyHead as string).length, 500);
    });

    await t.test("最後まで読めて閉じていない JSON は mismatch（unparseable）。欠けたキーを作らない", async () => {
      const r = await rowFor(3);
      assert.equal(r.l2_schema, "mismatch");
      const l2 = r.meta.l2 as { reason: string; missing: string[] };
      assert.equal(l2.reason, "unparseable");
      assert.deepEqual(l2.missing, []);
      assert.equal("bodyTruncated" in r.meta, false);
    });

    await t.test("途中まで受け取って切れた本文は not_checked（body_read_error）。0 バイトなら従来どおり。中身は届いていない扱いのまま", async () => {
      const partial = await rowFor(4);
      assert.equal(partial.status, "settle_claimed", "決済の記録は本文の読み取りで変わらない");
      assert.equal(partial.l2_schema, "not_checked");
      assert.equal((partial.meta.l2 as { reason: string }).reason, "body_read_error");
      assert.equal(partial.meta.bodyBytes, Buffer.byteLength('{"count": 1, "items": [', "utf8"));
      assert.equal(typeof partial.meta.bodyError, "string");
      const empty = await rowFor(5);
      assert.equal(empty.l2_schema, "mismatch", "0 バイトは従来どおり空の本文として判定");
      assert.equal(empty.meta.bodyBytes, 0);
      const raw = await db.execute(sql`
        SELECT e.resource_url, pu.payload_non_empty FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE e.resource_url IN ('https://seller4.example/api', 'https://seller5.example/api')`);
      const rows = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { payload_non_empty: boolean }[];
      assert.equal(rows.length, 2);
      assert.ok(rows.every((x) => x.payload_non_empty === false), "読み取りが落ちた本文は届いていない扱い（従来どおり）");
    });
  });
}
