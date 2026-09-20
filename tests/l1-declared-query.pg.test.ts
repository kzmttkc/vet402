// ============================================================
// L1 ランナー: 支払い付き要求のクエリを売り手の宣言から取る（2026-09-20）。
//
// 守ること:
//  1. フラグ OFF（既定）: 402 が queryParams を宣言していても、支払い付き要求の URL は
//     カタログの URL のまま。行の raw_response_meta に requestQuery を書かない。
//  2. フラグ ON: 宣言があれば支払い付き要求の URL にだけ足す。無払いの要求はカタログの
//     URL のまま（宣言はその 402 を読んで初めて手に入る）。行に requestQuery を残す。
//  3. 署名するもの（額・宛先・封筒の resource.url）はフラグで変わらない。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_x400_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-declared-query.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 declared query (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const payToFor = (n: string | number) => `0x${String(n).repeat(40).slice(0, 40)}`;

  test("L1 declared query", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const saved = {
      l1: process.env.OBSERVATORY_L1_ENABLED,
      pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY,
      flag: process.env.OBSERVATORY_L1_DECLARED_QUERY_ENABLED,
    };
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    t.after(() => {
      restore("OBSERVATORY_L1_ENABLED", saved.l1);
      restore("OBSERVATORY_WALLET_PRIVATE_KEY", saved.pk);
      restore("OBSERVATORY_L1_DECLARED_QUERY_ENABLED", saved.flag);
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;

    /** macropulse /api/market/is-open の 402 と同じ形の宣言（2026-09-20 実測）。 */
    const DECLARED = { exchange: "NYSE", at: "2026-12-25T14:30:00Z" };
    const item = (n: number) =>
      parseCatalogItem({
        resource: `https://seller${n}.example/api`,
        accepts: [{ amount: "3000", asset: BASE_USDC, network: "eip155:8453", payTo: payToFor(n) }],
        extensions: { bazaar: { info: { input: { method: "GET" } } } },
        quality: { l30DaysTotalCalls: 100 * n, l30DaysUniquePayers: 10 },
      });
    /** seller1 は queryParams を宣言、seller2 は宣言なし。 */
    const challengeDoc = (url: string) => {
      const n = /seller(\d)/.exec(url)?.[1] ?? "1";
      return {
        x402Version: 2,
        accepts: [{ scheme: "exact", network: "eip155:8453", amount: "3000", asset: BASE_USDC, payTo: payToFor(n), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } }],
        resource: { url: `https://seller${n}.example/api` },
        ...(n === "1" ? { extensions: { bazaar: { info: { input: { type: "http", method: "GET", queryParams: DECLARED } } } } } : {}),
      };
    };
    const wall402 = (url: string) =>
      new Response(JSON.stringify({ error: "payment required" }), {
        status: 402,
        headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(challengeDoc(url))).toString("base64") },
      });

    type Seen = { url: string; paid: boolean; envelope: Record<string, unknown> | null };
    const wall = () => {
      const seen: Seen[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const sig = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
        const envelope = sig ? (JSON.parse(Buffer.from(sig, "base64").toString("utf8")) as Record<string, unknown>) : null;
        seen.push({ url, paid: sig !== null, envelope });
        if (!sig) return wall402(url);
        // 実物の売り手と同じ: 必須のクエリが無い有料の要求は、決済せずに 400。
        if (url.includes("seller1") && !new URL(url).searchParams.has("exchange")) {
          return new Response(JSON.stringify({ error: "missing_parameter" }), { status: 400, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({ success: true, transaction: `0x${String(seen.length).padStart(64, "a")}`, network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" }),
            ).toString("base64"),
          },
        });
      };
      return { seen, fetchImpl };
    };

    async function seed() {
      const items = [item(1), item(2)];
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      await syncCatalog({ fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true }, today: "2026-09-20" });
      await runL0ProbeBatch({ limit: 10, concurrency: 2, fetchImpl: async (url: string) => wall402(url) });
    }
    const rowsFor = async (resourceUrl: string) => {
      const raw = await db.execute(sql`
        SELECT pu.status, pu.http_status_paid, pu.amount_units, pu.spent_units, pu.pay_to,
               pu.raw_response_meta->>'requestQuery' AS request_query, pu.raw_response_meta ? 'requestQuery' AS has_key
        FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE e.resource_url = ${resourceUrl}`);
      return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as {
        status: string; http_status_paid: number | null; amount_units: string; spent_units: string; pay_to: string; request_query: string | null; has_key: boolean;
      }[];
    };
    const FUNDED = async () => 10_000_000n;
    /** 封筒のうち時刻・乱数に依らない部分（何に署名したか）。 */
    const signedShape = (s: Seen) => {
      const e = s.envelope as { accepted?: unknown; resource?: unknown; payload?: { authorization?: { to?: string; value?: string } } };
      return { accepted: e.accepted, resource: e.resource, to: e.payload?.authorization?.to, value: e.payload?.authorization?.value };
    };

    let offShape: ReturnType<typeof signedShape> | null = null;

    await t.test("フラグ OFF（既定）: 宣言があっても URL はカタログのまま・行に requestQuery を書かない", async () => {
      delete process.env.OBSERVATORY_L1_DECLARED_QUERY_ENABLED;
      await seed();
      const w = wall();
      await runL1Batch({ limit: 10, fetchImpl: w.fetchImpl, getPayerUsdcBalance: FUNDED });
      assert.deepEqual(w.seen.filter((s) => s.url.includes("seller1")).map((s) => s.url), ["https://seller1.example/api", "https://seller1.example/api"]);
      const [row] = await rowsFor("https://seller1.example/api");
      assert.equal(row.status, "settle_failed");
      assert.equal(row.http_status_paid, 400);
      assert.equal(row.has_key, false);
      offShape = signedShape(w.seen.find((s) => s.url.includes("seller1") && s.paid)!);
      assert.deepEqual(
        { resource: offShape.resource, to: offShape.to, value: offShape.value },
        { resource: { url: "https://seller1.example/api" }, to: payToFor(1), value: "3000" },
        "比較の基準が空でないこと",
      );
      // "true" 以外の値は OFF。
      process.env.OBSERVATORY_L1_DECLARED_QUERY_ENABLED = "1";
      await seed();
      const w2 = wall();
      await runL1Batch({ limit: 10, fetchImpl: w2.fetchImpl, getPayerUsdcBalance: FUNDED });
      assert.ok(w2.seen.every((s) => !s.url.includes("?")));
    });

    await t.test("フラグ ON: 支払い付き要求にだけ宣言のクエリが付く。署名するものは変わらない", async () => {
      process.env.OBSERVATORY_L1_DECLARED_QUERY_ENABLED = "true";
      await seed();
      const w = wall();
      await runL1Batch({ limit: 10, fetchImpl: w.fetchImpl, getPayerUsdcBalance: FUNDED });
      const s1 = w.seen.filter((s) => s.url.includes("seller1"));
      assert.equal(s1.length, 2);
      assert.equal(s1[0].paid, false);
      assert.equal(s1[0].url, "https://seller1.example/api", "無払いの要求は宣言を読む前なのでカタログの URL");
      assert.equal(s1[1].paid, true);
      assert.equal(s1[1].url, "https://seller1.example/api?exchange=NYSE&at=2026-12-25T14%3A30%3A00Z");
      assert.deepEqual(signedShape(s1[1]), offShape, "額・宛先・封筒の resource はフラグで変わらない");

      const [row1] = await rowsFor("https://seller1.example/api");
      assert.equal(row1.status, "settle_claimed");
      assert.equal(row1.request_query, "declared");
      assert.equal(row1.amount_units, "3000");
      assert.equal(row1.spent_units, "3000");
      assert.equal(row1.pay_to, payToFor(1));

      const s2 = w.seen.filter((s) => s.url.includes("seller2"));
      assert.deepEqual(s2.map((s) => s.url), ["https://seller2.example/api", "https://seller2.example/api"], "宣言が無ければ URL はそのまま");
      const [row2] = await rowsFor("https://seller2.example/api");
      assert.equal(row2.status, "settle_claimed");
      assert.equal(row2.request_query, "empty");
    });
  });
}
