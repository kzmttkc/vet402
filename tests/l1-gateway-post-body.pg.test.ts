// Gateway レーン: POST で目録が本文を宣言していない出品は候補に載せない（2026-10-28）。
//
// Run: TEST_DATABASE_URL=postgres://takeshi@localhost:5432/vet402_test_gwget \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-gateway-post-body.pg.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 gateway post body (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("Gateway 候補 SQL は GET と目録本文 declared の POST だけ。他レーンは POST 本文不明のまま", async (t) => {
    const { l1TargetsSqlBuilders } = await import("@/lib/observatory/l1-runner");
    const { CHAIN_DAILY_CAPS } = await import("@/lib/observatory/budget");
    const { gatewayCandidateInclusionSql, ARC_GATEWAY_WALLET } = await import("@/lib/observatory/arc-gateway");
    const { ARC_USDC, BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const savedGateway = process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED;
    process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = "true";
    t.after(() => {
      if (savedGateway === undefined) delete process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED;
      else process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = savedGateway;
    });

    const ARC = "eip155:5042";
    const BASE = "eip155:8453";
    const gw = {
      scheme: "exact",
      network: ARC,
      asset: ARC_USDC,
      payTo: "0x" + "a".repeat(40),
      amount: "1000",
      extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: ARC_GATEWAY_WALLET },
    };
    const baseOnly = {
      scheme: "exact",
      network: BASE,
      asset: BASE_USDC,
      payTo: "0x" + "b".repeat(40),
      amount: "1000",
      extra: { name: "USD Coin", version: "2" },
    };

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);
    const nativeArc = {
      scheme: "exact",
      network: ARC,
      asset: ARC_USDC,
      payTo: "0x" + "c".repeat(40),
      amount: "1000",
      extra: { name: "USDC", version: "2" },
    };
    const listings: { key: string; method: string; di: unknown; accepts: unknown[]; network: string }[] = [
      { key: "gw-get.example/g", method: "GET", di: { query: "empty", body: "empty" }, accepts: [gw], network: ARC },
      { key: "gw-post-empty.example/p", method: "POST", di: { query: "empty", body: "empty" }, accepts: [gw], network: ARC },
      { key: "gw-post-decl.example/p", method: "POST", di: { query: "empty", body: "declared" }, accepts: [gw], network: ARC },
      { key: "arc-native-post-empty.example/p", method: "POST", di: { query: "empty", body: "empty" }, accepts: [nativeArc], network: ARC },
      { key: "base-post-empty.example/p", method: "POST", di: { query: "empty", body: "empty" }, accepts: [baseOnly], network: BASE },
    ];
    for (const [i, row] of listings.entries()) {
      await db.execute(sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, raw_accepts, declared_input, status, quality_payers_30d, quality_calls_30d, first_seen_at)
        VALUES (${row.key}, ${"https://" + row.key}, ${row.method}, ${row.network}, ${"0x" + String(i + 1).padStart(40, "e")}, '1000',
                ${JSON.stringify(row.accepts)}::jsonb, ${JSON.stringify(row.di)}::jsonb, 'active', 1, 1, now())
      `);
    }
    await db.execute(sql`INSERT INTO x402_l0_probes (endpoint_id, method, verdict) SELECT id, 'GET', 'pass' FROM x402_endpoints`);

    const ctx = { limit: 20, laneExclusions: [], firstPurchasesSelectable: true, censusFirstSelectable: true };
    const { targetsSql } = l1TargetsSqlBuilders(ctx);
    const gwLane = { chain: "arc_gateway" as const, networkLike: "%", limit: 20 };
    const arcLane = { chain: "arc" as const, networkLike: CHAIN_DAILY_CAPS.arc.networkLike, limit: 20 };

    const keys = async (
      lane: { chain: "arc_gateway" | "arc"; networkLike: string; limit: number } | undefined,
      extra: ReturnType<typeof gatewayCandidateInclusionSql> | undefined,
    ) => {
      const q = extra
        ? targetsSql(false, lane, undefined, undefined, extra, [])
        : targetsSql(false, lane);
      const raw = await db.execute(q);
      const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { id: string }[];
      const idList = rows.map((r) => sql`${r.id}::uuid`);
      if (idList.length === 0) return [] as string[];
      const names = await db.execute(sql`
        SELECT resource_key FROM x402_endpoints WHERE id IN (${sql.join(idList, sql`, `)}) ORDER BY resource_key
      `);
      const list = (Array.isArray(names) ? names : ((names as { rows?: unknown[] }).rows ?? [])) as {
        resource_key: string;
      }[];
      return list.map((r) => r.resource_key);
    };

    const gwKeys = await keys(gwLane, gatewayCandidateInclusionSql());
    assert.deepEqual(gwKeys, ["gw-get.example/g", "gw-post-decl.example/p"]);

    const arcKeys = await keys(arcLane, undefined);
    assert.ok(arcKeys.includes("arc-native-post-empty.example/p"), "ネイティブ Arc レーンは POST 本文不明のまま");
    assert.ok(!arcKeys.includes("gw-get.example/g"), "Gateway 専用 GET は Arc 枠ではなく Gateway 枠");

    const baseKeys = await keys(undefined, undefined);
    assert.ok(baseKeys.includes("base-post-empty.example/p"), "主候補（Base）は POST 本文不明のまま");
  });
}
