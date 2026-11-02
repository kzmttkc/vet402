// ============================================================
// loadSellerFacts が最後の配達を窓の外まで読む SQL と回数（2026-11-02.2・純関数は decision-l2-last-delivery.test.ts）。
//
// Run: TEST_DATABASE_URL=postgres://localhost/<test db> \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/decision-l2-last-delivery.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("decision l2 last delivery (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("loadSellerFacts: 窓の中に配達が無いときだけ 1 回読み、L2 と evidence の材料にする", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { loadSellerFacts } = await import("@/lib/decision/seller-facts");
    const { decidePayer } = await import("@/lib/decision/rules");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);

    const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
    const DECLARED = { properties: { output: { properties: { example: { required: ["id", "name"], properties: { id: {}, name: {} } } } } } };
    const l2Meta = (missing: string[], reason: string | null) => ({
      l2: { missing, declarationHash: "d", responseHash: `r${missing.length}`, reason },
      contentType: "application/json",
    });
    let seq = 0;
    const mkEndpoint = async (declaredSchema: unknown) => {
      seq++;
      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: `l2last${seq}.example/api`,
          resourceUrl: `https://l2last${seq}.example/api`,
          network: "eip155:8453",
          method: "GET",
          payTo: `0x${String(seq).repeat(40).slice(0, 40)}`,
          declaredSchema,
        })
        .returning();
      return ep.id as string;
    };
    const mkPurchase = async (
      endpointId: string,
      days: number,
      over: { status?: string; http?: number | null; l2?: string | null; meta?: unknown; tx?: string | null } = {},
    ) => {
      seq++;
      await db.insert(schema.x402L1Purchases).values({
        endpointId,
        attemptedAt: daysAgo(days),
        status: over.status ?? "settled",
        httpStatusPaid: over.http === undefined ? 200 : over.http,
        payloadNonEmpty: true,
        l2Schema: over.l2 ?? null,
        rawResponseMeta: over.meta ?? null,
        txHash: over.tx === undefined ? `0x${seq.toString(16).padStart(64, "0")}` : over.tx,
        network: "eip155:8453",
      });
    };

    const executes = t.mock.method(db, "execute");
    const load = async (id: string) => {
      const before = executes.mock.callCount();
      const loaded = await loadSellerFacts(id);
      assert.ok(loaded);
      return { loaded, calls: executes.mock.callCount() - before };
    };

    // 窓の中に配達あり（基準の読み数）。古い不一致の行は読まれない。
    const inWindow = await mkEndpoint(DECLARED);
    await mkPurchase(inWindow, 40, { l2: "mismatch", meta: l2Meta(["id"], "missing_keys") });
    await mkPurchase(inWindow, 5, { l2: "match", meta: l2Meta([], null) });
    const a = await load(inWindow);
    assert.equal(a.loaded.facts.l2.status, "conform");

    // 窓の外の配達だけ（欠けたキーあり）: 1 回だけ多く読み、BLOCK。
    const outside = await mkEndpoint(DECLARED);
    await mkPurchase(outside, 40, { l2: "mismatch", meta: l2Meta(["id", "name"], "missing_keys"), tx: `0x${"a".repeat(64)}` });
    // より古い配達は最後の配達に勝たない。
    await mkPurchase(outside, 60, { l2: "match", meta: l2Meta([], null) });
    // 配達でない新しい行（5xx）は最後の配達に数えない。窓の外。
    await mkPurchase(outside, 35, { status: "settled", http: 500 });
    const b = await load(outside);
    assert.equal(b.calls, a.calls + 1, "窓の外の配達は必要なときだけ読む");
    assert.equal(b.loaded.facts.l2.status, "mismatch");
    assert.deepEqual(b.loaded.facts.l2.missing_keys, ["id", "name"]);
    assert.ok(/T.*Z$/.test(b.loaded.facts.l2.observed_at ?? ""), "ISO 8601 UTC");
    assert.equal(b.loaded.l2ContentType, "application/json");
    assert.equal(b.loaded.l2PurchaseId, `eip155:8453:0x${"a".repeat(64)}`);
    const dec = decidePayer(b.loaded.facts, { l1NotCounted: b.loaded.l1NotCounted, l1Timeline: b.loaded.l1Timeline });
    assert.equal(dec.recommendation, "BLOCK");

    // 宣言が無い出品は読まない。
    const noDecl = await mkEndpoint(null);
    await mkPurchase(noDecl, 40, { l2: "no_declaration" });
    const c = await load(noDecl);
    assert.equal(c.calls, a.calls, "宣言が無ければ読まない");
    assert.equal(c.loaded.facts.l2.status, "undeclared");

    // 全履歴で配達が無い出品も読まない。
    const never = await mkEndpoint(DECLARED);
    await mkPurchase(never, 10, { status: "settled", http: 500 });
    const e = await load(never);
    assert.equal(e.calls, a.calls, "配達が無ければ読まない");
    assert.equal(e.loaded.facts.l2.status, "not_checked");

    // 窓の中に試行があり、配達は窓の外だけ: l1_stale（l1_never_delivered と書かない）。
    const mixed = await mkEndpoint(DECLARED);
    await mkPurchase(mixed, 45, { l2: "match", meta: l2Meta([], null) });
    await mkPurchase(mixed, 3, { status: "settled", http: 500 });
    const m = await load(mixed);
    const mDec = decidePayer(m.loaded.facts, { l1NotCounted: m.loaded.l1NotCounted, l1Timeline: m.loaded.l1Timeline });
    assert.equal(m.loaded.facts.l2.status, "conform");
    assert.ok(mDec.reason_codes.includes("l1_stale"), mDec.reason_codes.join(","));
    assert.ok(!mDec.reason_codes.includes("l1_never_delivered"), mDec.reason_codes.join(","));

    // 経路を通す: decide() と /facts の L2 の evidence は、L2 を決めた窓の外の配達を指す。L1 の evidence は窓の中の settled のまま。
    const oldTx = `0x${"b".repeat(64)}`;
    const newTx = `0x${"c".repeat(64)}`;
    const routed = await mkEndpoint(DECLARED);
    await mkPurchase(routed, 45, { l2: "mismatch", meta: l2Meta(["id"], "missing_keys"), tx: oldTx });
    await mkPurchase(routed, 3, { status: "settled", http: 500, tx: newTx });
    const { decide, invalidateDecisionCache } = await import("@/lib/decision/decide");
    invalidateDecisionCache();
    const decided = await decide({ role: "payer", observatoryId: routed, operatorBlacklist: false, skipScore: true });
    assert.ok(decided);
    assert.equal(decided.recommendation, "BLOCK");
    assert.equal(decided.evidence.find((x) => x.level === "L2")?.purchase_id, `eip155:8453:${oldTx}`);
    assert.equal(decided.evidence.find((x) => x.level === "L1")?.purchase_id, `eip155:8453:${newTx}`);
    const { GET: factsRoute } = await import("@/app/api/v1/observatory/endpoints/[id]/facts/route");
    const { NextRequest } = await import("next/server");
    const res = await factsRoute(new NextRequest(`http://localhost/api/v1/observatory/endpoints/${routed}/facts`), {
      params: Promise.resolve({ id: routed }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { evidence: { level: string; purchase_id?: string }[] };
    assert.equal(body.evidence.find((x) => x.level === "L2")?.purchase_id, `eip155:8453:${oldTx}`);

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);
  });
}
