// ============================================================
// レーン枠の前置きの絞り込み（laneNetworkPrefilterSql・2026-10-27）は、選ぶ行も並びも変えない。
//
// 本番の読み取り（EXPLAIN ANALYZE・2026-10-27）: secondary の枝を持つレーンと Gateway の取得は、active の
// 約 7.7 万行すべてで raw_accepts を jsonb_array_elements に展開してから捨てていた（1 本 0.5〜1.2 秒）。
// 前置きの絞り込みはレーンの条件から導ける弱い条件（主ネットワークの一致、または raw_accepts @> その network）だけ。
//
// 守ること: 全レーン（Solana・Arc・Gateway・Tempo・XRPL・Celo・BNB・Arbitrum・Avalanche・Stellar）で、
// daily / 生行だけの両方の文について、絞り込みを足した文と足さない文が同じ id を同じ順に返す。
// 種は、絞り込みが落とすべき行（別のチェーンだけ・大文字の network・数の network・配列でない raw_accepts・
// raw_accepts が NULL）と、残すべき行（主ネットワーク・2 番目の accept・資産違い・Gateway だけ・version が数）を混ぜる。
// Celo・Avalanche はホスト幅の包み（試行数・7 日の未入金の集計）を通る文なので、試行の行も入れる。
//
// Run: TEST_DATABASE_URL=postgres:///vet402_test_setup \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-lane-prefilter.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 lane prefilter (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("レーン枠の前置きの絞り込みは、全レーンで選ぶ行と並びを変えない", async (t) => {
    const { l1TargetsSqlBuilders, laneNetworkPrefilterSql } = await import("@/lib/observatory/l1-runner");
    const { CHAIN_DAILY_CAPS } = await import("@/lib/observatory/budget");
    const { gatewayCandidateInclusionSql, ARC_GATEWAY_WALLET } = await import("@/lib/observatory/arc-gateway");
    const { BASE_USDC, ARC_USDC, CELO_CHAIN, BNB_CHAIN, ARBITRUM_CHAIN, AVALANCHE_CHAIN } = await import("@/lib/observatory/x402-payer");
    const { RLUSD_CURRENCY_HEX, RLUSD_ISSUER } = await import("@/lib/observatory/xrpl-constants");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const savedGateway = process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED;
    process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = "true";
    t.after(() => {
      if (savedGateway === undefined) delete process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED;
      else process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = savedGateway;
    });

    const BASE = "eip155:8453";
    const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
    const STELLAR_USDC = "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const baseAccept = (n: number) => ({ scheme: "exact", network: BASE, asset: BASE_USDC, payTo: `0x${String(n).padStart(40, "a")}`, amount: "1000" });
    // レーンごとに、レーンの資産の条件（LANE_SECONDARY_ACCEPT_FILTER）を通る accept と通らない accept。
    const lanes: Record<string, { network: string; good: Record<string, unknown>; bad: Record<string, unknown> }> = {
      arc: { network: "eip155:5042", good: { asset: ARC_USDC }, bad: { asset: ARC_USDC, extra: { name: "GatewayWalletBatched" } } },
      tempo: { network: "eip155:4217", good: { asset: "0x20c0000000000000000000000000000000000000" }, bad: { asset: "x" } },
      xrpl: { network: "xrpl:0", good: { asset: RLUSD_CURRENCY_HEX, extra: { issuer: RLUSD_ISSUER } }, bad: { asset: "XRP" } },
      celo: { network: "eip155:42220", good: { asset: CELO_CHAIN.usdc }, bad: { asset: "0xdead" } },
      bnb: { network: "eip155:56", good: { asset: BNB_CHAIN.usdc, extra: { assetTransferMethod: "eip3009" } }, bad: { asset: BNB_CHAIN.usdc, extra: { assetTransferMethod: "permit2" } } },
      arbitrum: { network: "eip155:42161", good: { asset: ARBITRUM_CHAIN.usdc }, bad: { asset: ARBITRUM_CHAIN.usdc, extra: { assetTransferMethod: "permit2" } } },
      avalanche: { network: "eip155:43114", good: { asset: AVALANCHE_CHAIN.usdc.toUpperCase().replace("0X", "0x") }, bad: { asset: AVALANCHE_CHAIN.usdc, extra: { name: "GatewayWalletBatched" } } },
      stellar: { network: "stellar:pubnet", good: { asset: STELLAR_USDC }, bad: { asset: "native" } },
      solana: { network: SOL, good: { asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, bad: { asset: "x" } },
    };
    const gatewayAccept = (version: unknown) => ({
      scheme: "exact",
      network: "eip155:5042",
      asset: ARC_USDC,
      payTo: "0x" + "9".repeat(40),
      amount: "1000",
      extra: { name: "GatewayWalletBatched", version, verifyingContract: ARC_GATEWAY_WALLET },
    });

    type Row = { key: string; network: string | null; accepts: unknown };
    const rows: Row[] = [];
    let n = 0;
    for (const [chain, l] of Object.entries(lanes)) {
      const acc = (extra: Record<string, unknown>) => ({ scheme: "exact", network: l.network, payTo: `0x${String(++n).padStart(40, "b")}`, amount: "1000", ...extra });
      // 残すべき行
      for (let i = 0; i < 3; i++) rows.push({ key: `${chain}-primary-${i}.example/p`, network: l.network, accepts: [acc(l.good)] });
      for (let i = 0; i < 3; i++) rows.push({ key: `${chain}-second-${i}.example/s`, network: BASE, accepts: [baseAccept(n), acc(l.good)] });
      rows.push({ key: `${chain}-second-bad.example/s`, network: BASE, accepts: [baseAccept(n), acc(l.bad)] });
      rows.push({ key: `${chain}-primary-nonarray.example/p`, network: l.network, accepts: { network: l.network } });
      // 絞り込みが落とすべき行
      rows.push({ key: `${chain}-upper.example/u`, network: BASE, accepts: [baseAccept(n), acc({ ...l.good, network: l.network.toUpperCase() })] });
      rows.push({ key: `${chain}-object.example/o`, network: BASE, accepts: { network: l.network } });
    }
    rows.push({ key: "num-network.example/n", network: BASE, accepts: [baseAccept(900), { network: 43114 }] });
    rows.push({ key: "null-accepts.example/n", network: BASE, accepts: null });
    rows.push({ key: "null-network.example/n", network: null, accepts: [baseAccept(901)] });
    rows.push({ key: "string-accepts.example/n", network: BASE, accepts: "eip155:43114" });
    // Gateway: Gateway だけ（version は文字列 / 数）、Base でも買える Gateway、network の綴り違い
    rows.push({ key: "gw-only.example/g", network: "eip155:5042", accepts: [gatewayAccept("1")] });
    rows.push({ key: "gw-only-numver.example/g", network: "eip155:5042", accepts: [gatewayAccept(1)] });
    rows.push({ key: "gw-base.example/g", network: BASE, accepts: [baseAccept(902), gatewayAccept("1")] });
    rows.push({ key: "gw-slug.example/g", network: "arc", accepts: [{ ...gatewayAccept("1"), network: "arc" }] });
    // 同じホストに出品を多く（Celo・Avalanche のホスト幅の包みが効く形）
    for (let i = 0; i < 4; i++) {
      rows.push({ key: `wide-host.example/avax${i}`, network: BASE, accepts: [baseAccept(903 + i), { scheme: "exact", network: "eip155:43114", asset: AVALANCHE_CHAIN.usdc, payTo: "0x" + "c".repeat(40), amount: "1000" }] });
      rows.push({ key: `wide-host.example/celo${i}`, network: BASE, accepts: [baseAccept(910 + i), { scheme: "exact", network: "eip155:42220", asset: CELO_CHAIN.usdc, payTo: "0x" + "d".repeat(40), amount: "1000" }] });
    }

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases`);
    for (const [i, r] of rows.entries()) {
      await db.execute(sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, raw_accepts, status, quality_payers_30d, quality_calls_30d, first_seen_at)
        VALUES (${r.key}, ${"https://" + r.key}, 'GET', ${r.network}, ${"0x" + String(i + 1).padStart(40, "e")}, '1000',
                ${r.accepts === null ? null : JSON.stringify(r.accepts)}::jsonb, 'active', ${i % 5}, ${i % 7}, now() - make_interval(days => ${i}))
      `);
    }
    await db.execute(sql`INSERT INTO x402_l0_probes (endpoint_id, method, verdict) SELECT id, 'GET', 'pass' FROM x402_endpoints`);
    // Celo・Avalanche の試行（ホスト幅の包みの集計に入る）と、7 日以内の支払い前の終わり。
    await db.execute(sql`
      INSERT INTO x402_l1_purchases (endpoint_id, network, status, attempted_at)
      SELECT id, 'eip155:43114', 'settled', now() - interval '10 days' FROM x402_endpoints WHERE resource_key LIKE 'avalanche-second-0%'
      UNION ALL
      SELECT id, 'eip155:42220', 'settle_failed', now() - interval '10 days' FROM x402_endpoints WHERE resource_key LIKE 'celo-second-1%'
      UNION ALL
      SELECT id, NULL, 'no_402', now() - interval '2 days' FROM x402_endpoints WHERE resource_key LIKE 'wide-host.example/avax0'
    `);

    const ctx = { limit: 100, laneExclusions: [], firstPurchasesSelectable: true, censusFirstSelectable: true };
    const withPre = l1TargetsSqlBuilders(ctx);
    const without = l1TargetsSqlBuilders({ ...ctx, lanePrefilter: false });
    const ids = async (q: ReturnType<typeof withPre.targetsSql>) => {
      const raw = await db.execute(q);
      const list = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { id: string }[];
      return list.map((r) => String(r.id));
    };

    const chains = ["solana", "arc", "arc_gateway", "tempo", "xrpl", "celo", "bnb", "arbitrum", "avalanche", "stellar"] as const;
    let nonEmpty = 0;
    for (const chain of chains) {
      for (const daily of [true, false]) {
        for (const limit of [3, 40]) {
          const lane =
            chain === "arc_gateway"
              ? { chain, networkLike: "%", limit }
              : { chain, networkLike: CHAIN_DAILY_CAPS[chain].networkLike, limit };
          const build = (b: typeof withPre) =>
            chain === "arc_gateway"
              ? b.targetsSql(daily, lane, undefined, undefined, gatewayCandidateInclusionSql(), [])
              : b.targetsSql(daily, lane);
          const a = await ids(build(withPre));
          const b = await ids(build(without));
          assert.deepEqual(a, b, `${chain} daily=${daily} limit=${limit}: 同じ id を同じ順に返す`);
          if (a.length > 0) nonEmpty++;
        }
      }
    }
    assert.equal(nonEmpty, chains.length * 4, "どのレーンも行を返す（空どうしの比較で通っていない）");

    // 絞り込みが実際に掛かっていること（掛かっていなければこの試験は何も確かめていない）。
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const text = (q: ReturnType<typeof laneNetworkPrefilterSql>) => new PgDialect().sqlToQuery(q).sql;
    assert.match(text(laneNetworkPrefilterSql({ chain: "avalanche", networkLike: "eip155:43114" })), /raw_accepts @> \$\d+::jsonb/);
    assert.match(text(laneNetworkPrefilterSql({ chain: "arc_gateway", networkLike: "%" })), /raw_accepts @> \$\d+::jsonb/);
    assert.equal(text(laneNetworkPrefilterSql({ chain: "solana", networkLike: "solana:%" })), "", "ワイルドカードのレーンには足さない");
    assert.equal(text(laneNetworkPrefilterSql({ chain: "tempo", networkLike: "eip155:4217" })), "", "secondary の枝の無いレーンには足さない");

    // 絞り込みだけを掛けたとき、落とすべき行（大文字・配列でない・別チェーンだけ）が落ちていること。
    const pre = async (chain: "avalanche" | "celo" | "arc_gateway", networkLike: string) => {
      const raw = await db.execute(sql`SELECT e.resource_key FROM x402_endpoints e WHERE true ${laneNetworkPrefilterSql({ chain, networkLike })} ORDER BY 1`);
      // 並びは JS で決める。SQL の ORDER BY は照合順序（CI の en_US と手元の C）で '-' と '.' の順が変わる。
      return ((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { resource_key: string }[])
        .map((r) => r.resource_key)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    };
    const avax = await pre("avalanche", "eip155:43114");
    assert.ok(avax.includes("avalanche-second-0.example/s"));
    assert.ok(avax.includes("avalanche-primary-nonarray.example/p"), "主ネットワークが一致すれば raw_accepts の形を問わない");
    assert.ok(!avax.includes("avalanche-upper.example/u"));
    assert.ok(!avax.includes("avalanche-object.example/o"));
    assert.ok(!avax.includes("num-network.example/n"));
    assert.ok(!avax.includes("celo-second-0.example/s"));
    const gw = await pre("arc_gateway", "%");
    // arc-second-bad は Gateway の accept（scheme exact・eip155:5042・GatewayWalletBatched）を 2 番目に持つ行。絞り込みは
    // 弱い条件なので残し、出品の条件（existsGateway の資産・version・verifyingContract）が後で落とす。綴り違い（arc）は落ちる。
    assert.deepEqual(gw, ["arc-second-bad.example/s", "gw-base.example/g", "gw-only-numver.example/g", "gw-only.example/g"].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
}
