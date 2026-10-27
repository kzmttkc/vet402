// ============================================================
// Celo・Avalanche のレーンの候補は、まだ試していない運営者（payTo）を先に並べる（2026-10-28）。
//
// 守ること:
//   1. Celo は 3 段。資格情報（auth_nonce）をその network でまだ出していない payTo → 資格情報は出したが証拠の列
//      （payment_payload）の行がまだ無い payTo → 証拠の列つきの行がある payTo。段の中は従来の並び（ホストの試行数・
//      7 日の未入金・需要…）のまま。
//   2. Avalanche は 2 段（資格情報を出したか）。payment_payload は段を分けない。
//   3. 「試した」は同じ network の行だけ。auth_nonce が NULL の行（資格情報を出す前に終わった）は試したに数えない。
//      payTo は大小を無視して比べる。
//   4. 共有の payTo（LANE_SHARED_PAYTO_MIN_HOSTS 以上のホストが同じ payTo）は運営者の印にしない。試したホストだけが後ろへ回る。
//   5. 候補に入る行は変えない（並びだけ）。
//
// Run: TEST_DATABASE_URL=postgres:///vet402_test_payto \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-payto-first.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 payTo first (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("Celo は未試行の payTo → 証拠なしの payTo → 証拠ありの payTo の順、Avalanche は未試行の payTo が先", async () => {
    const { l1TargetsSqlBuilders, LANE_SHARED_PAYTO_MIN_HOSTS } = await import("@/lib/observatory/l1-runner");
    const { CHAIN_DAILY_CAPS } = await import("@/lib/observatory/budget");
    const { BASE_USDC, CELO_CHAIN, AVALANCHE_CHAIN } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    assert.equal(LANE_SHARED_PAYTO_MIN_HOSTS, 10);
    const BASE = "eip155:8453";
    const CELO = "eip155:42220";
    const AVAX = "eip155:43114";
    const addr = (tag: string) => `0x${tag.padStart(40, "0")}`;
    const baseAccept = (payTo: string) => ({ scheme: "exact", network: BASE, asset: BASE_USDC, payTo, amount: "1000" });
    const celoAccept = (payTo: string) => ({ scheme: "exact", network: CELO, asset: CELO_CHAIN.usdc, payTo, amount: "1000", extra: { name: "USDC", version: "2" } });
    const avaxAccept = (payTo: string) => ({ scheme: "exact", network: AVAX, asset: AVALANCHE_CHAIN.usdc, payTo, amount: "1000", extra: { name: "USD Coin", version: "2" } });

    type Seed = { key: string; network: string; payTo: string; accepts: unknown[]; payers: number; status?: string };
    const seeds: Seed[] = [];
    const listing = (key: string, payTo: string, lane: "celo" | "avax", payers: number, status = "active") => {
      const second = lane === "celo" ? celoAccept(payTo) : avaxAccept(payTo);
      // 出品の payTo は大文字まじり（チェックサム）。購入の行の pay_to は小文字。大小を無視して比べることを確かめる。
      seeds.push({ key, network: BASE, payTo: payTo.toLowerCase(), accepts: [baseAccept(payTo.toLowerCase()), second], payers, status });
    };

    // ---- Celo ----
    const E = addr("E1DE"); // 証拠の列つきの行がある payTo
    const C = addr("C0DE"); // 資格情報だけの payTo
    const N = addr("A11CE"); // auth_nonce が NULL の行だけの payTo（試していない）
    const F = addr("F00D"); // 一度も買っていない payTo
    const G = addr("6A6"); // 共有の payTo（10 ホスト）
    const X = addr("C055"); // Celo でだけ試した payTo（Avalanche では未試行）
    listing("evid-a.example/bought", E, "celo", 1, "delisted");
    listing("evid-b.example/api", E, "celo", 900);
    listing("cred-a.example/bought", C, "celo", 1, "delisted");
    listing("cred-b.example/api", C, "celo", 800);
    listing("nocred-a.example/bought", N, "celo", 1, "delisted");
    listing("nocred-b.example/api", N, "celo", 700);
    listing("fresh.example/api", F, "celo", 100);
    for (let i = 0; i < LANE_SHARED_PAYTO_MIN_HOSTS; i++) listing(`agg-${i}.example/api`, G, "celo", 600);
    listing("agg-0.example/bought", G, "celo", 1, "delisted");
    listing("cross-celo.example/bought", X, "celo", 1, "delisted");

    // ---- Avalanche ----
    const AE = addr("AE"); // Avalanche で証拠の列つき
    const AC = addr("AC"); // Avalanche で資格情報だけ
    const AF = addr("AF"); // Avalanche で未試行
    listing("ax-evid-a.example/bought", AE, "avax", 1, "delisted");
    listing("ax-evid-b.example/api", AE, "avax", 900);
    listing("ax-cred-a.example/bought", AC, "avax", 1, "delisted");
    listing("ax-cred-b.example/api", AC, "avax", 800);
    listing("ax-fresh.example/api", AF, "avax", 100);
    listing("ax-cross.example/api", X, "avax", 50);

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);
    for (const [i, s] of seeds.entries()) {
      await db.execute(sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, raw_accepts, status, quality_payers_30d, quality_calls_30d, first_seen_at)
        VALUES (${s.key}, ${"https://" + s.key}, 'GET', ${s.network}, ${s.payTo}, '1000', ${JSON.stringify(s.accepts)}::jsonb,
                ${s.status ?? "active"}, ${s.payers}, ${s.payers * 10}, timestamptz '2025-01-01+00' + make_interval(days => ${i}))
      `);
    }
    await db.execute(sql`INSERT INTO x402_l0_probes (endpoint_id, method, verdict) SELECT id, 'GET', 'pass' FROM x402_endpoints`);

    // 購入の行は 40 日前（スイープ窓・7 日の未入金の外）。pay_to は小文字（本番の書き方）。
    const buy = async (key: string, network: string, payTo: string, opts: { nonce: boolean; payload: boolean; status: string }) => {
      await db.execute(sql`
        INSERT INTO x402_l1_purchases (endpoint_id, network, status, pay_to, auth_nonce, payment_payload, amount_units, spent_units, attempted_at)
        SELECT id, ${network}, ${opts.status}, ${payTo.toLowerCase()},
               ${opts.nonce ? "0x" + "ab".repeat(32) : null},
               ${opts.payload ? JSON.stringify({ header: "X-PAYMENT", decoded: { x402Version: 2 } }) : null}::jsonb,
               '1000', ${opts.nonce ? "1000" : "0"}, now() - interval '40 days'
        FROM x402_endpoints WHERE resource_key = ${key}
      `);
    };
    await buy("evid-a.example/bought", CELO, E, { nonce: true, payload: true, status: "settled" });
    await buy("cred-a.example/bought", CELO, C, { nonce: true, payload: false, status: "settle_failed" });
    await buy("nocred-a.example/bought", CELO, N, { nonce: false, payload: false, status: "request_error" });
    await buy("agg-0.example/bought", CELO, G, { nonce: true, payload: true, status: "settled" });
    await buy("cross-celo.example/bought", CELO, X, { nonce: true, payload: true, status: "settled" });
    // Base で試しただけの payTo は Celo では未試行のまま。
    await buy("fresh.example/api", BASE, F, { nonce: true, payload: true, status: "settled" });
    await buy("ax-evid-a.example/bought", AVAX, AE, { nonce: true, payload: true, status: "settled" });
    await buy("ax-cred-a.example/bought", AVAX, AC, { nonce: true, payload: false, status: "settle_failed" });

    const ctx = { limit: 100, laneExclusions: [], firstPurchasesSelectable: true, censusFirstSelectable: true };
    const b = l1TargetsSqlBuilders(ctx);
    const keysOf = async (q: ReturnType<typeof b.targetsSql>) => {
      const raw = await db.execute(q);
      const list = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { id: string }[];
      const out: string[] = [];
      for (const r of list) {
        const k = await db.execute(sql`SELECT resource_key FROM x402_endpoints WHERE id = ${String(r.id)}::uuid`);
        const kr = (Array.isArray(k) ? k : ((k as { rows?: unknown[] }).rows ?? [])) as { resource_key: string }[];
        out.push(kr[0]!.resource_key);
      }
      return out;
    };

    for (const daily of [true, false]) {
      const celo = await keysOf(b.targetsSql(daily, { chain: "celo", networkLike: CHAIN_DAILY_CAPS.celo.networkLike, limit: 100 }));
      const aggUntried = Array.from({ length: LANE_SHARED_PAYTO_MIN_HOSTS - 1 }, (_, i) => `agg-${i + 1}.example/api`);
      // 段 0: 未試行の payTo。段の中は従来の並び（需要の多い順）: nocred-b 700 → agg-1..9 600 → fresh 100。
      assert.deepEqual(
        celo,
        ["nocred-b.example/api", ...aggUntried, "fresh.example/api", "cred-b.example/api", "evid-b.example/api", "agg-0.example/api"],
        `Celo daily=${daily}: 未試行 → 資格情報だけ → 証拠あり`,
      );
      // 候補に入る行は変えない: active の Celo の出品の全部（delisted と Avalanche だけの出品は入らない）。
      assert.equal(celo.length, 4 + LANE_SHARED_PAYTO_MIN_HOSTS);

      const avax = await keysOf(b.targetsSql(daily, { chain: "avalanche", networkLike: CHAIN_DAILY_CAPS.avalanche.networkLike, limit: 100 }));
      // 段 0: ax-fresh（100）・ax-cross（50。Celo でだけ試した payTo）。段 1: payment_payload の有無で分けない（需要の順）。
      assert.deepEqual(
        avax,
        ["ax-fresh.example/api", "ax-cross.example/api", "ax-evid-b.example/api", "ax-cred-b.example/api"],
        `Avalanche daily=${daily}: 未試行の payTo が先、資格情報を出した payTo は証拠の有無を問わず後ろ`,
      );
    }

    // 共有の payTo がしきい値に届かなければ（9 ホスト）、運営者として扱う: agg の全ホストが後ろへ回る。
    await db.execute(sql`UPDATE x402_endpoints SET status = 'delisted' WHERE resource_key = 'agg-9.example/api'`);
    const celoNine = await keysOf(b.targetsSql(true, { chain: "celo", networkLike: CHAIN_DAILY_CAPS.celo.networkLike, limit: 100 }));
    assert.deepEqual(celoNine.slice(0, 3), ["nocred-b.example/api", "fresh.example/api", "cred-b.example/api"]);
    assert.ok(celoNine.indexOf("agg-1.example/api") > celoNine.indexOf("cred-b.example/api"), "9 ホストの payTo は 1 運営者として後ろへ");
  });
}
