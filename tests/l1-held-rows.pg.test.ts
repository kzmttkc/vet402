// ============================================================
// 保留の分類（Issue #29）— 同じ台帳を JS と SQL の両方から数えて一致させる。
//
// 正典は delivery.ts（heldReasonOf / heldReasonSql）。公開面は 4 つの入口で数える:
//   seller-facts（/decision の facts.l1）・/purchases（countPaidAttempts）・
//   /observatory/state（getObservatoryStats）・export.csv の held_reason 列。
// どれかが別の述語を持つと、同じ売り手が面ごとに違う数で出る。ここで固定する。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_prep_0917 \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-held-rows.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 held rows parity (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("L1 held rows: JS と SQL と公開面が同じ行を選ぶ", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { heldReasonOf, heldReasonSql, inconclusivePredicate } = await import("@/lib/observatory/delivery");
    const { assembleSellerFacts, loadSellerFacts } = await import("@/lib/decision/seller-facts");
    const { decidePayer } = await import("@/lib/decision/rules");
    const { getEndpointPurchases, getObservatoryStats } = await import("@/lib/observatory/reader");
    const { computeHistoryFlags } = await import("@/lib/scoring/history-flags");
    const db = getDb()!;
    const rowsOf = <T>(raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);
    const mkEndpoint = async (n: number) => {
      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: `held${n}.example/api`,
          resourceUrl: `https://held${n}.example/api`,
          network: "eip155:8453",
          method: "POST",
          payTo: `0x${String(n).repeat(40).slice(0, 40)}`,
        })
        .returning();
      return ep;
    };
    let txSeq = 0;
    const tx = () => `0x${(++txSeq).toString(16).padStart(64, "0")}`;
    type Seed = { status: string; http: number | null; tx?: boolean; at: string; network?: string };
    const insert = async (endpointId: string, s: Seed) =>
      db.insert(schema.x402L1Purchases).values({
        endpointId,
        status: s.status,
        httpStatusPaid: s.http,
        txHash: s.tx ? tx() : null,
        attemptedAt: new Date(s.at),
        network: s.network ?? "eip155:8453",
        spentUnits: "1000",
        amountUnits: "1000",
      });

    // 台帳: 境界の全種を 1 つの endpoint に置く（別の endpoint にも数件置き、集計の混線を見る）。
    const mixed = await mkEndpoint(1);
    const other = await mkEndpoint(2);
    const seeds: Seed[] = [
      { status: "settled", http: 200, tx: true, at: "2026-09-10T00:00:00Z" }, // 配達
      { status: "settled", http: 422, tx: true, at: "2026-09-10T01:00:00Z" }, // settled_4xx
      { status: "settled", http: 502, tx: true, at: "2026-09-10T02:00:00Z" }, // 数える
      { status: "settle_failed", http: 400, at: "2026-09-12T06:01:26Z" }, // unsettled_4xx（Douglas 型）
      { status: "settle_failed", http: 401, at: "2026-09-11T00:00:00Z" }, // unsettled_4xx
      { status: "settle_failed", http: 400, tx: true, at: "2026-09-11T01:00:00Z" }, // tx あり → 数える
      { status: "settle_failed", http: 503, at: "2026-09-11T02:00:00Z" }, // 5xx → 数える
      { status: "settle_failed", http: 402, at: "2026-09-10T03:00:00Z" }, // 期間外 402 → 数える
      { status: "settle_failed", http: 402, at: "2026-09-13T00:00:00Z" }, // payer_unfunded（開始含む）
      { status: "settle_failed", http: 402, at: "2026-09-15T23:48:59Z" }, // payer_unfunded
      { status: "settle_failed", http: 402, at: "2026-09-15T23:49:00Z" }, // 終了は含まない → 数える
      { status: "settle_failed", http: 402, at: "2026-09-14T00:00:00Z", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, // Solana → 数える
      { status: "settle_failed", http: 500, at: "2026-09-14T01:00:00Z" }, // 期間内 5xx → payer_unfunded
      { status: "settle_failed", http: 503, at: "2026-09-14T02:00:00Z", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }, // Solana の期間内 5xx → 数える
      { status: "settle_claimed", http: 400, tx: true, at: "2026-09-16T00:00:00Z" }, // 対象外
      { status: "budget_denied", http: null, at: "2026-09-16T01:00:00Z" }, // 署名前 → 分母外
    ];
    for (const s of seeds) await insert(mixed.id, s);
    for (const s of [
      { status: "settle_failed", http: 422, at: "2026-09-09T00:00:00Z" },
      { status: "settle_failed", http: 402, at: "2026-09-14T12:00:00Z" },
    ] as Seed[])
      await insert(other.id, s);

    const PAID = ["settled", "settle_failed", "delivered_no_receipt", "settle_claimed_unverifiable", "settle_claimed", "settle_claim_refuted"];
    const ledger = rowsOf<{ endpoint_id: string; status: string; http_status_paid: number | null; tx_hash: string | null; attempted_at: string; network: string | null; sql_reason: string | null }>(
      await db.execute(sql`
        SELECT endpoint_id::text AS endpoint_id, status, http_status_paid, tx_hash, attempted_at::text AS attempted_at, network,
               (${sql.raw(heldReasonSql())}) AS sql_reason
        FROM x402_l1_purchases`),
    );

    await t.test("行ごとに JS の理由と SQL の理由が一致する", () => {
      for (const r of ledger) {
        const js = heldReasonOf({ status: r.status, httpStatusPaid: r.http_status_paid, txHash: r.tx_hash, attemptedAt: r.attempted_at, network: r.network });
        assert.equal(r.sql_reason, js, `${r.status}/${r.http_status_paid}/${r.attempted_at}/${r.network}`);
      }
      const reasons = ledger.filter((r) => r.endpoint_id === mixed.id).map((r) => r.sql_reason).filter(Boolean).sort();
      assert.deepEqual(reasons, ["payer_unfunded", "payer_unfunded", "payer_unfunded", "settled_4xx", "unsettled_4xx", "unsettled_4xx"]);
    });

    const jsHeld = (endpointId?: string) =>
      ledger.filter(
        (r) =>
          (!endpointId || r.endpoint_id === endpointId) &&
          PAID.includes(r.status) &&
          heldReasonOf({ status: r.status, httpStatusPaid: r.http_status_paid, txHash: r.tx_hash, attemptedAt: r.attempted_at, network: r.network }) !== null,
      ).length;

    await t.test("seller-facts（同じ台帳の行）・/purchases・SQL 述語が同じ件数", async () => {
      const facts = assembleSellerFacts({
        probes: [],
        purchases: ledger
          .filter((r) => r.endpoint_id === mixed.id)
          .map((r) => ({
            attemptedAt: r.attempted_at,
            status: r.status,
            latencyMs: 100,
            httpStatusPaid: r.http_status_paid,
            payloadNonEmpty: true,
            l2Schema: null,
            txHash: r.tx_hash,
            network: r.network,
          })),
        settlements30d: { raw: 0, real: 0, test: 0, uniquePayersReal: 0 },
        payees: [],
        declaredSchema: null,
        lastAttemptAt: null,
      });
      const purchases = await getEndpointPurchases(mixed.id);
      const sqlCount = rowsOf<{ n: number }>(
        await db.execute(sql`
          SELECT count(*)::int AS n FROM x402_l1_purchases
          WHERE endpoint_id = ${mixed.id}::uuid AND status IN ${sql.raw(`(${PAID.map((s) => `'${s}'`).join(", ")})`)}
            AND ${sql.raw(inconclusivePredicate())}`),
      )[0].n;
      assert.equal(jsHeld(mixed.id), 6);
      assert.equal(facts.l1.n_inconclusive, 6);
      assert.equal(purchases!.inconclusiveCount, 6);
      assert.equal(sqlCount, 6);
      assert.equal(facts.l1.n_attempts, purchases!.attemptCount);
      assert.equal(facts.l1.n_settled, purchases!.settledCount);
      assert.equal(facts.l1.n_delivered, purchases!.deliveredCount);
      assert.deepEqual(purchases!.inconclusiveByReason, { settled4xx: 1, unsettled4xx: 2, payerUnfunded: 3 });
      assert.equal(purchases!.inconclusiveSettledCount, 1);
      // delivered 1 / (settled 3 − settled の保留 1)
      assert.equal(purchases!.deliveryRatePct, 50);
    });

    await t.test("/observatory/state の l1 集計も同じ件数（理由別の和 = inconclusive）", async () => {
      const stats = await getObservatoryStats();
      assert.equal(stats.l1.inconclusive, jsHeld());
      assert.equal(stats.l1.inconclusive, 8);
      assert.deepEqual(stats.l1.inconclusiveByReason, { settled4xx: 1, unsettled4xx: 3, payerUnfunded: 4 });
      assert.equal(stats.l1.inconclusiveSettled, 1);
      const byChainSum = stats.l1.byChain.reduce((a, c) => a + c.inconclusive, 0);
      assert.equal(byChainSum, stats.l1.inconclusive);
    });

    await t.test("export.csv の末尾 held_reason 列も同じ行を選び、既存 10 列の形は変えない", async () => {
      const { GET } = await import("@/app/api/v1/observatory/export.csv/route");
      const { NextRequest } = await import("next/server");
      const res = await GET(new NextRequest("https://vet402.com/api/v1/observatory/export.csv?days=366", { headers: { "x-forwarded-for": "203.0.113.29" } }));
      assert.equal(res.status, 200);
      const lines = (await res.text()).trim().split("\n");
      assert.equal(
        lines[0],
        "attempted_at,resource_key,network,status,amount_units,spent_units,tx_hash,http_status_paid,latency_ms,l2_schema,held_reason",
      );
      const held = lines.slice(1).filter((l) => /,(settled_4xx|unsettled_4xx|payer_unfunded)$/.test(l));
      // export は budget_denied を含まない。保留は全部 PAID の行なので jsHeld() と同じ数。
      assert.equal(held.length, jsHeld());
    });

    await t.test("資金切れ期間の 402 だけで『納品 0・署名 3』になった相手は BLOCK にならない／期間外の 402 は従来どおり数える", async () => {
      // loadSellerFacts は直近 30 日の窓で読む。期間の日付は固定なので、日付が窓の外へ出た
      // あとは C のケースを assembleSellerFacts に同じ台帳の行を渡して読む（上のテストと同じ入口）。
      const unfunded = await mkEndpoint(3);
      const outside = await mkEndpoint(4);
      for (const at of ["2026-09-13T06:00:00Z", "2026-09-14T06:00:00Z", "2026-09-15T06:00:00Z"]) {
        await insert(unfunded.id, { status: "settle_failed", http: 402, at });
      }
      const recent = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
      for (const at of [recent(1), recent(2), recent(3)]) {
        await insert(outside.id, { status: "settle_failed", http: 402, at });
      }
      const probe = async (endpointId: string) => {
        for (const h of [1, 2]) {
          await db.insert(schema.x402L0Probes).values({ endpointId, method: "POST", verdict: "pass", probedAt: new Date(Date.now() - h * 3600_000) });
        }
      };
      await probe(unfunded.id);
      await probe(outside.id);

      const loadedOutside = await loadSellerFacts(outside.id);
      assert.deepEqual([loadedOutside!.facts.l1.n_attempts, loadedOutside!.facts.l1.n_inconclusive], [3, 0]);
      assert.equal(decidePayer(loadedOutside!.facts).recommendation, "BLOCK", "期間外の 402 は売り手の記録として数える");

      const rows = rowsOf<{ status: string; http_status_paid: number; tx_hash: string | null; attempted_at: string; network: string }>(
        await db.execute(sql`SELECT status, http_status_paid, tx_hash, attempted_at::text AS attempted_at, network
                             FROM x402_l1_purchases WHERE endpoint_id = ${unfunded.id}::uuid ORDER BY attempted_at DESC`),
      );
      const loadedUnfunded = await loadSellerFacts(unfunded.id);
      const factsUnfunded = assembleSellerFacts({
        probes: [
          { probedAt: new Date().toISOString(), verdict: "pass", dialect: "v2", failReason: null, priceAmount: "declared", priceAsset: null, payTo: "declared" },
          { probedAt: new Date().toISOString(), verdict: "pass", dialect: "v2", failReason: null, priceAmount: "declared", priceAsset: null, payTo: "declared" },
        ],
        purchases: rows.map((r) => ({ attemptedAt: r.attempted_at, status: r.status, latencyMs: 1, httpStatusPaid: r.http_status_paid, payloadNonEmpty: false, l2Schema: null, txHash: r.tx_hash, network: r.network })),
        settlements30d: { raw: 0, real: 0, test: 0, uniquePayersReal: 0 },
        payees: [],
        declaredSchema: null,
        lastAttemptAt: null,
      });
      assert.equal(loadedUnfunded!.facts.l0.status, "pass");
      assert.deepEqual([factsUnfunded.l1.n_attempts, factsUnfunded.l1.n_inconclusive, factsUnfunded.l1.n_delivered], [3, 3, 0]);
      const d = decidePayer(factsUnfunded);
      assert.equal(d.recommendation, "WARN");
      assert.ok(d.reason_codes.includes("l1_inconclusive"));
      // 窓の内側にある間は loadSellerFacts も同じ答え（2026-10-13 以降は窓の外で 0 件になる）。
      if (Date.now() < Date.parse("2026-10-13T00:00:00Z")) {
        assert.deepEqual([loadedUnfunded!.facts.l1.n_attempts, loadedUnfunded!.facts.l1.n_inconclusive], [3, 3]);
        assert.equal(decidePayer(loadedUnfunded!.facts).recommendation, "WARN");
      }

      const purchasesUnfunded = await getEndpointPurchases(unfunded.id);
      assert.equal(purchasesUnfunded!.inconclusiveCount, 3);
      assert.deepEqual(purchasesUnfunded!.inconclusiveByReason, { settled4xx: 0, unsettled4xx: 0, payerUnfunded: 3 });
    });

    await t.test("history-flags: 保留の settle_failed だけでは repeatSettleFailureNoSuccess を立てない", async () => {
      const unfundedFlags = await computeHistoryFlags(`0x${"3".repeat(40)}`);
      assert.equal(unfundedFlags!.flags.repeatSettleFailureNoSuccess, false);
      const outsideFlags = await computeHistoryFlags(`0x${"4".repeat(40)}`);
      assert.equal(outsideFlags!.flags.repeatSettleFailureNoSuccess, true);
    });
  });
}
