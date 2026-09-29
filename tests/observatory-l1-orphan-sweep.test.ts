// ============================================================
// vet402 Observatory L1 — 孤児 in_flight の回収（2026-08-22 監査 項目5）。
//
// reserveSpend は署名の前に in_flight 行を書く。署名後・記帳前に落ちた行は
// 誰も解決しないので、スイープ窓（既定6日）の重複判定に居座り、その
// エンドポイントを窓の間ずっと購入対象から外し続ける。
//
// 固定する性質:
//  - しきい値より古い in_flight だけが request_error へ解決される;
//  - **spent_units は1単位も動かない**（署名したら計上する＝予算の不変条件。
//    ここを戻すと当日の予算が二重に空く);
//  - 進行中（しきい値より新しい）の行と、他 status の行には触らない。
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/observatory-l1-orphan-sweep.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 orphan sweep (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;

  test("孤児 in_flight の回収", async () => {
    const { sweepOrphanedInFlight, ORPHAN_IN_FLIGHT_MINUTES } = await import(
      "@/lib/observatory/l1-runner"
    );
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    await db.execute(sql`TRUNCATE x402_l1_purchases`);
    assert.ok(ORPHAN_IN_FLIGHT_MINUTES >= 5, "しきい値が実行中の行を巻き込まない大きさか");

    const endpointA = "11111111-1111-1111-1111-111111111111";
    const endpointB = "22222222-2222-2222-2222-222222222222";
    const endpointC = "33333333-3333-3333-3333-333333333333";
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

    // (a) 古い孤児、(b) 進行中、(c) 古いが決着済み。
    await db.insert(schema.x402L1Purchases).values([
      {
        endpointId: endpointA,
        status: "in_flight",
        spentUnits: "3000",
        amountUnits: "3000",
        // 署名して nonce を書いた後に落ちた行（資格情報は外へ出た可能性がある）。
        authNonce: "0x" + "cd".repeat(32),
        attemptedAt: minutesAgo(ORPHAN_IN_FLIGHT_MINUTES + 5),
      },
      {
        endpointId: endpointB,
        status: "in_flight",
        spentUnits: "1000",
        amountUnits: "1000",
        attemptedAt: minutesAgo(1),
      },
      {
        endpointId: endpointC,
        status: "settled",
        spentUnits: "2000",
        amountUnits: "2000",
        attemptedAt: minutesAgo(ORPHAN_IN_FLIGHT_MINUTES + 5),
      },
    ]);

    const totalBefore = await db.execute(
      sql`SELECT coalesce(sum(spent_units::numeric), 0)::text AS spent FROM x402_l1_purchases`,
    );
    const sumOf = (raw: unknown) =>
      String(
        ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as {
          spent: string;
        }[])[0]?.spent,
      );

    const swept = await sweepOrphanedInFlight(db);
    assert.equal(swept, 1);

    const rows = await db
      .select({
        endpointId: schema.x402L1Purchases.endpointId,
        status: schema.x402L1Purchases.status,
        spentUnits: schema.x402L1Purchases.spentUnits,
        meta: schema.x402L1Purchases.rawResponseMeta,
      })
      .from(schema.x402L1Purchases);
    const byEndpoint = new Map(rows.map((r) => [r.endpointId, r]));

    // 古い孤児だけが解決され、我々側の状態（request_error）になる。
    assert.equal(byEndpoint.get(endpointA)!.status, "request_error");
    assert.equal(
      (byEndpoint.get(endpointA)!.meta as Record<string, unknown>).reason,
      "orphaned_in_flight",
    );
    // 進行中と決着済みには触らない。
    assert.equal(byEndpoint.get(endpointB)!.status, "in_flight");
    assert.equal(byEndpoint.get(endpointC)!.status, "settled");

    // 予算の不変条件: spent_units の総和は1単位も動かない。
    const totalAfter = await db.execute(
      sql`SELECT coalesce(sum(spent_units::numeric), 0)::text AS spent FROM x402_l1_purchases`,
    );
    assert.equal(sumOf(totalAfter), sumOf(totalBefore));
    assert.equal(byEndpoint.get(endpointA)!.spentUnits, "3000");

    // 冪等: 2回目は何も掴まない。
    assert.equal(await sweepOrphanedInFlight(db), 0);

    // 2026-09-29 監査4周目: auth_nonce が NULL の孤児（署名直前の停止判定のあと DB 不通で
    // 予約を戻せなかった行）は、資格情報が外へ出ていないので spent_units を 0 に戻す。
    const endpointD = "44444444-4444-4444-4444-444444444444";
    await db.insert(schema.x402L1Purchases).values({
      endpointId: endpointD,
      status: "in_flight",
      spentUnits: "5000",
      amountUnits: "5000",
      attemptedAt: minutesAgo(ORPHAN_IN_FLIGHT_MINUTES + 5),
    });
    assert.equal(await sweepOrphanedInFlight(db), 1);
    const d = (
      await db
        .select({ status: schema.x402L1Purchases.status, spentUnits: schema.x402L1Purchases.spentUnits, meta: schema.x402L1Purchases.rawResponseMeta })
        .from(schema.x402L1Purchases)
    ).find((r) => (r.meta as Record<string, unknown> | null)?.credentialSent === false)!;
    assert.equal(d.status, "request_error");
    assert.equal(d.spentUnits, "0", "未送信の予約は日次予算へ戻る");
    // 署名済みの行（A）は 1 単位も動いていない。
    assert.equal(
      (await db.select({ s: schema.x402L1Purchases.spentUnits, e: schema.x402L1Purchases.endpointId }).from(schema.x402L1Purchases)).find((r) => r.e === endpointA)!.s,
      "3000",
    );

    await db.execute(sql`TRUNCATE x402_l1_purchases`);
  });
}
