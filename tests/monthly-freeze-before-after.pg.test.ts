// ============================================================
// F5 の前後比較（2026-11-27 レビュー）。
//  - 2026-12-01 より前の日の root は、凍結の行が DB にあっても変わらない（canonicalDayPayload と同じ式のまま）
//  - 2026-12-01 の日は、凍結月の行を 1 行だけ足した payload で root を作る
//  （旧コードとの 1 バイト比較は 2026-11-27 のレビューで一度だけ実走した。ここでは式で固定する）
//  - 凍結のハッシュは、公開の /api/v1/reports/YYYY-MM.csv の本文と一致する
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_test \
//   npx tsx --test --test-concurrency=1 --test-force-exit tests/monthly-freeze-before-after.pg.test.ts
// ============================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

function pgErrorMatches(err: unknown, pattern: RegExp): boolean {
  const e = err as Error & { cause?: { message?: string } };
  const text = `${e.message}\n${e.cause?.message ?? ""}`;
  return pattern.test(text);
}

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("monthly freeze before/after (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;
  process.env.PROXY_HEADER_SOURCE = "generic";

  test("F5 before/after", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const anchors = await import("@/lib/observatory/anchors");
    const mf = await import("@/lib/observatory/monthly-freeze");
    const { EXPORT_CSV_COLUMNS } = await import("@/lib/observatory/export-columns");
    const db = getDb()!;

    const migrationSql = readFileSync(join(process.cwd(), "scripts/sql/2026-11-27-ledger-monthly-frozen.sql"), "utf8");
    // 本番では psql が1トランザクションで流す。試験のドライバは BEGIN/COMMIT を1文に混ぜられないので外して流す。
    await db.execute(sql.raw(migrationSql.replace(/^(BEGIN|COMMIT);$/gm, "").replace("SET LOCAL lock_timeout", "SET lock_timeout")));
    await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, x402_daily_metrics, ledger_anchors, ledger_monthly_frozen`);
    const [ep] = await db
      .insert(schema.x402Endpoints)
      .values({ resourceKey: "f5.example/api", resourceUrl: "https://f5.example/api", network: "eip155:8453", method: "GET", declaredSchema: { type: "object" } as never })
      .returning();
    let seq = 0;
    const buy = (status: string, at: string, extra: Record<string, unknown> = {}) =>
      db.insert(schema.x402L1Purchases).values({
        endpointId: ep.id,
        status,
        spentUnits: status === "settled" ? "1000" : "0",
        amountUnits: "1000",
        network: "eip155:8453",
        attemptedAt: new Date(at),
        txHash: status === "settled" ? `0x${(++seq).toString(16).padStart(64, "0")}` : null,
        httpStatusPaid: status === "settled" ? 200 : null,
        latencyMs: 100 + seq,
        ...extra,
      } as never);
    // 同じ秒に 3 行（ミリ秒違い）・除外される status・l2 mismatch・月境界の前後
    await buy("settled", "2026-11-29T10:00:00.900Z");
    await buy("settled", "2026-11-29T10:00:00.100Z", { l2Schema: "mismatch" });
    await buy("settled", "2026-11-29T10:00:00.500Z", { l2Schema: "pass" });
    await buy("budget_denied", "2026-11-29T11:00:00Z");
    await buy("settle_failed", "2026-11-30T23:59:59.999Z");
    await buy("settled", "2026-12-01T00:00:00.000Z");
    await buy("settled", "2026-12-01T05:00:00Z");

    await t.test("12/1 より前の日: 凍結の行があっても、旧式と同じ root・同じ検算入力", async () => {
      const a29 = await anchors.anchorDay("2026-11-29");
      const a30 = await anchors.anchorDay("2026-11-30");
      // 凍結を入れる（12/1 の公開後に走る想定の行）
      const summary = await mf.computeMonthlyFreezeFromDb(db, "2026-11");
      const t0 = Date.now();
      assert.equal(await mf.insertMonthlyFreeze(db, summary), "inserted");
      const stored = await mf.loadMonthlyFreezeSummary(db, "2026-11");
      assert.ok(stored!.frozenAt);
      assert.ok(Date.parse(stored!.frozenAt) >= t0 - 60_000, "frozen_at comes from the DB clock, not the caller");
      assert.equal(await mf.insertMonthlyFreeze(db, summary), "unchanged");

      await assert.rejects(
        () =>
          db.execute(sql`
            UPDATE ledger_monthly_frozen
            SET frozen_at = '2020-01-01T00:00:00Z'::timestamptz
            WHERE month = '2026-11'
          `),
        (err: unknown) => pgErrorMatches(err, /ledger_monthly_frozen rows are immutable/i),
      );
      // summary_json（frozenAt を含む）・month の書き換えと DELETE も拒む（点検 4 回目）
      await assert.rejects(
        () => db.execute(sql`UPDATE ledger_monthly_frozen SET summary_json = summary_json || '{"frozenAt":"2020-01-01T00:00:00.000000Z"}'::jsonb WHERE month = '2026-11'`),
        (err: unknown) => pgErrorMatches(err, /ledger_monthly_frozen rows are immutable/i),
      );
      await assert.rejects(
        () => db.execute(sql`UPDATE ledger_monthly_frozen SET month = '2026-10' WHERE month = '2026-11'`),
        (err: unknown) => pgErrorMatches(err, /ledger_monthly_frozen rows are immutable/i),
      );
      await assert.rejects(
        () => db.execute(sql`DELETE FROM ledger_monthly_frozen WHERE month = '2026-11'`),
        (err: unknown) => pgErrorMatches(err, /ledger_monthly_frozen rows are immutable/i),
      );
      await db.execute(sql`
        INSERT INTO ledger_monthly_frozen (
          month, period_start, period_end_exclusive, row_count, content_sha256, content_csv, summary_json, frozen_at
        ) VALUES (
          '2026-09', '2026-09-01'::date, '2026-10-01'::date, 0, ${"c".repeat(64)}, '', '{}'::jsonb,
          '2020-01-01T00:00:00Z'::timestamptz
        )
      `);
      const legacy = (await mf.listFrozenMonthlyLedger(db)).find((r) => r.month === "2026-09");
      assert.ok(legacy);
      assert.ok(Date.parse(legacy!.frozenAt) >= t0 - 60_000, "insert trigger ignores caller frozen_at");
      // 試験の後片付けだけ: 書き換え禁止のトリガを一時的に外して 2026-09 の行を消す（本番の行は消せない）
      await db.execute(sql`ALTER TABLE ledger_monthly_frozen DISABLE TRIGGER ledger_monthly_frozen_immutable_cols`);
      await db.execute(sql`DELETE FROM ledger_monthly_frozen WHERE month = '2026-09'`);
      await db.execute(sql`ALTER TABLE ledger_monthly_frozen ENABLE TRIGGER ledger_monthly_frozen_immutable_cols`);

      for (const [day, a] of [["2026-11-29", a29], ["2026-11-30", a30]] as const) {
        const { payload } = await anchors.canonicalDayPayload(db, day);
        const prev = day === "2026-11-29" ? null : a29.rootHash;
        const oldRoot = createHash("sha256").update(prev ?? "genesis").update("\n").update(payload).digest("hex");
        assert.equal(a.rootHash, oldRoot, `${day}: 新コードの root = 旧式の root`);
        const vNew = await anchors.readDayVerificationInputs(db, day);
        assert.equal(vNew.payload, payload, `${day}: 検算入力は台帳の payload のまま`);
        assert.equal(vNew.currentPayload, payload, `${day}: 今の payload も月次行を含まない`);
        // 凍結の行がある状態で再計算しても unchanged
        const again = await anchors.anchorDay(day === "2026-11-29" ? "2026-11-30" : day);
        assert.equal(again.status, "unchanged");
      }
      const retained = await anchors.retainSealedPayloads(db);
      assert.deepEqual(retained.drifted, []);
    });

    await t.test("12/1: 凍結月の行が 1 行だけ足される", async () => {
      const a = await anchors.anchorDay("2026-12-01");
      const { payload } = await anchors.canonicalDayPayload(db, "2026-12-01");
      const frozen = await mf.listFrozenMonthlyLedger(db);
      assert.equal(frozen.length, 1);
      const expected = `${payload}\nmonthly-freeze:v1:2026-11:${frozen[0]!.contentSha256}`;
      const heads = await anchors.getAnchors(10);
      const prev = heads.find((h) => h.day === "2026-11-30")!.rootHash;
      assert.equal(a.rootHash, createHash("sha256").update(prev).update("\n").update(expected).digest("hex"));
      const v = await anchors.readDayVerificationInputs(db, "2026-12-01");
      assert.equal(v.payload, expected);
    });

    await t.test("凍結のハッシュは公開の reports CSV から再現できる", async () => {
      const csvRoute = await import("@/app/api/v1/reports/csv/[month]/route");
      const res = await csvRoute.GET(
        new NextRequest("https://vet402.com/api/v1/reports/2026-11.csv", { headers: { "x-real-ip": "203.0.113.99" } }),
        { params: Promise.resolve({ month: "2026-11" }) },
      );
      assert.equal(res.status, 200);
      const body = await res.text();
      const reproduced = createHash("sha256").update(body, "utf8").digest("hex");
      const frozen = await mf.loadMonthlyFreezeSummary(db, "2026-11");
      const lineCount = body === "" ? 0 : body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
      assert.equal(frozen!.rowCount, lineCount);
      assert.equal(reproduced, frozen!.contentSha256);
      assert.equal(res.headers.get("x-vet402-content-sha256"), frozen!.contentSha256);
      const { hashMonthlyLedgerExportBody } = await import("@/lib/observatory/monthly-freeze");
      const { rows, columns } = await (
        await import("@/lib/observatory/ledger-export")
      ).readLedgerExportRows(db, { kind: "utc_month", month: "2026-11" });
      assert.equal(hashMonthlyLedgerExportBody(rows, columns), frozen!.contentSha256);
      void EXPORT_CSV_COLUMNS;
    });

    await t.test("凍結テーブルが無い DB では 12/1 以降の anchorDay が落ちる（移行を先に流す必要）", async () => {
      await db.execute(sql`ALTER TABLE ledger_monthly_frozen RENAME TO ledger_monthly_frozen_hidden`);
      try {
        await assert.rejects(() => anchors.anchorDay("2026-12-01"));
        const pre = await anchors.anchorDay("2026-11-30");
        assert.ok(["unchanged", "conflict_frozen"].includes(pre.status), "12/1 より前は表が無くても動く");
      } finally {
        await db.execute(sql`ALTER TABLE ledger_monthly_frozen_hidden RENAME TO ledger_monthly_frozen`);
      }
    });
  });
}
