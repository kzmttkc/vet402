// ============================================================
// 主候補の文（lazyPrimaryTargetsSql・2026-10-27）は、1 文の形と同じ id を同じ順に返す。
//
// 本番の読み取り（EXPLAIN ANALYZE・2026-10-27）: 1 文の形は、安い条件を通る約 7 万行のすべてで L0 の最新判定・
// Gateway の除外（raw_accepts）・C2 の判定（settlements）・購入表の副問い合わせを評価してから LIMIT していた。
// 新しい形は C2 以外の鍵で 1 回並べ、C2 の行と C2 でない行を別々に上から歩いて、歩いた行にだけ重い判定を掛ける。
//
// 守ること: daily / 生行だけの両方、初回購入の枠の開閉、Gateway の旗の両方の extraWhere、レーンの除外、1 件指定、
// いくつもの LIMIT で、新しい形（既定）と 1 文の形（primaryLazyWalk: false）が同じ id を同じ順に返す。
// 並びは SQL が id（uuid）まで決めるので照合順序に依存しない。
// 種は並びの全部の鍵に関わる: C2（生の決済・帰属なし・窓の外・block_time なし・集約表・endpoint_id が NULL の集約行・
// 鍵ありの問い合わせ 3 人 2 日／鍵 id の k1・2 人だけ）、未購入／購入あり、優先ホストと紛らわしいホスト、需要の NULL と同点、
// 最後の試行（NULL の attempted_at を含む）、初出の NULL と同点、id の同点決め。さらに条件側: L0（無し・最新 fail・古い pass）、
// スイープ窓（通常 6 日・成熟 30 日・優先 1 日）、冷却（3 連続の非決済）、売り手の日次上限、自己除外、http・パステンプレート・
// pay_to なし・mpp_directory、Gateway だけの出品。
//
// Run: TEST_DATABASE_URL=postgres:///vet402_test_primary \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-primary-lazy.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 primary lazy walk (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  test("主候補の新しい形は、1 文の形と同じ id を同じ順に返す", async (t) => {
    const saved = {
      gateway: process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED,
      operator: process.env.VET402_OPERATOR_PAYTO,
    };
    process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED = "true";
    const OPERATOR_PAY_TO = "0x" + "0f".repeat(20);
    process.env.VET402_OPERATOR_PAYTO = OPERATOR_PAY_TO;
    t.after(() => {
      for (const [k, v] of [
        ["OBSERVATORY_ARC_GATEWAY_L1_ENABLED", saved.gateway],
        ["VET402_OPERATOR_PAYTO", saved.operator],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    const { l1TargetsSqlBuilders } = await import("@/lib/observatory/l1-runner");
    const { gatewayCandidateInclusionSql, ARC_GATEWAY_WALLET } = await import("@/lib/observatory/arc-gateway");
    const { BASE_USDC, ARC_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { PgDialect } = await import("drizzle-orm/pg-core");
    const db = getDb()!;

    // 決まった種の乱数（mulberry32）。失敗したときに同じ表で再現できるように。
    let seed = 20261027;
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];

    const BASE = "eip155:8453";
    const ARC = "eip155:5042";
    const SOL = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
    const baseAccept = (payTo: string) => ({ scheme: "exact", network: BASE, asset: BASE_USDC, payTo, amount: "1000" });
    const gatewayAccept = { scheme: "exact", network: ARC, asset: ARC_USDC, payTo: "0x" + "9".repeat(40), amount: "1000", extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: ARC_GATEWAY_WALLET } };
    const hosts = ["api.exa.ai", "x402.twit.sh", "api.exa.aique.com", "x402.twit.shady.io", ...Array.from({ length: 14 }, (_, i) => `seller${i}.example`)];
    const seenAt = ["2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", "2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", null];
    const sharedPayTo = "0x" + "ab".repeat(20); // 当日の支出で売り手の上限に届く受取先

    await db.execute(sql`TRUNCATE x402_endpoints, x402_l0_probes, x402_l1_purchases, settlements, settlement_daily, decision_lookup_callers`);

    type Ep = { id: string; i: number };
    const eps: Ep[] = [];
    const N = 420;
    for (let i = 0; i < N; i++) {
      const host = pick(hosts);
      const key = `${host}/p${i}${rand() < 0.04 ? "/:id" : ""}`;
      const url = `${rand() < 0.04 ? "http" : "https"}://${key}`;
      const network = rand() < 0.1 ? ARC : rand() < 0.08 ? SOL : BASE;
      const payToRoll = rand();
      const payTo =
        payToRoll < 0.03 ? null : payToRoll < 0.05 ? "" : payToRoll < 0.07 ? OPERATOR_PAY_TO : payToRoll < 0.1 ? sharedPayTo : "0x" + String(i + 1).padStart(40, "e");
      const source = rand() < 0.04 ? "mpp_directory" : "cdp_bazaar";
      const status = rand() < 0.05 ? "inactive" : "active";
      const accepts = network === ARC && rand() < 0.6 ? [gatewayAccept] : rand() < 0.08 ? [baseAccept(payTo ?? "0x1"), gatewayAccept] : [baseAccept(payTo ?? "0x1")];
      const payers = pick([null, 0, 1, 1, 2, 5]);
      const calls = pick([null, 0, 3, 3, 10]);
      const raw = await db.execute(sql`
        INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, raw_accepts, status, source,
                                    quality_payers_30d, quality_calls_30d, first_seen_at)
        VALUES (${key}, ${url}, 'GET', ${network}, ${payTo}, '1000', ${JSON.stringify(accepts)}::jsonb, ${status}, ${source},
                ${payers}, ${calls}, ${pick(seenAt)}::timestamptz)
        RETURNING id
      `);
      const row = ((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { id: string }[])[0];
      eps.push({ id: String(row.id), i });
    }

    for (const ep of eps) {
      // L0: 無し・最新 pass・最新 fail（古い pass あり）・最新 pass（古い fail あり）
      const r = rand();
      if (r < 0.1) continue;
      if (r < 0.2) {
        await db.execute(sql`INSERT INTO x402_l0_probes (endpoint_id, method, verdict, probed_at) VALUES
          (${ep.id}, 'GET', 'pass', now() - interval '3 days'), (${ep.id}, 'GET', 'fail', now() - interval '1 day')`);
      } else if (r < 0.3) {
        await db.execute(sql`INSERT INTO x402_l0_probes (endpoint_id, method, verdict, probed_at) VALUES
          (${ep.id}, 'GET', 'fail', now() - interval '3 days'), (${ep.id}, 'GET', 'pass', now() - interval '1 day')`);
      } else {
        await db.execute(sql`INSERT INTO x402_l0_probes (endpoint_id, method, verdict, probed_at) VALUES (${ep.id}, 'GET', 'pass', now() - interval '2 days')`);
      }
    }

    let txn = 0;
    for (const ep of eps) {
      // 購入: 未購入（約 55%）、古い購入、窓の内の購入、成熟（settled 3 件）、冷却（3 連続の非決済）、attempted_at が NULL。
      const r = rand();
      const buy = async (status: string, ageDays: number | null, network: string = BASE) =>
        await db.execute(sql`INSERT INTO x402_l1_purchases (endpoint_id, network, status, attempted_at)
          VALUES (${ep.id}, ${network}, ${status}, ${ageDays === null ? null : sql`now() - make_interval(days => ${ageDays})`})`);
      if (r < 0.55) {
        // 未購入
      } else if (r < 0.7) {
        await buy("settled", pick([8, 12, 20, 40]));
      } else if (r < 0.76) {
        await buy("settled", pick([2, 4])); // 6 日の窓の内（優先ホストなら 1 日の窓の外）
      } else if (r < 0.84) {
        for (const age of [35, 33, 31]) await buy("settled", age);
        await buy("settled", pick([10, 20, 40])); // 成熟: 30 日の窓
      } else if (r < 0.9) {
        for (const age of [9, 8, 7]) await buy(pick(["settle_failed", "request_error", "delivered_no_receipt"]), age); // 冷却
      } else if (r < 0.95) {
        await buy("settle_failed", 15);
        await buy("settled", 9);
        await buy("no_402", null); // attempted_at が NULL の行
      } else {
        await buy("settle_failed", pick([7, 11]));
      }
      // C2: 生の決済（帰属あり・なし・窓の外・block_time なし）
      const s = rand();
      const settle = async (attribution: string, blockAgeDays: number | null, observedAgeDays = 1) => {
        txn++;
        await db.execute(sql`INSERT INTO settlements (chain, tx_hash, purchase_id, endpoint_id, attribution, source, block_time, observed_at)
          VALUES (${BASE}, ${"0xt" + txn}, ${BASE + ":0xt" + txn}, ${ep.id}, ${attribution}, 'chain_index',
                  ${blockAgeDays === null ? null : sql`now() - make_interval(days => ${blockAgeDays})`}, now() - make_interval(days => ${observedAgeDays}))`);
      };
      if (s < 0.12) await settle("confirmed", pick([1, 5, 20]));
      else if (s < 0.16) await settle("probable", 3);
      else if (s < 0.2) await settle("unmatched", 2);
      else if (s < 0.23) await settle("confirmed", 45, 45); // 窓の外
      else if (s < 0.26) await settle("confirmed", null, 4); // block_time なし・observed_at が窓の内
      // C2: 集約表（窓の内・窓の外・帰属なし）
      const d = rand();
      const daily = async (attribution: string, ageDays: number) =>
        await db.execute(sql`INSERT INTO settlement_daily (day, chain, wash_flag, source, attribution, endpoint_id, n, amount_sum)
          VALUES (((now() AT TIME ZONE 'UTC')::date - ${ageDays}::int), ${BASE}, 'none', 'chain_index', ${attribution}, ${ep.id}, 1, 1000)`);
      if (d < 0.08) await daily("confirmed", 10);
      else if (d < 0.11) await daily("confirmed", 40);
      else if (d < 0.14) await daily("unmatched", 5);
    }
    // endpoint_id が NULL の集約行（帰属あり・窓の内）。hashed の EXISTS が NULL を返さないことも同時に確かめる。
    await db.execute(sql`INSERT INTO settlement_daily (day, chain, wash_flag, source, attribution, endpoint_id, n, amount_sum)
      VALUES (((now() AT TIME ZONE 'UTC')::date - 2), ${BASE}, 'none', 'chain_index', 'confirmed', NULL, 1, 1000)`);
    // 専用の行（必ず候補に入る形）: 鍵ありの問い合わせ用 3 つと、並びの鍵が全部同じ 3 つ（id で決まる）。
    const plainEndpoint = async (key: string, payers: number) => {
      const payTo = "0x" + Buffer.from(key).toString("hex").slice(0, 40).padEnd(40, "c");
      const raw = await db.execute(sql`
        WITH ins AS (
          INSERT INTO x402_endpoints (resource_key, resource_url, method, network, pay_to, price_amount, raw_accepts, status, source,
                                      quality_payers_30d, quality_calls_30d, first_seen_at)
          VALUES (${key}, ${"https://" + key}, 'GET', ${BASE}, ${payTo}, '1000', ${JSON.stringify([baseAccept(payTo)])}::jsonb, 'active', 'cdp_bazaar',
                  ${payers}, 3, '2026-09-01T00:00:00Z')
          RETURNING id
        ), probe AS (
          INSERT INTO x402_l0_probes (endpoint_id, method, verdict) SELECT id, 'GET', 'pass' FROM ins
        )
        SELECT id FROM ins
      `);
      return String(((Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { id: string }[])[0].id);
    };
    // 鍵ありの問い合わせ: 3 人 2 日（C2）、鍵 id の k1（数えない）、2 人だけ（足りない）
    const [lk1, lk2, lk3] = [
      { id: await plainEndpoint("lookup-a.example/x", 0) },
      { id: await plainEndpoint("lookup-b.example/x", 0) },
      { id: await plainEndpoint("lookup-c.example/x", 0) },
    ];
    const tieIds: string[] = [];
    for (let k = 0; k < 3; k++) tieIds.push(await plainEndpoint(`tie.example/t${k}`, 2));
    for (const [ep, rows] of [
      [lk1, [["k2:a", 1], ["k2:b", 1], ["k2:c", 2]]],
      [lk2, [["k1:a", 1], ["k1:b", 1], ["k1:c", 2]]],
      [lk3, [["k2:a", 1], ["k2:b", 2]]],
    ] as const) {
      for (const [hash, ago] of rows) {
        await db.execute(sql`INSERT INTO decision_lookup_callers (endpoint_id, day, caller_hash) VALUES (${ep.id}, ((current_date - ${ago}::int))::text, ${hash})`);
      }
    }
    // 売り手の日次上限: 当日の支出が上限に届いた受取先（sharedPayTo の出品は全部外れる）。
    await db.execute(sql`INSERT INTO x402_l1_purchases (endpoint_id, network, status, attempted_at, pay_to, spent_units)
      VALUES (${eps[3].id}, ${BASE}, 'settled', now(), ${sharedPayTo}, '99000000')`);
    await db.execute(sql`ANALYZE`);

    const ids = async (q: ReturnType<ReturnType<typeof l1TargetsSqlBuilders>["targetsSql"]>) => {
      const raw = await db.execute(q);
      const list = (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as { id: string }[];
      return list.map((r) => String(r.id));
    };
    const text = (q: ReturnType<typeof sql>) => new PgDialect().sqlToQuery(q).sql;

    const solanaOut = sql`AND (e.network IS NULL OR e.network NOT LIKE ${"solana:%"})`;
    let compared = 0;
    let fullLength = 0;
    for (const daily of [true, false]) {
      for (const firstPurchasesSelectable of [true, false]) {
        for (const exclusions of [[], [solanaOut]]) {
          for (const limit of [1, 3, 10, 25, 60, 1000]) {
            const ctx = { limit, laneExclusions: exclusions, firstPurchasesSelectable, censusFirstSelectable: true };
            const lazy = l1TargetsSqlBuilders(ctx);
            const flat = l1TargetsSqlBuilders({ ...ctx, primaryLazyWalk: false });
            for (const [label, build] of [
              ["primaryExtra", (b: typeof lazy) => b.targetsSql(daily, undefined, undefined, undefined, b.primaryExtra)],
              ["default", (b: typeof lazy) => b.targetsSql(daily)],
              ["gatewayPinned", (b: typeof lazy) => b.targetsSql(daily, undefined, undefined, undefined, gatewayCandidateInclusionSql(), [])],
            ] as const) {
              const qa = build(lazy);
              const qb = build(flat);
              assert.match(text(qa), /l1_primary_cand/, "既定は新しい形");
              assert.doesNotMatch(text(qb), /l1_primary_cand/, "旗 false は 1 文の形");
              const a = await ids(qa);
              const b = await ids(qb);
              assert.deepEqual(a, b, `${label} daily=${daily} first=${firstPurchasesSelectable} excl=${exclusions.length} limit=${limit}`);
              compared++;
              if (label === "primaryExtra" && limit === 1000 && firstPurchasesSelectable && exclusions.length === 0) fullLength = b.length;
            }
          }
        }
      }
    }
    assert.equal(compared, 2 * 2 * 2 * 6 * 3);
    assert.ok(fullLength > 60, `LIMIT が効く数の候補がある（${fullLength}）`);

    // 1 件指定（playground）でも同じ。
    for (const daily of [true, false]) {
      const all = await ids(l1TargetsSqlBuilders({ limit: 1000, laneExclusions: [], firstPurchasesSelectable: true, censusFirstSelectable: true }).targetsSql(daily));
      for (const only of [all[0], all[all.length - 1], eps[5].id]) {
        const ctx = { limit: 100, onlyEndpointId: only, laneExclusions: [], firstPurchasesSelectable: true, censusFirstSelectable: true };
        const a = await ids(l1TargetsSqlBuilders(ctx).targetsSql(daily));
        const b = await ids(l1TargetsSqlBuilders({ ...ctx, primaryLazyWalk: false }).targetsSql(daily));
        assert.deepEqual(a, b, `onlyEndpointId daily=${daily}`);
      }
    }

    // 種が並びの全部の鍵に効いていること（効いていなければ比べた意味が無い）。1 文の形の先頭 1000 件で数える。
    const flatAll = l1TargetsSqlBuilders({ limit: 1000, laneExclusions: [], firstPurchasesSelectable: true, censusFirstSelectable: true, primaryLazyWalk: false });
    const order = await ids(flatAll.targetsSql(true, undefined, undefined, undefined, flatAll.primaryExtra));
    const facts = await db.execute(sql`
      SELECT e.id,
             EXISTS (SELECT 1 FROM settlements s WHERE s.endpoint_id = e.id AND s.attribution IN ('confirmed', 'probable')
                       AND (coalesce(block_time, observed_at) AT TIME ZONE 'UTC')::date > (now() AT TIME ZONE 'UTC')::date - 30)
               OR EXISTS (SELECT 1 FROM settlement_daily sd WHERE sd.endpoint_id = e.id AND sd.attribution IN ('confirmed', 'probable')
                       AND sd.day > (now() AT TIME ZONE 'UTC')::date - 30)
               OR e.id = ${lk1.id}::uuid AS c2,
             NOT EXISTS (SELECT 1 FROM x402_l1_purchases p WHERE p.endpoint_id = e.id) AS unbought,
             e.resource_key ILIKE 'api.exa.ai/%' OR e.resource_key ILIKE 'x402.twit.sh/%' AS priority,
             e.quality_payers_30d IS NULL AS payers_null,
             e.first_seen_at IS NULL AS seen_null
      FROM x402_endpoints e
    `);
    const byId = new Map(
      ((Array.isArray(facts) ? facts : ((facts as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[]).map((r) => [String(r.id), r]),
    );
    const got = order.map((id) => byId.get(id)!);
    const count = (k: string, v: boolean) => got.filter((r) => r[k] === v).length;
    for (const k of ["c2", "unbought", "priority", "payers_null", "seen_null"]) {
      assert.ok(count(k, true) > 0 && count(k, false) > 0, `${k} の両方の値が候補にある（${count(k, true)}/${count(k, false)}）`);
    }
    // C2 の行が先、その中で未購入が先（並びの先頭の 2 つの鍵が実際に効いている）。
    const firstNonC2 = got.findIndex((r) => r.c2 === false);
    assert.ok(firstNonC2 > 0 && got.slice(firstNonC2).every((r) => r.c2 === false), "C2 の行が全部先に並ぶ");
    assert.ok(got.slice(0, firstNonC2).some((r) => r.unbought === false), "C2 の中に購入ありの行がある");
    assert.ok(order.includes(lk1.id), "鍵ありの問い合わせ 3 人 2 日の行が候補にある");
    assert.equal(byId.get(lk1.id)!.c2, true);
    assert.equal(byId.get(lk2.id)!.c2, false);
    assert.ok(order.includes(lk3.id));
    // 並びの鍵が全部同じ 3 行は、id の小さい順に並ぶ（uuid の比較はバイト順＝小文字 16 進の文字列の順）。
    const tiePos = tieIds.map((id) => order.indexOf(id));
    assert.ok(tiePos.every((x) => x >= 0), "同点の 3 行が候補にある");
    const tieInOrder = [...tieIds].sort((x, y) => tiePos[tieIds.indexOf(x)] - tiePos[tieIds.indexOf(y)]);
    assert.deepEqual(tieInOrder, [...tieIds].sort(), "同点は id の順");
  });
}
