// ============================================================
// /sellers の読み取り（src/lib/sellers/reader.ts）を本物の Postgres で固定する。
//
//   - 売り手の単位: ポート違いは同じ売り手（SQL の式が census と同じ規則で畳む）
//   - Base の出品だけ（代表 network が Base・active）。他チェーンで買った行は入れない
//   - 1 出品は最新の行で数える。合計が出品数と、種類ごとの合計が失敗の数と一致する
//   - raw_response_meta と宣言から、分類に要る事実（本文の記録・本文の宣言・支払い前の HTTP・selection）を読む
//   - 読むだけ（書き込みをしない）
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_sellers_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/sellers-reader.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("sellers reader (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("sellers reader: 売り手の単位・Base の出品・最新の行・分類の事実", async () => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { readSellerBoard, readSellerDetail } = await import("@/lib/sellers/reader");
    const db = getDb()!;

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);
    const BODY_SCHEMA = { properties: { input: { properties: { body: { type: "object" } } } } };
    const mk = async (key: string, o: { network?: string; status?: string; method?: string; declaredSchema?: unknown; declaredInput?: unknown } = {}) => {
      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: key,
          resourceUrl: `https://${key}`,
          network: o.network ?? "eip155:8453",
          method: o.method ?? "GET",
          status: o.status ?? "active",
          declaredSchema: o.declaredSchema ?? null,
          declaredInput: o.declaredInput ?? null,
          priceAmount: "1000",
        })
        .returning();
      return ep.id;
    };
    let txSeq = 0;
    const tx = () => `0x${(++txSeq).toString(16).padStart(64, "0")}`;
    const buy = async (
      endpointId: string,
      s: { status: string; http?: number | null; tx?: boolean; at: string; network?: string | null; meta?: unknown },
    ) =>
      db.insert(schema.x402L1Purchases).values({
        endpointId,
        status: s.status,
        httpStatusPaid: s.http ?? null,
        txHash: s.tx ? tx() : null,
        attemptedAt: new Date(s.at),
        network: s.network === undefined ? "eip155:8453" : s.network,
        rawResponseMeta: s.meta ?? null,
        spentUnits: "0",
        amountUnits: "1000",
      });

    // 売り手 A（ポート違いを含む 4 出品）
    const a1 = await mk("Shop.Example:4449/a", { method: "POST", declaredSchema: BODY_SCHEMA });
    const a2 = await mk("shop.example:4450/b");
    const a3 = await mk("shop.example/c");
    const a4 = await mk("shop.example/d"); // まだ買っていない
    // 売り手 A の出品だが Base でない・active でない → 入らない
    const aSol = await mk("shop.example/sol", { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });
    const aGone = await mk("shop.example/gone", { status: "delisted" });
    // 売り手 B
    const b1 = await mk("b.example/x");
    // 売り手 C: クエリを宣言した Base の GET が、Base で宣言クエリを送る前に 400（こちらの側）
    const c1 = await mk("c.example/q", { declaredSchema: { properties: { input: { properties: { queryParams: { type: "object", required: ["q"] } } } } } });
    // 売り手 D: 任意のクエリだけの宣言（required なし）→ こちらの落ち度にしない。ただし課金なしの 400 なので売り手の側にも数えない
    const d1 = await mk("d.example/q", { declaredSchema: { properties: { input: { properties: { queryParams: { type: "object", properties: { q: { type: "string" } } } } } } } });
    // 売り手 E（2026-09-29 監査の site.intel.rallylive.ca の形）: スキーマの queryParams は properties: {} だが、
    // 402 の info.input.queryParams に見本値がある（declared_input.query = declared）→ こちらの側
    const e1 = await mk("e.example/site/uses/mapbox", {
      declaredSchema: { properties: { input: { properties: { queryParams: { type: "object", properties: {} } } } } },
      declaredInput: { query: "declared", body: "empty" },
    });

    // a1: 本文を送る前の POST 422（vet402 の側）→ その後、本文を送って届いた（最新）
    await buy(a1, { status: "settle_failed", http: 422, at: "2026-09-10T00:00:00Z", meta: { phase: "paid" } });
    await buy(a1, { status: "settled", http: 200, tx: true, at: "2026-09-28T01:00:00Z", meta: { phase: "paid", requestBody: "declared", selection: "retest" } });
    // a2: 最新は Solana で買った行（入れない）→ Base の最新は残高切れの 402
    await buy(a2, { status: "settle_failed", http: 402, at: "2026-09-14T00:00:00Z" });
    await buy(a2, { status: "settled", http: 200, tx: true, at: "2026-09-20T00:00:00Z", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" });
    // a3: 支払い前に 404（network なし）
    await buy(a3, { status: "no_402", at: "2026-09-27T00:00:00Z", network: null, meta: { phase: "unpaid", status: 404, selection: "census" } });
    // 入らない出品の行
    await buy(aSol, { status: "settled", http: 200, tx: true, at: "2026-09-27T00:00:00Z" });
    await buy(aGone, { status: "settled", http: 200, tx: true, at: "2026-09-27T00:00:00Z" });
    // b1: 本文を宣言していない GET の 400（seller の側）
    await buy(b1, { status: "settle_failed", http: 400, at: "2026-09-10T00:00:00Z" });

    await buy(c1, { status: "settle_failed", http: 400, at: "2026-09-25T00:00:00Z", meta: { phase: "paid", requestBody: "none" } });
    await buy(d1, { status: "settle_failed", http: 400, at: "2026-09-25T00:00:00Z", meta: { phase: "paid", requestBody: "none" } });
    await buy(e1, { status: "settle_failed", http: 400, at: "2026-09-22T00:01:36Z", meta: { phase: "paid", requestBody: "none" } });
    const before = await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases`);
    const board = await readSellerBoard(db);
    const hosts = board.sellers.map((s) => s.host).sort();
    assert.deepEqual(hosts, ["b.example", "c.example", "d.example", "e.example", "shop.example"], "ports and case fold into one seller");
    assert.equal(board.sellers.find((s) => s.host === "d.example")?.vet402, 0, "optional query only: not our fault");
    assert.equal(board.sellers.find((s) => s.host === "d.example")?.seller, 0, "an unsettled 400 took no payment: not counted against the seller");
    assert.equal(board.sellers.find((s) => s.host === "d.example")?.unsorted, 1);
    assert.equal(board.sellers.find((s) => s.host === "e.example")?.vet402, 1, "query declared by example values (declared_input), not yet sent on Base");
    assert.equal(board.sellers.find((s) => s.host === "b.example")?.seller, 0);
    assert.equal(board.sellers.find((s) => s.host === "c.example")?.vet402, 1, "query declared, not yet sent on Base");
    const shop = board.sellers.find((s) => s.host === "shop.example")!;
    assert.equal(shop.listings, 4, "non-Base and delisted listings are left out");
    assert.equal(shop.delivered, 1);
    assert.equal(shop.vet402, 1, "a2: payer_unfunded");
    assert.equal(shop.seller, 0, "a3: gone is not a purchase (vet402 did not pay)");
    assert.equal(shop.notPaid, 1, "a3");
    assert.equal(shop.notTried, 1, "a4");
    assert.equal(shop.lastAttemptAt, "2026-09-28T01:00:00Z");
    assert.equal(shop.rebuyEligible, false, "the flag is off in tests (readSellerBoard reads isCensusEnabled)");
    const failed = board.totals.seller + board.totals.vet402 + board.totals.unsorted;
    assert.equal(board.groups.reduce((x, g) => x + g.listings, 0), failed + board.totals.notPaid);
    assert.deepEqual(
      board.groups.map((g) => g.key).sort(),
      ["gone", "payer_unfunded", "query_not_sent", "refused_no_charge"],
    );

    const d = await readSellerDetail(db, "shop.example");
    assert.ok(d);
    assert.equal(d.listings.length, 4);
    const la1 = d.listings.find((l) => l.endpointId === a1)!;
    assert.equal(la1.latest?.bucket, "delivered");
    assert.equal(la1.latest?.facts.meta?.requestBody, "declared", "the kind of body sent is kept (2026-09-29: (d) reads it)");
    assert.equal(la1.latest?.facts.selection, "retest");
    assert.equal(la1.earlier[0].mode?.key, "body_not_sent", "declared body + POST + no record + before the cutover");
    assert.deepEqual(la1.earlier[0].facts.schema, { properties: { input: { properties: { body: {} } } } }, "only what the shared judge reads");
    assert.equal(la1.deliveredAfterFailure, true);
    const la2 = d.listings.find((l) => l.endpointId === a2)!;
    assert.equal(la2.latest?.mode?.key, "payer_unfunded");
    assert.equal(la2.earlier.length, 0, "the Solana row is not a Base row");
    const la3 = d.listings.find((l) => l.endpointId === a3)!;
    assert.equal(la3.latest?.facts.unpaidStatus, 404);
    assert.equal(la3.latest?.mode?.key, "gone");
    assert.equal(la3.latest?.facts.selection, "census");
    assert.equal(d.listings.find((l) => l.endpointId === a4)!.latest, null);
    assert.equal(await readSellerDetail(db, "nobody.example"), null);
    // ホストの一致は完全一致（部分一致で他の売り手を引かない）
    assert.equal(await readSellerDetail(db, "example"), null);

    const after = await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases`);
    assert.deepEqual(after, before, "read-only");
  });

  test("2026-09-29 第2巡: seller の側の根拠（(b)〜(e)）と 402 の要点を DB から読む", async () => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { readSellerBoard, readSellerDetail } = await import("@/lib/sellers/reader");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);
    const PAY = "0x2222222222222222222222222222222222222222";
    const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
    const accepts = (mts: number) => [{ scheme: "exact", network: "eip155:8453", amount: "10000", asset: USDC, payTo: PAY, maxTimeoutSeconds: mts }];
    const mk = async (key: string, o: { url?: string; mts?: number; schema?: unknown } = {}) => {
      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({
          resourceKey: key,
          resourceUrl: o.url ?? `https://${key}`,
          network: "eip155:8453",
          method: "GET",
          status: "active",
          priceAmount: "10000",
          payTo: PAY,
          rawAccepts: accepts(o.mts ?? 20),
          declaredSchema: o.schema ?? null,
        })
        .returning();
      return ep.id;
    };
    const paid = (endpointId: string, at: string, o: { http: number | null; tx?: string | null; meta?: unknown; amount?: string } ) => ({
      endpointId,
      status: o.tx ? "settled" : "settle_failed",
      httpStatusPaid: o.http,
      txHash: o.tx ?? null,
      attemptedAt: new Date(at),
      network: "eip155:8453",
      asset: USDC,
      payTo: PAY,
      payer: PAYER,
      amountUnits: o.amount ?? "10000",
      spentUnits: o.amount ?? "10000",
      rawResponseMeta: o.meta === undefined ? { phase: "paid", requestBody: "none", requestQuery: "empty" } : o.meta,
    });
    const s1 = await mk("seller.example/a"); // 根拠がそろった 500 → seller
    const s2 = await mk("seller.example/b", { mts: 300 }); // 答えが無い・宣言 300 秒 → stopped_waiting
    const s3 = await mk("seller.example/c", { schema: { properties: { input: { properties: { headers: { type: "object", required: ["X-AGENT-ID"], properties: { "X-AGENT-ID": { type: "string" } } } } } } } }); // ヘッダ → input_not_sent
    const s4 = await mk("seller.example/d"); // 関門より前・残高 0.18 で 1.0 USDC → payer_short
    const s5 = await mk("seller.example/e"); // upto だけの 402 → not bought
    const s6 = await mk("seller.example/f", { schema: { properties: { input: { properties: { headers: { type: "object", additionalProperties: { type: "string" } } } } } } }); // 名前の無いヘッダの型は宣言に数えない
    await db.insert(schema.x402L1Purchases).values([
      paid(s1, "2026-09-28T12:00:00Z", { http: 500 }),
      paid(s2, "2026-09-28T12:00:00Z", { http: null }),
      paid(s3, "2026-09-28T12:00:00Z", { http: 503 }),
      paid(s4, "2026-09-12T18:02:18Z", { http: 502, amount: "1000000", meta: { phase: "paid" } }),
      {
        endpointId: s5,
        status: "no_eligible_accept",
        attemptedAt: new Date("2026-09-28T12:00:00Z"),
        network: null,
        spentUnits: "0",
        rawResponseMeta: {
          phase: "select",
          declaredAmount: "10000",
          declaredPayTo: PAY,
          challengeAccepts: [{ scheme: "upto", network: "eip155:8453", maxAmountRequired: "1000000", asset: USDC, payTo: PAY, maxTimeoutSeconds: 300, extra: { big: "x".repeat(5000) } }],
        },
      },
      paid(s6, "2026-09-28T12:00:00Z", { http: 500 }),
      // 2026-09-29 第4巡: seller の側は別の日に 2 回以上。s1 は 09-26 にも同じ形の失敗がある（一覧は最新の行しか
      // 読まないので、この行は readSellerFailureDays が読む）。s6 は 1 回だけ → not sorted: one failure so far。
      paid(s1, "2026-09-26T12:00:00Z", { http: 502 }),
    ]);
    const board = await readSellerBoard(db);
    const sel = board.sellers.find((s) => s.host === "seller.example")!;
    assert.equal(sel.seller, 1, "s1 (two days)");
    assert.equal(sel.vet402, 1, "s4 payer_short");
    assert.equal(sel.unsorted, 3, "s2 stopped_waiting, s3 input_not_sent, s6 one failure so far");
    assert.equal(sel.notPaid, 1, "s5");
    const d = (await readSellerDetail(db, "seller.example"))!;
    const by = (id: string) => d.listings.find((l) => l.endpointId === id)!.latest!;
    assert.equal(by(s1).mode?.key, "server_error_paid");
    assert.equal(by(s1).facts.listingMaxTimeoutSeconds, 20);
    assert.equal(by(s1).facts.declaresHeaders, false);
    assert.equal(by(s1).facts.pathTemplate, false);
    assert.equal(by(s1).facts.payer, PAYER);
    assert.equal(by(s1).signed, true);
    assert.match(by(s1).seen402 ?? "", /^vet402 signed: exact · 0\.01 USDC · payTo 0x2222…2222\. Input sent: body none, query empty\./);
    assert.equal(by(s2).mode?.key, "stopped_waiting");
    assert.equal(by(s2).facts.listingMaxTimeoutSeconds, 300);
    assert.equal(by(s3).mode?.key, "input_not_sent");
    assert.equal(by(s3).facts.declaresHeaders, true);
    assert.equal(by(s4).mode?.key, "payer_short");
    assert.equal(by(s5).mode?.key, "no_accept");
    assert.equal(by(s5).signed, false);
    assert.deepEqual(by(s5).facts.challenge, [
      { scheme: "upto", network: "eip155:8453", amount: "1000000", asset: USDC, payTo: PAY, maxTimeoutSeconds: 300 },
    ]);
    assert.match(by(s5).seen402 ?? "", /^The 402 offered: upto · eip155:8453 · amount 1000000/);
    assert.equal(by(s6).mode?.key, "server_error_paid_once", "a schema for any header is not a declared header; one failure so far");
    assert.equal(by(s1).confirmedSeller, true);
    assert.equal(d.hasConfirmedSeller, true);
  });

  test("vet402 の側（payer_unfunded・body_not_sent）の判定は retest の RETEST_SELLERS_SQL と同じ売り手を選ぶ", async () => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const { RETEST_SELLERS_SQL } = await import("@/lib/observatory/l1-runner");
    const { readSellerBoard } = await import("@/lib/sellers/reader");
    const db = getDb()!;
    const rowsOf = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);
    const BODY = { properties: { input: { properties: { body: { type: "object" } } } } };
    let n = 0;
    let txSeq = 1000;
    // 境目の両側を 1 売り手 1 行で置く（各売り手の最新の行＝その行）。
    const cases: { method: string; body: boolean; status: string; http: number | null; tx?: boolean; at: string; meta?: unknown; di?: unknown }[] = [
      { method: "POST", body: true, status: "settle_failed", http: 400, at: "2026-09-16T23:25:54Z" }, // (b)
      { method: "POST", body: true, status: "settle_failed", http: 422, at: "2026-09-10T00:00:00Z" }, // (b)
      { method: "POST", body: true, status: "settle_failed", http: 400, at: "2026-09-16T23:25:55Z" }, // 境界の時刻は含まない
      { method: "POST", body: true, status: "settle_failed", http: 401, at: "2026-09-10T00:00:00Z" }, // 401 は入らない
      { method: "POST", body: true, status: "settle_failed", http: 404, at: "2026-09-10T00:00:00Z" }, // 404 は入らない
      { method: "GET", body: true, status: "settle_failed", http: 400, at: "2026-09-10T00:00:00Z" }, // GET は入らない
      { method: "POST", body: false, status: "settle_failed", http: 400, at: "2026-09-10T00:00:00Z" }, // 宣言なしは入らない
      { method: "POST", body: true, status: "settle_failed", http: 400, at: "2026-09-10T00:00:00Z", meta: { requestBody: "empty" } }, // 記録ありは入らない
      { method: "POST", body: true, status: "settled", http: 400, tx: true, at: "2026-09-10T00:00:00Z" }, // 決済済みは入らない
      { method: "POST", body: true, status: "settle_failed", http: 400, tx: true, at: "2026-09-10T00:00:00Z" }, // tx ありは入らない
      { method: "GET", body: false, status: "settle_failed", http: 402, at: "2026-09-14T00:00:00Z" }, // (a) payer_unfunded
      { method: "GET", body: false, status: "settle_failed", http: 503, at: "2026-09-15T23:48:59Z" }, // (a)
      { method: "GET", body: false, status: "settle_failed", http: 402, at: "2026-09-15T23:49:00Z" }, // 期間外
      // 2026-09-29: 送る規則と同じ情報源（declared_input）と 415
      { method: "POST", body: false, di: { query: "empty", body: "declared" }, status: "settle_failed", http: 415, at: "2026-09-10T12:07:00Z" }, // (b) rt14
      { method: "GET", body: false, di: { query: "declared", body: "empty" }, status: "settle_failed", http: 400, at: "2026-09-22T00:01:36Z" }, // (c) rt15
      { method: "GET", body: false, di: { query: "refused", body: "empty" }, status: "settle_failed", http: 400, at: "2026-09-22T00:01:36Z" }, // 使わない宣言は入らない
    ];
    for (const c of cases) {
      n++;
      const [ep] = await db
        .insert(schema.x402Endpoints)
        .values({ resourceKey: `rt${n}.example/x`, resourceUrl: `https://rt${n}.example/x`, network: "eip155:8453", method: c.method, declaredSchema: c.body ? BODY : null, declaredInput: c.di ?? null, priceAmount: "1000" })
        .returning();
      await db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id,
        status: c.status,
        httpStatusPaid: c.http,
        txHash: c.tx ? `0x${(++txSeq).toString(16).padStart(64, "0")}` : null,
        attemptedAt: new Date(c.at),
        network: "eip155:8453",
        rawResponseMeta: c.meta ?? null,
        spentUnits: "0",
        amountUnits: "1000",
      });
    }
    // Base の出品で、Base の行は残高切れ（こちらの側）だが、同じ出品のより新しい Solana の POST 400 を retest が
    // 「本文」で選ぶ売り手。頁は Base の行しか見ないので、理由が食い違う → rebuyEligible と書かない。
    const [mix] = await db
      .insert(schema.x402Endpoints)
      .values({ resourceKey: "mix.example/x", resourceUrl: "https://mix.example/x", network: "eip155:8453", method: "POST", declaredSchema: BODY, priceAmount: "1000" })
      .returning();
    await db.insert(schema.x402L1Purchases).values([
      { endpointId: mix.id, status: "settle_failed", httpStatusPaid: 402, attemptedAt: new Date("2026-09-14T00:00:00Z"), network: "eip155:8453", spentUnits: "0", amountUnits: "1000" },
      { endpointId: mix.id, status: "settle_failed", httpStatusPaid: 400, attemptedAt: new Date("2026-09-15T00:00:00Z"), network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", spentUnits: "0", amountUnits: "1000" },
    ]);
    const picked = rowsOf(await db.execute(RETEST_SELLERS_SQL));
    assert.ok(picked.some((r) => r.host === "mix.example" && r.reason === "body"), "retest picks mix.example for the Solana row");
    const retestHosts = picked.map((r) => String(r.host)).filter((h) => h !== "mix.example").sort();
    const board = await readSellerBoard(db, true);
    const queuedHosts = board.sellers.filter((s) => s.rebuyEligible).map((s) => s.host).sort();
    assert.deepEqual(queuedHosts, retestHosts, "rebuyEligible = the sellers the retest SQL picks, when the flag is on");
    assert.deepEqual(retestHosts, ["rt1.example", "rt11.example", "rt12.example", "rt14.example", "rt15.example", "rt2.example"]);
    // 旗 off: retest の SQL を流さず、誰も rebuyEligible にしない
    const off = await readSellerBoard(db, false);
    assert.equal(off.sellers.filter((s) => s.rebuyEligible).length, 0);
    // retest が選ぶ売り手は、この頁でもこちらの側（rt9 の決済済み POST 400 は retest が買い直さない。頁では下の charged_unsent_input）
    assert.equal(board.sellers.find((s) => s.host === "mix.example")?.rebuyEligible, false, "retest and this page disagree on the row");
    assert.equal(board.sellers.find((s) => s.host === "mix.example")?.vet402, 1);
    for (const h of retestHosts) assert.equal(board.sellers.find((s) => s.host === h)?.vet402, 1, h);
    // 2026-09-29 第4巡: 決済済みの POST 400（本文を送る前・本文の宣言あり）は頁では両方の事実（charged_unsent_input・not sorted）
    assert.equal(board.sellers.find((s) => s.host === "rt9.example")?.vet402, 0, "settled POST 400 before the cutover, body declared");
    assert.equal(board.sellers.find((s) => s.host === "rt9.example")?.unsorted, 1);
    assert.ok(board.groups.some((g) => g.key === "charged_unsent_input" && g.sellers.some((x) => x.host === "rt9.example")));
    assert.equal(board.sellers.find((s) => s.host === "rt9.example")?.rebuyEligible, false);
  });
}
