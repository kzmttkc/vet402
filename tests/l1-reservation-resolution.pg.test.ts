// ============================================================
// 予約行の後始末 — 「署名した後」と「署名する前」で扱いが違う（2026-09-19 横断監査 W2 / W4）。
//
//   resolveReservationAsFailed … 署名して払える状態にした後で落ちた。settle_failed へ倒し、
//                                spent_units は残す（「署名したら計上する」は予算の不変条件）。
//   releaseReservation         … まだ署名していないのに予約だけ立っている（Tempo の署名器が
//                                RPC へ出て落ちた）。一円も動いていないので行ごと消す。
//                                残すと、我々の RPC 障害が公開台帳に売り手の不履行として載り、
//                                スイープ窓のあいだその売り手を測れなくなる。
//
// ついでに固定する 2 つ:
//   - error は redactForLog を通す（RPC の URL に鍵が入る形がある）。
//   - resolveReservationAsFailed の UPDATE は**実際に走る**。`jsonb_build_object('error', $1)`
//     は型が決まらず（could not determine data type of parameter $1）2026-09-19 まで毎回
//     落ちていて、行は in_flight のまま 30 分後の孤児掃除に拾われていた。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-reservation-resolution.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 reservation resolution (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const RPC_ERROR = new Error("HTTP request failed. URL: https://tempo.example/v2/SECRETKEY. Details: fetch failed");

  test("reservation resolution", async (t) => {
    const { resolveReservationAsFailed, releaseReservation } = await import("@/lib/observatory/l1-runner");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const rows = <T,>(raw: unknown) => [...((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[])];

    async function seedReservation(over: { status?: string; txHash?: string } = {}): Promise<string> {
      await db.execute(sql`TRUNCATE x402_endpoints, x402_l1_purchases, observed_purchases`);
      const ep = rows<{ id: string }>(
        await db.execute(sql`
          INSERT INTO x402_endpoints (resource_key, resource_url, source, method, network, pay_to, price_amount, price_asset, status)
          VALUES ('seller.example/api', 'https://seller.example/api', 'cdp_bazaar', 'GET', 'eip155:4217',
                  '0xca4e835f803cb0b7c428222b3a3b98518d4779fe', '25000', '0x20c000000000000000000000b9537d11c60e8b50', 'active')
          RETURNING id::text AS id`),
      )[0];
      const inserted = await db
        .insert(schema.x402L1Purchases)
        .values({
          endpointId: ep.id,
          status: over.status ?? "in_flight",
          payer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
          network: "eip155:4217",
          asset: "0x20c000000000000000000000b9537d11c60e8b50",
          payTo: "0xca4e835f803cb0b7c428222b3a3b98518d4779fe",
          amountUnits: "25000",
          spentUnits: "25000",
          ...(over.txHash ? { txHash: over.txHash } : {}),
        })
        .returning();
      return inserted[0].id;
    }

    const purchases = async () =>
      rows<{ id: string; status: string; spent_units: string; raw_response_meta: Record<string, unknown> | null }>(
        await db.execute(sql`SELECT id::text AS id, status, spent_units, raw_response_meta FROM x402_l1_purchases`),
      );

    await t.test("resolveReservationAsFailed: 行は settle_failed になり、spent_units は残り、URL は伏字", async () => {
      const rowId = await seedReservation();
      await resolveReservationAsFailed(db, rowId, RPC_ERROR);
      const after = await purchases();
      assert.equal(after.length, 1);
      assert.equal(after[0].status, "settle_failed", "UPDATE が実際に走っている（型未確定で落ちていない）");
      assert.equal(after[0].spent_units, "25000", "署名した後なので計上は残す");
      const meta = after[0].raw_response_meta ?? {};
      assert.equal(meta.phase, "post_reservation");
      assert.equal(meta.reason, "threw_after_reservation");
      assert.equal(String(meta.error).includes("SECRETKEY"), false, `鍵が残っている: ${String(meta.error)}`);
      assert.ok(String(meta.error).includes("<url>"), `伏字が入っていない: ${String(meta.error)}`);
    });

    await t.test("releaseReservation: 署名前の in_flight は行ごと消える", async () => {
      const rowId = await seedReservation();
      await releaseReservation(db, rowId);
      assert.deepEqual(await purchases(), [], "行が無い＝翌バッチでまた候補になる");
    });

    await t.test("releaseReservation: 決済 tx を持つ行と in_flight でない行は消さない", async () => {
      const withTx = await seedReservation({ txHash: `0x${"cd".repeat(32)}` });
      await releaseReservation(db, withTx);
      assert.equal((await purchases()).length, 1, "tx がある行は「何も起きていない予約」ではない");

      const settled = await seedReservation({ status: "settle_claimed" });
      await releaseReservation(db, settled);
      const after = await purchases();
      assert.equal(after.length, 1);
      assert.equal(after[0].status, "settle_claimed");
    });
  });
}
