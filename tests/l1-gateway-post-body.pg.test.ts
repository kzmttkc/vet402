// Gateway レーン: POST で目録が本文を宣言していない出品は候補に載せない（2026-10-28/29 差し戻し）。
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

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const GW_PAYTO = "0x" + "a".repeat(40);

  test("Gateway POST 本文: 型の表・件数・inclusion/prefilter・1 件指定・署名前見送り", async (t) => {
    const { l1TargetsSqlBuilders, laneNetworkPrefilterSql, runL1Batch, queryGatewayPostBodyUnknownActive } =
      await import("@/lib/observatory/l1-runner");
    const { CHAIN_DAILY_CAPS } = await import("@/lib/observatory/budget");
    const {
      gatewayCandidateInclusionSql,
      gatewayCandidateInclusionWithoutRequestShapeSql,
      gatewayPostBodyUnknownExcludedCountSql,
      ARC_GATEWAY_WALLET,
    } = await import("@/lib/observatory/arc-gateway");
    const { ARC_USDC } = await import("@/lib/observatory/x402-payer");
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
    const gw = {
      scheme: "exact",
      network: ARC,
      asset: ARC_USDC,
      payTo: GW_PAYTO,
      amount: "1000",
      extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: ARC_GATEWAY_WALLET },
    };
    const nativeArc = {
      scheme: "exact",
      network: ARC,
      asset: ARC_USDC,
      payTo: "0x" + "c".repeat(40),
      amount: "1000",
      extra: { name: "USDC", version: "2" },
    };

    type RowSpec = {
      key: string;
      method: string | null;
      di: unknown;
      candidate: boolean;
      countsAsUnknown: boolean;
    };

    const rows: RowSpec[] = [
      { key: "t-get.example/g", method: "GET", di: { query: "empty", body: "empty" }, candidate: true, countsAsUnknown: false },
      { key: "t-null-method.example/g", method: null, di: { query: "empty", body: "empty" }, candidate: true, countsAsUnknown: false },
      { key: "t-put.example/p", method: "PUT", di: { query: "empty", body: "empty" }, candidate: true, countsAsUnknown: false },
      { key: "t-empty-method.example/g", method: "", di: { query: "empty", body: "empty" }, candidate: true, countsAsUnknown: false },
      { key: "t-post-decl.example/p", method: "POST", di: { query: "empty", body: "declared" }, candidate: true, countsAsUnknown: false },
      { key: "t-post-lower.example/p", method: "post", di: { query: "empty", body: "declared" }, candidate: true, countsAsUnknown: false },
      { key: "t-post-empty.example/p", method: "POST", di: { query: "empty", body: "empty" }, candidate: false, countsAsUnknown: true },
      { key: "t-post-wrongcase.example/p", method: "POST", di: { query: "empty", body: "Declared" }, candidate: false, countsAsUnknown: true },
      { key: "t-post-refused.example/p", method: "POST", di: { query: "empty", body: "refused" }, candidate: false, countsAsUnknown: true },
      { key: "t-post-null-json.example/p", method: "POST", di: { query: "empty", body: null }, candidate: false, countsAsUnknown: true },
      { key: "t-post-obj.example/p", method: "POST", di: {}, candidate: false, countsAsUnknown: true },
      { key: "t-post-arr.example/p", method: "POST", di: [], candidate: false, countsAsUnknown: true },
      { key: "t-post-scalar.example/p", method: "POST", di: "x", candidate: false, countsAsUnknown: true },
      { key: "t-post-col-null.example/p", method: "POST", di: null, candidate: false, countsAsUnknown: true },
    ];

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);
    for (const [i, row] of rows.entries()) {
      await db.execute(sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, raw_accepts, declared_input, status, quality_payers_30d, quality_calls_30d, first_seen_at)
        VALUES (${row.key}, ${"https://" + row.key}, ${row.method}, ${ARC}, ${"0x" + String(i + 1).padStart(40, "e")}, '1000',
                ${JSON.stringify([gw])}::jsonb, ${row.di === null ? null : JSON.stringify(row.di)}::jsonb, 'active', 1, 1, now())
      `);
    }
    await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, raw_accepts, declared_input, status, quality_payers_30d, quality_calls_30d, first_seen_at)
      VALUES ('arc-native-post-empty.example/p', 'https://arc-native-post-empty.example/p', 'POST', ${ARC}, ${"0x" + "f".repeat(40)}, '1000',
              ${JSON.stringify([nativeArc])}::jsonb, ${JSON.stringify({ query: "empty", body: "empty" })}::jsonb, 'active', 1, 1, now())
    `);
    await db.execute(sql`INSERT INTO x402_l0_probes (endpoint_id, method, verdict) SELECT id, 'GET', 'pass' FROM x402_endpoints`);

    const ctx = { limit: 40, laneExclusions: [], firstPurchasesSelectable: true, censusFirstSelectable: true };
    const { targetsSql } = l1TargetsSqlBuilders(ctx);
    const gwLane = { chain: "arc_gateway" as const, networkLike: "%", limit: 40 };

    const gwKeys = async (
      lane: typeof gwLane | undefined,
      extra: ReturnType<typeof gatewayCandidateInclusionSql>,
      lanePrefilter = true,
    ) => {
      const b = l1TargetsSqlBuilders({ ...ctx, lanePrefilter });
      const q = b.targetsSql(false, lane, undefined, undefined, extra, []);
      const raw = await db.execute(q);
      const list = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { id: string }[];
      const idList = list.map((r) => sql`${r.id}::uuid`);
      if (idList.length === 0) return [] as string[];
      const names = await db.execute(sql`
        SELECT resource_key FROM x402_endpoints WHERE id IN (${sql.join(idList, sql`, `)}) ORDER BY resource_key
      `);
      const keys = (Array.isArray(names) ? names : ((names as { rows?: unknown[] }).rows ?? [])) as { resource_key: string }[];
      return keys.map((r) => r.resource_key);
    };

    const expectedCandidates = rows.filter((r) => r.candidate).map((r) => r.key).sort();
    const expectedUnknownCount = rows.filter((r) => r.countsAsUnknown).length;

    const keys = await gwKeys(gwLane, gatewayCandidateInclusionSql());
    assert.deepEqual(keys.sort(), expectedCandidates);

    const active = await queryGatewayPostBodyUnknownActive(db);
    assert.equal(active, expectedUnknownCount);

    const countRaw = await db.execute(gatewayPostBodyUnknownExcludedCountSql());
    const countRows = (Array.isArray(countRaw) ? countRaw : (countRaw as { rows?: { n?: number }[] }).rows ?? []) as {
      n?: number;
    }[];
    assert.equal(Number(countRows[0]?.n ?? -1), expectedUnknownCount);

    const preOnly = await db.execute(sql`
      SELECT resource_key FROM x402_endpoints e
      WHERE e.status = 'active' AND e.resource_key = 't-post-empty.example/p'
      ${laneNetworkPrefilterSql({ chain: "arc_gateway", networkLike: "%" })}
    `);
    const preKeys = (Array.isArray(preOnly) ? preOnly : (preOnly as { rows?: unknown[] }).rows ?? []) as {
      resource_key: string;
    }[];
    assert.equal(preKeys.length, 0, "prefilter 単体でも POST+empty は返らない");

    const postEmptyIdRows = (await db.execute(
      sql`SELECT id::text AS id FROM x402_endpoints WHERE resource_key = 't-post-empty.example/p'`,
    )) as unknown;
    const idRows = (Array.isArray(postEmptyIdRows)
      ? postEmptyIdRows
      : (postEmptyIdRows as { rows?: { id: string }[] }).rows ?? []) as { id: string }[];
    const postEmptyId = idRows[0]!.id;
    const pinnedRaw = await db.execute(
      targetsSql(false, undefined, undefined, undefined, gatewayCandidateInclusionSql(), []),
    );
    const pinnedIds = (
      (Array.isArray(pinnedRaw) ? pinnedRaw : ((pinnedRaw as { rows?: unknown[] }).rows ?? [])) as { id: string }[]
    ).map((r) => String(r.id));
    assert.ok(!pinnedIds.includes(postEmptyId), "1 件指定の inclusion 経路でも POST+empty は返らない");

    const leakRaw = await db.execute(
      targetsSql(false, undefined, undefined, undefined, gatewayCandidateInclusionWithoutRequestShapeSql(), []),
    );
    const leakIds = (
      (Array.isArray(leakRaw) ? leakRaw : ((leakRaw as { rows?: unknown[] }).rows ?? [])) as { id: string }[]
    ).map((r) => String(r.id));
    assert.ok(leakIds.includes(postEmptyId), "inclusion から形を外すと POST+empty が 1 件指定で返る");

    const leakLane = await gwKeys(gwLane, gatewayCandidateInclusionWithoutRequestShapeSql(), false);
    assert.ok(leakLane.includes("t-post-empty.example/p"), "prefilter 無し + inclusion 形なしで POST+empty が漏れる");

    const laneNoPre = await gwKeys(gwLane, gatewayCandidateInclusionSql(), false);
    assert.ok(!laneNoPre.includes("t-post-empty.example/p"), "inclusion だけでも POST+empty は漏れない");

    const arcLane = { chain: "arc" as const, networkLike: CHAIN_DAILY_CAPS.arc.networkLike, limit: 40 };
    const arcQ = l1TargetsSqlBuilders(ctx).targetsSql(false, arcLane);
    const arcRaw = await db.execute(arcQ);
    const arcList = (Array.isArray(arcRaw) ? arcRaw : (arcRaw as { rows?: unknown[] }).rows ?? []) as { id: string }[];
    const arcIdList = arcList.map((r) => sql`${r.id}::uuid`);
    const arcNames = await db.execute(sql`
      SELECT resource_key FROM x402_endpoints WHERE id IN (${sql.join(arcIdList, sql`, `)})
    `);
    const arcKeys = ((Array.isArray(arcNames) ? arcNames : (arcNames as { rows?: unknown[] }).rows ?? []) as {
      resource_key: string;
    }[]).map((r) => r.resource_key);
    assert.ok(arcKeys.includes("arc-native-post-empty.example/p"), "Arc レーンは POST 本文不明のまま");

    await db.execute(sql`TRUNCATE x402_l1_purchases`);
    const signUrl = "https://gw-sign-skip.example/p";
    await db.execute(sql`
      INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, raw_accepts, declared_input, status, quality_payers_30d, quality_calls_30d, first_seen_at)
      VALUES ('gw-sign-skip.example/p', ${signUrl}, 'POST', ${ARC}, ${GW_PAYTO}, '1000',
              ${JSON.stringify([gw])}::jsonb, ${JSON.stringify({ query: "empty", body: "declared" })}::jsonb, 'active', 1, 1, now())
    `);
    await db.execute(sql`
      INSERT INTO x402_l0_probes (endpoint_id, method, verdict)
      SELECT id, 'GET', 'pass' FROM x402_endpoints WHERE resource_url = ${signUrl}
    `);
    const signIdRaw = await db.execute(sql`SELECT id::text AS id FROM x402_endpoints WHERE resource_url = ${signUrl}`);
    const signId = ((Array.isArray(signIdRaw) ? signIdRaw : (signIdRaw as { rows?: unknown[] }).rows ?? []) as { id: string }[])[0]
      ?.id;
    assert.ok(signId);

    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    process.env.ARC_RPC_URL = "http://127.0.0.1:9/gw-post-body-test";
    let signCalls = 0;
    const challenge402 = JSON.stringify({ x402Version: 2, accepts: [gw] });
    const summary = await runL1Batch({
      limit: 5,
      onlyEndpointId: signId,
      fetchImpl: async () =>
        new Response(challenge402, { status: 402, headers: { "content-type": "application/json" } }),
      getPayerUsdcBalance: async () => 5_000_000n,
      readArcGatewayAvailable: async () => 5_000_000n,
      signArcGateway: async () => {
        signCalls++;
        throw new Error("must not sign");
      },
    });
    assert.equal(signCalls, 0, "Gateway POST で live 402 が本文を宣言していないとき署名しない");
    assert.equal(summary.gatewayPostBodyUnknownSignSkipped, 1);
    const purchaseRows = await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases WHERE endpoint_id = ${signId}::uuid`);
    const pn = (
      (Array.isArray(purchaseRows) ? purchaseRows : ((purchaseRows as { rows?: unknown[] }).rows ?? [])) as { n: number }[]
    )[0]?.n;
    assert.equal(Number(pn), 0, "見送りでは行を書かない");
  });
}
