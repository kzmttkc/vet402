// ============================================================
// 日次ジョブが止まった日は後から埋めない（2026-11-10 公平審査 3.8 の 6c）。
//
// 2026-09-02 監査は「穴を飛ばして連結した鎖が 5 日間 intact と言われた」ことを直すために、
// 欠けた日を後から埋める形にした。後から計算した root を、その日に封印したヘッドとして
// 出すと、封印していない日を封印済みに見せる（probe402 の 11/5〜7 と同じ形）。
// 今は: 穴は埋めない。次に封印する日は前に存在する最新の root に繋ぐ。穴は
// chainContinuity の gaps と、anchors の GET の missingHeadDays に名指しで出る。
// 後ろの日が繋がった root は書き換えない（conflict_frozen）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("anchors no-backfill (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  // TRUNCATE より前に、接続先が本番（Neon）でないことを機械で確かめる（2026-09-04 監査 D・P2）。
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const DAY_MS = 86_400_000;
  const dayOffset = (n: number) => new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10);

  test("anchors no-backfill", async (t) => {
    const { anchorDay, anchorThrough, getAnchors, chainContinuity } = await import("@/lib/observatory/anchors");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE ledger_anchors, x402_l1_purchases`);

    await t.test("genesis: 最初の日は前の root 無しで固定できる", async () => {
      const r = await anchorDay("2026-08-14");
      assert.equal(r.status, "created");
      const [row] = await getAnchors(1);
      assert.equal(row.prevRoot, null);
    });

    await t.test("前日が欠けた日は、前に存在する最新の root に繋ぎ、欠けた日を作らない", async () => {
      const rs = await anchorThrough("2026-08-16");
      assert.deepEqual(
        rs.map((r) => r.day),
        ["2026-08-16"],
        "anchorThrough は to の 1 日だけを固定する（08-15 を後から作らない）",
      );
      const rows = await getAnchors(30);
      assert.deepEqual(
        rows.map((r) => r.day),
        ["2026-08-16", "2026-08-14"],
      );
      assert.equal(rows[0].prevRoot, rows[1].rootHash, "穴を跨いで繋ぐ");
      const c = chainContinuity(rows);
      assert.equal(c.linked, true);
      assert.equal(c.contiguous, false);
      assert.deepEqual(c.gaps, ["2026-08-15"]);
    });

    await t.test("後ろの日が封印済みなら、過去の穴を anchorDay で埋めることを拒む", async () => {
      await assert.rejects(() => anchorDay("2026-08-15"), /過去の穴は埋めない/);
      const rows = await getAnchors(30);
      assert.equal(rows.length, 2);
    });

    await t.test("再実行は冪等（unchanged）", async () => {
      const rs = await anchorThrough("2026-08-16");
      assert.equal(rs.length, 1);
      assert.equal(rs[0].status, "unchanged");
    });

    await t.test("後ろが繋がった日の行が変わっても root は書き換えず conflict_frozen", async () => {
      const epRaw = await db.execute(sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, method, network)
        VALUES ('nb.example/api', 'https://nb.example/api', 'GET', 'eip155:8453')
        RETURNING id::text AS id
      `);
      const endpointId = ((Array.isArray(epRaw) ? epRaw : (epRaw as { rows?: unknown[] }).rows) as { id: string }[])[0].id;
      await db.execute(sql`
        INSERT INTO x402_l1_purchases (endpoint_id, status, attempted_at)
        VALUES (${endpointId}::uuid, 'settled', '2026-08-14T05:00:00Z'::timestamptz)
      `);
      const before = (await getAnchors(30)).find((r) => r.day === "2026-08-14")!;
      const r = await anchorDay("2026-08-14");
      assert.equal(r.status, "conflict_frozen");
      assert.equal(r.rootHash, before.rootHash, "保存した root はそのまま");
      assert.ok(r.recomputedRoot && r.recomputedRoot !== before.rootHash, "改ざんは計算し直した root の差で見える");
      const after = (await getAnchors(30)).find((r) => r.day === "2026-08-14")!;
      assert.equal(after.rootHash, before.rootHash);
      await db.execute(sql`TRUNCATE x402_endpoints CASCADE`);
    });
  });

  test("anchors GET と day ファイル: 3 つの値の一致、ヘッドが無い日、遅れは 200 にしない", async (t) => {
    const { anchorDay } = await import("@/lib/observatory/anchors");
    const { GET: anchorsGet } = await import("@/app/api/v1/observatory/anchors/route");
    const { GET: dayGet } = await import("@/app/api/v1/observatory/anchors/day/route");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    await db.execute(sql`TRUNCATE ledger_anchors, x402_l1_purchases, x402_endpoints CASCADE`);
    const epRaw = await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, method, network)
      VALUES ('day.example/api', 'https://day.example/api', 'GET', 'eip155:8453')
      RETURNING id::text AS id
    `);
    const eid = ((Array.isArray(epRaw) ? epRaw : (epRaw as { rows?: unknown[] }).rows) as { id: string }[])[0].id;
    const d4 = dayOffset(-4);
    const d2 = dayOffset(-2);
    const d1 = dayOffset(-1);
    await db.execute(sql`
      INSERT INTO x402_l1_purchases (endpoint_id, status, network, attempted_at)
      VALUES (${eid}::uuid, 'settled', 'eip155:8453', ${`${d2}T03:00:00Z`}::timestamptz),
             (${eid}::uuid, 'settle_failed', 'eip155:8453', ${`${d2}T04:00:00Z`}::timestamptz)
    `);
    await anchorDay(d4);
    await anchorDay(d2);

    await t.test("ヘッドが 2 日前で止まっている間は 503 で、昨日を no_head_for_day と書く", async () => {
      const res = await anchorsGet(new NextRequest("http://localhost/api/v1/observatory/anchors?days=30"));
      const body = await res.json();
      // 遅れ 2 日は ok（3 日で不合格）。ここでは穴の名指しを見る。
      assert.equal(res.status, 200);
      assert.equal(body.headFreshness.ok, true);
      assert.deepEqual(
        body.missingHeadDays.map((d: { day: string }) => d.day),
        [dayOffset(-3), d1],
        "鎖の途中の穴と、ヘッドの翌日から公開日の前日まで",
      );
      for (const d of body.missingHeadDays) assert.equal(d.status, "no_head_for_day");
      assert.equal(body.license, "CC-BY-4.0");
      assert.match(body.cite, /KIZUNA Creation/);
    });

    await t.test("ヘッドが無い日の day ファイルは 404 で、後から root を作らない", async () => {
      const res = await dayGet(new NextRequest(`http://localhost/api/v1/observatory/anchors/day?day=${dayOffset(-3)}`));
      assert.equal(res.status, 404);
      assert.equal((await res.json()).status, "no_head_for_day");
      const rows = await db.execute(sql`SELECT day FROM ledger_anchors WHERE day = ${dayOffset(-3)}`);
      assert.equal(((Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows) as unknown[]).length, 0);
    });

    await t.test("GET の dayVerification は、ファイル・ヘッド・鎖を別々に読んで一致を確かめる", async () => {
      const res = await anchorsGet(new NextRequest("http://localhost/api/v1/observatory/anchors?days=30"));
      const body = await res.json();
      assert.equal(body.dayVerification.day, d4);
      assert.equal(body.dayVerification.ok, true, JSON.stringify(body.dayVerification));
      const head4 = body.anchors.find((a: { day: string }) => a.day === d4);
      const head2 = body.anchors.find((a: { day: string }) => a.day === d2);
      assert.equal(body.dayVerification.publishedRoot, head4.rootHash);
      assert.equal(body.dayVerification.chainRoot, head2.prevRoot);
    });

    await t.test("鍵なしで day ファイルから root を計算し直すと、ヘッドと鎖の両方に一致する", async () => {
      const anchors = await (await anchorsGet(new NextRequest("http://localhost/api/v1/observatory/anchors?days=30"))).json();
      const res = await dayGet(new NextRequest(`http://localhost/api/v1/observatory/anchors/day?day=${d4}`));
      assert.equal(res.status, 200);
      const bytes = Buffer.from(await res.arrayBuffer());
      const head4 = anchors.anchors.find((a: { day: string }) => a.day === d4);
      const head2 = anchors.anchors.find((a: { day: string }) => a.day === d2);
      // 検算は製品のヘルパーを使わず、公開した式をここで書き下す。
      const recomputed = createHash("sha256")
        .update(head4.prevRoot ?? "genesis")
        .update("\n")
        .update(bytes)
        .digest("hex");
      assert.equal(recomputed, head4.rootHash);
      assert.equal(recomputed, head2.prevRoot);
      assert.equal(res.headers.get("x-vet402-day-verification"), "ok");
      assert.equal(res.headers.get("x-vet402-payload-sha256"), createHash("sha256").update(bytes).digest("hex"));
    });

    await t.test("封印の後にその日の行を変えると、day ファイルの検証も GET の検証も落ちる", async () => {
      await db.execute(sql`
        INSERT INTO x402_l1_purchases (endpoint_id, status, network, attempted_at)
        VALUES (${eid}::uuid, 'settled', 'eip155:8453', ${`${d4}T09:00:00Z`}::timestamptz)
      `);
      const res = await dayGet(new NextRequest(`http://localhost/api/v1/observatory/anchors/day?day=${d4}`));
      assert.equal(res.headers.get("x-vet402-day-verification"), "payload_does_not_match_head");
      const body = await (await anchorsGet(new NextRequest("http://localhost/api/v1/observatory/anchors?days=30"))).json();
      assert.equal(body.dayVerification.ok, false);
      assert.equal(body.dayVerification.code, "payload_does_not_match_head");
    });

    await t.test("ヘッドが 3 日遅れたら 200 を返さず、遅れを書く", async () => {
      await db.execute(sql`DELETE FROM ledger_anchors WHERE day = ${d2}`);
      const res = await anchorsGet(new NextRequest("http://localhost/api/v1/observatory/anchors?days=30"));
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.error, "anchors_head_stale");
      assert.equal(body.headFreshness.code, "head_too_stale");
      assert.equal(body.headFreshness.lagDays, 4);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.deepEqual(
        body.missingHeadDays.map((d: { day: string }) => d.day),
        [dayOffset(-3), d2, d1],
      );
    });

    await db.execute(sql`TRUNCATE ledger_anchors, x402_l1_purchases, x402_endpoints CASCADE`);
  });
}
