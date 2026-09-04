// ============================================================
// vet402 — 2 層の settled を集計器が壊さないこと（2026-09-05 監査 S-4 / S-17）。
//
// 固定するのは 3 つ:
//   1. nonce_bound + amount_payee_only は必ず settled と一致する（層を足しても総数は動かない）
//   2. チェーン別の内訳の和も settled / attempts と一致する
//   3. 時刻窓は observed_purchases.block_timestamp が有る行だけで判定し、
//      無い行は unknown に落ちる（測っていないものを ok と数えない）
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (!TEST_DB) {
  test("settled tiers (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  // TRUNCATE より前に、接続先が本番（Neon）でないことを機械で確かめる（2026-09-04 監査 D・P2）。
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("settled は 2 層に割れ、和と内訳が総数と一致する", async (t) => {
    const { getObservatoryStats } = await import("@/lib/observatory/reader");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_l1_purchases, observed_purchases`,
    );
    const epRaw = await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, price_asset)
      VALUES ('s4.example/api/x', 'https://s4.example/api/x', 'GET', 'eip155:8453', '0xaa', '1000', '0xusdc')
      RETURNING id::text AS id
    `);
    const eid = ((Array.isArray(epRaw) ? epRaw : (epRaw as { rows?: unknown[] }).rows) as { id: string }[])[0].id;

    // Base: nonce 束縛 2 行（うち 1 行は block_timestamp 有り・窓内、1 行は窓外）
    // Base: nonce 無し 3 行（1 行は block_timestamp 無し = unknown）
    // Solana: nonce 無し 1 行（2026-09-04 より前の memo 未記録行と同じ形）
    // settle_failed 1 行（層に入らない）
    const t0 = "2026-09-05T00:00:00Z";
    await db.execute(sql`
      INSERT INTO x402_l1_purchases
        (endpoint_id, status, network, tx_hash, auth_nonce, settlement_verified, http_status_paid, attempted_at)
      VALUES
        (${eid}::uuid, 'settled', 'eip155:8453', '0x${sql.raw("a".repeat(64))}', ${"0x" + "1".repeat(64)}, true, 200, ${t0}::timestamptz),
        (${eid}::uuid, 'settled', 'eip155:8453', '0x${sql.raw("b".repeat(64))}', ${"0x" + "2".repeat(64)}, true, 200, ${t0}::timestamptz),
        (${eid}::uuid, 'settled', 'eip155:8453', '0x${sql.raw("c".repeat(64))}', NULL, true, 200, ${t0}::timestamptz),
        (${eid}::uuid, 'settled', 'base',        '0x${sql.raw("d".repeat(64))}', NULL, true, 400, ${t0}::timestamptz),
        (${eid}::uuid, 'settled', 'eip155:8453', '0x${sql.raw("e".repeat(64))}', NULL, true, 200, ${t0}::timestamptz),
        (${eid}::uuid, 'settled', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'SoLtx1', NULL, true, 200, ${t0}::timestamptz),
        (${eid}::uuid, 'settle_failed', 'eip155:8453', NULL, NULL, NULL, NULL, ${t0}::timestamptz)
    `);
    // 決済ブロック時刻: a=+30 秒(窓内) / b=+3600 秒(窓外) / c=-10 秒(窓内)。d,e,SoLtx1 は記録なし。
    await db.execute(sql`
      INSERT INTO observed_purchases (wallet, tx_hash, block_timestamp)
      VALUES ('0xpayer', '0x${sql.raw("a".repeat(64))}', ${t0}::timestamptz + interval '30 seconds'),
             ('0xpayer', '0x${sql.raw("b".repeat(64))}', ${t0}::timestamptz + interval '3600 seconds'),
             ('0xpayer', '0x${sql.raw("c".repeat(64))}', ${t0}::timestamptz - interval '10 seconds')
    `);

    const stats = await getObservatoryStats();
    const l1 = stats.l1;

    await t.test("2 層の和が settled と一致する", () => {
      assert.equal(l1.settled, 6);
      assert.equal(l1.settledNonceBound, 2);
      assert.equal(l1.settledAmountPayeeOnly, 4);
      assert.equal(l1.settledNonceBound + l1.settledAmountPayeeOnly, l1.settled);
    });

    await t.test("時刻窓は記録のある行だけを数え、残りは unknown", () => {
      assert.equal(l1.settledTimeWindowOk, 2, "a(+30s) と c(-10s)");
      assert.equal(l1.settledTimeWindowUnknown, 3, "d / e / SoLtx1 は block_timestamp 無し");
      // b は窓外。窓外でも settled から外さない（表示・集計のみ）。
      assert.equal(
        l1.settled - l1.settledTimeWindowOk - l1.settledTimeWindowUnknown,
        1,
        "窓外の 1 行は settled のまま残る",
      );
    });

    await t.test("チェーン別の内訳が総数と一致し、別名は 1 行に畳まれる", () => {
      const chains = Object.fromEntries(l1.byChain.map((c) => [c.chain, c]));
      assert.ok(chains.Base, `Base が無い: ${JSON.stringify(l1.byChain)}`);
      assert.ok(chains.Solana, "Solana が無い");
      // 'base' と 'eip155:8453' は同じチェーン（chains.ts の分割 id 問題）。
      assert.equal(chains.Base.settled, 5);
      assert.equal(chains.Base.attempts, 6);
      assert.equal(chains.Base.settledNonceBound, 2);
      assert.equal(chains.Base.delivered, 4, "http 400 の 1 行は delivered ではない");
      assert.equal(chains.Solana.settled, 1);
      assert.equal(chains.Solana.settledNonceBound, 0);
      assert.equal(
        l1.byChain.reduce((n, c) => n + c.settled, 0),
        l1.settled,
      );
      assert.equal(
        l1.byChain.reduce((n, c) => n + c.attempts, 0),
        l1.attempts,
      );
      assert.equal(
        l1.byChain.reduce((n, c) => n + c.delivered, 0),
        l1.delivered,
      );
      for (const c of l1.byChain) {
        assert.equal(c.settledNonceBound + c.settledAmountPayeeOnly, c.settled, c.chain);
      }
    });

    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_l1_purchases, observed_purchases`,
    );
  });
}
