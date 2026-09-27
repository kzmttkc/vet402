// ============================================================
// 売り手の census（全員 1 回ずつ）レーン（2026-09-28）— SQL の選び方と、購入の経路。
//
// 守ること:
//  1. 旗（OBSERVATORY_L1_CENSUS=on）が無い日は何も変わらない: 支払い付きの順番は従来どおり、
//     summary.censusCandidates=0・censusRemaining=null、行に selection の印は無い。
//  2. 旗が on の日: L1 の購入行が 1 件も無い Base のホストだけが、1 ホスト 1 件（そのホストで
//     いちばん安い出品・同額なら id の小さい方）、安い順に、レーン枠の**後ろ**・主候補の**前**で買われる。
//     試し済みのホスト（別の出品に行があるだけでも）は選ばない。$1 を超える出品は選ばない。
//  3. レーン枠（Solana）は削られない。主候補の LIMIT も減らない。
//  4. census の行は raw_response_meta.selection = "census" を持つ。census でない行は持たない。
//  5. 既存の関門はそのまま効く: 日次 $25 を使い切った日は署名しない（budget_denied）、購入元の
//     残高が無ければ署名しない。
//  6. 2 回目のバッチでは、買ったホストは census から外れる（全員 1 回ずつ）。
//  7. （独立レビュー 2026-09-28）並びは「レーン枠 → 優先ホスト → census → 主候補の残り」（W1）。
//     「最安」は払う額＝price_amount で決め、raw_accepts の別の安い accept では並べない。price_amount が
//     null の行（v1 の maxAmountRequired だけ）は選ばない（W2）。ポート違いは 1 売り手（試し済みの判定も）。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_census_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-census.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const FUNDED_PAYER = async () => 1_000_000_000n;
const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 census (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const SOL_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const FEE_PAYER = "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd";
  const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
  const MAIN_HOSTS = 12;
  const SOL_COUNT = 3;

  test("L1 census lane", async (t) => {
    const { Keypair } = await import("@solana/web3.js");
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");

    const db = getDb()!;
    const rowsOf = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
    const solPayTo = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(70 + n)).publicKey.toBase58();
    const solKeypair = Keypair.fromSeed(new Uint8Array(32).fill(9));

    const KEYS = [
      "OBSERVATORY_L1_ENABLED",
      "OBSERVATORY_WALLET_PRIVATE_KEY",
      "OBSERVATORY_SOLANA_L1_ENABLED",
      "OBSERVATORY_SOLANA_SECRET_KEY",
      "OBSERVATORY_ARC_L1_ENABLED",
      "OBSERVATORY_TEMPO_L1_ENABLED",
      "L1_SOLANA_DAILY_CAP_USD",
      "L1_LANE_FLOOR_PER_RUN",
      "OBSERVATORY_L1_CENSUS",
    ] as const;
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    t.after(() => {
      for (const k of KEYS) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    const arm = (census: boolean) => {
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      process.env.OBSERVATORY_SOLANA_L1_ENABLED = "true";
      process.env.OBSERVATORY_SOLANA_SECRET_KEY = Buffer.from(solKeypair.secretKey).toString("base64");
      delete process.env.OBSERVATORY_ARC_L1_ENABLED;
      delete process.env.OBSERVATORY_TEMPO_L1_ENABLED;
      delete process.env.L1_SOLANA_DAILY_CAP_USD;
      delete process.env.L1_LANE_FLOOR_PER_RUN;
      if (census) process.env.OBSERVATORY_L1_CENSUS = "on";
      else delete process.env.OBSERVATORY_L1_CENSUS;
    };

    // 売り手（URL → 壁の値段と受取先）。壁はカタログと同じ額を出す（price_mismatch にしない）。
    type Listing = {
      url: string;
      amount: string;
      payTo: string;
      network: string;
      asset: string;
      demand: "high" | "low";
      /** カタログに載せる accepts（省略時は壁と同じ 1 件）。 */
      catalogAccepts?: Record<string, unknown>[];
    };
    const listings: Listing[] = [];
    const add = (url: string, amount: string, n: number, demand: "high" | "low" = "low") =>
      listings.push({ url, amount, payTo: `0x${(n % 16).toString(16).repeat(40)}`, network: "eip155:8453", asset: BASE_USDC, demand });

    // 試し済みの Base ホスト（/old に行がある）。/api は需要が高い未購入の主候補。
    for (let i = 1; i <= MAIN_HOSTS; i++) {
      add(`https://main${i}.example/old`, "3000", i, "high");
      add(`https://main${i}.example/api`, "3000", i, "high");
    }
    // 未試行の Base ホスト（需要が低い＝旗が無ければ主候補 LIMIT 10 に入らない）。
    add("https://censusa.example/p3", "5000", 1);
    add("https://censusa.example/p1", "2000", 2);
    add("https://censusa.example/p2", "2000", 3);
    add("https://censusd.example/only", "1000", 4);
    // $1 を超える出品しか無いホスト（選ばない）。
    add("https://censusc.example/pricey", "2000000", 5);
    // 別の出品に行があるだけのホスト（試し済み＝選ばない）。
    add("https://triedb.example/old", "500", 6);
    add("https://triedb.example/new", "500", 7);
    // 優先ホスト（PRIORITY_SELLER_HOSTS）。/old は試し済み、/search は需要の高い未購入（W1）。
    add("https://x402.tavily.com/old", "3000", 8, "high");
    add("https://x402.tavily.com/search", "3000", 8, "high");
    // 払う額（accepts[0]＝price_amount）は 9000。2 番目に 10 の Base accept を宣言しているが、その額では払わない（W2）。
    add("https://censuse.example/two", "9000", 9);
    listings[listings.length - 1].catalogAccepts = [
      { amount: "9000", asset: BASE_USDC, network: "eip155:8453", payTo: listings[listings.length - 1].payTo },
      { amount: "10", asset: BASE_USDC, network: "eip155:8453", payTo: listings[listings.length - 1].payTo },
    ];
    // v1 の行（maxAmountRequired だけ・price_amount は null）。いちばん安く見えても選ばない（W2）。
    add("https://censusf.example/v1", "500", 10);
    listings[listings.length - 1].catalogAccepts = [
      { scheme: "exact", maxAmountRequired: "500", asset: BASE_USDC, network: "base", payTo: listings[listings.length - 1].payTo },
    ];
    // 出品の先頭が Base 以外（eip155:84532）で、2 番目に Base の USDC がある行。price_amount は先頭の額なので、
    // Base で買うと売り手に落ち度が無いのに price_mismatch が載る——census は選ばない（2026-09-28 レビュー）。
    add("https://censusg.example/sepolia-first", "100", 14);
    listings[listings.length - 1].catalogAccepts = [
      { amount: "100", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", network: "eip155:84532", payTo: listings[listings.length - 1].payTo },
      { amount: "100", asset: BASE_USDC, network: "eip155:8453", payTo: listings[listings.length - 1].payTo },
    ];
    // ポート違いの同じ売り手（1 売り手として 1 回だけ）と、ポート違いで試し済みの売り手（選ばない）。
    add("https://vg.example:4449/api", "3000", 11);
    add("https://vg.example:4450/api", "3000", 12);
    add("https://tp.example:4449/old", "3000", 13);
    add("https://tp.example:4450/api", "3000", 13);
    // Solana のレーン（需要が低い）。
    for (let i = 1; i <= SOL_COUNT; i++) {
      listings.push({ url: `https://solseller${i}.example/api`, amount: "4000", payTo: solPayTo(i), network: SOL_CAIP2, asset: SOL_USDC, demand: "low" });
    }
    const byUrl = new Map(listings.map((l) => [l.url, l]));
    const isSol = (url: string) => url.includes("solseller");
    const isCensusHost = (url: string) => /census[a-z]\.example|vg\.example/.test(url);
    const TAVILY = "https://x402.tavily.com/search";

    const challengeFor = (url: string) => {
      const l = byUrl.get(url)!;
      // 先頭が Base 以外の行（censusg）は、壁もカタログと同じ accepts を出す（L0 はそれで合格する）。
      if (l.catalogAccepts && l.catalogAccepts[0]?.network === "eip155:84532") {
        return JSON.stringify({
          x402Version: 2,
          accepts: l.catalogAccepts.map((a) => ({ scheme: "exact", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, ...a })),
        });
      }
      return JSON.stringify({
        x402Version: 2,
        accepts: [
          l.network === SOL_CAIP2
            ? { scheme: "exact", network: SOL_CAIP2, amount: l.amount, asset: SOL_USDC, payTo: l.payTo, maxTimeoutSeconds: 60, extra: { feePayer: FEE_PAYER } }
            : { scheme: "exact", network: "eip155:8453", amount: l.amount, asset: BASE_USDC, payTo: l.payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } },
        ],
      });
    };
    let txSeq = 0;
    const wall = () => {
      const seen: { url: string; paid: boolean }[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const paid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
        seen.push({ url, paid });
        if (!paid) return new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } });
        txSeq++;
        const sol = isSol(url);
        const tx = sol
          ? `5SoLSig${String(txSeq).padStart(6, "0")}${"ABCDEFGHJKLMNPQRSTUVWXYZ".repeat(4)}`.slice(0, 88)
          : `0x${txSeq.toString(16).padStart(64, "0")}`;
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({ success: true, transaction: tx, network: sol ? SOL_CAIP2 : "eip155:8453", payer: sol ? FEE_PAYER : "0x0000000000000000000000000000000000000001" }),
            ).toString("base64"),
          },
        });
      };
      const paidUrls = () => seen.filter((s) => s.paid).map((s) => s.url);
      return { seen, fetchImpl, paidUrls };
    };

    const idOf = async (url: string) => String(rowsOf(await db.execute(sql`SELECT id FROM x402_endpoints WHERE resource_url = ${url}`))[0].id);

    async function seed() {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      const items = listings.map((l) =>
        parseCatalogItem({
          resource: l.url,
          accepts: l.catalogAccepts ?? [{ amount: l.amount, asset: l.asset, network: l.network, payTo: l.payTo }],
          extensions: { bazaar: { info: { input: { method: "GET" } } } },
          quality: l.demand === "high" ? { l30DaysTotalCalls: 5000, l30DaysUniquePayers: 500 } : { l30DaysTotalCalls: 10, l30DaysUniquePayers: 1 },
        }),
      );
      await syncCatalog({ fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true }, today: "2026-09-28" });
      await runL0ProbeBatch({
        limit: 200,
        concurrency: 4,
        fetchImpl: async (url: string) => new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } }),
      });
      // 試し済みの印: /old の各出品に、窓の中の決済済み行（支出 0——当日の予算を食わせない）。
      for (const l of listings.filter((x) => x.url.endsWith("/old"))) {
        await db.insert(schema.x402L1Purchases).values({
          endpointId: await idOf(l.url),
          status: "settled",
          payer: "0x0000000000000000000000000000000000000001",
          network: "eip155:8453",
          asset: BASE_USDC,
          payTo: l.payTo,
          amountUnits: l.amount,
          spentUnits: "0",
        });
      }
    }

    const run = (w: ReturnType<typeof wall>, extra: Record<string, unknown> = {}) =>
      runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 10, getSolanaBlockhash: async () => BLOCKHASH, fetchImpl: w.fetchImpl, ...extra });

    const selectionRows = async () =>
      rowsOf(
        await db.execute(sql`
          SELECT e.resource_url, pu.status, pu.raw_response_meta->>'selection' AS selection
          FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
          WHERE pu.attempted_at >= now() - interval '1 hour' AND e.resource_url NOT LIKE '%/old'
        `),
      );

    await t.test("旗が無い日: 従来どおり（census の出品は買わない・summary は 0 と null・印なし）", async () => {
      arm(false);
      await seed();
      const w = wall();
      const summary = await run(w);
      const paid = w.paidUrls();
      assert.deepEqual(paid.slice(0, SOL_COUNT).map(isSol), [true, true, true], "レーン枠が先頭");
      assert.equal(paid.filter((u) => !isSol(u)).length, 10, "主候補 LIMIT 10");
      assert.ok(paid.every((u) => !isCensusHost(u)), `需要の低い未試行ホストは主候補に入らない: ${paid.join(", ")}`);
      assert.equal(summary.censusCandidates, 0);
      assert.equal(summary.censusRemaining, null);
      assert.ok((await selectionRows()).every((r) => r.selection === null), "selection の印は無い");
    });

    await t.test("旗が on: 未試行の Base ホストを 1 件ずつ・最安で・レーン枠の後ろ・主候補の前に買う", async () => {
      arm(true);
      await seed();
      const p1 = await idOf("https://censusa.example/p1");
      const p2 = await idOf("https://censusa.example/p2");
      const expectedA = p1 < p2 ? "https://censusa.example/p1" : "https://censusa.example/p2";
      const w = wall();
      const summary = await run(w);
      const paid = w.paidUrls();
      const vgPaid = paid.filter((u) => u.includes("vg.example"));
      assert.deepEqual(paid.slice(0, SOL_COUNT).map(isSol), [true, true, true], "レーン枠は削られず先頭のまま");
      assert.equal(paid[SOL_COUNT], TAVILY, `優先ホストはレーン枠の直後・census より前（W1）: ${paid.slice(0, 8).join(", ")}`);
      assert.equal(vgPaid.length, 1, `ポート違い（:4449 / :4450）は 1 売り手として 1 回だけ: ${vgPaid.join(", ")}`);
      assert.deepEqual(
        paid.slice(SOL_COUNT + 1, SOL_COUNT + 5),
        ["https://censusd.example/only", expectedA, vgPaid[0], "https://censuse.example/two"],
        "census は払う額の安い順（1000 → 2000 → 3000 → 9000）。censuse は 2 番目の accept の 10 ではなく price_amount の 9000 で並ぶ（W2）",
      );
      assert.equal(paid.filter(isCensusHost).length, 4, "1 ホスト 1 件。$1 超の censusc と price_amount の無い censusf は選ばない");
      assert.ok(!paid.includes("https://censusf.example/v1"), "price_amount が null の v1 行は census に入らない（W2）");
      assert.ok(!paid.includes("https://censusg.example/sepolia-first"), "出品の先頭が Base 以外の行は census に入らない（最安の 100 でも）");
      const gL0 = rowsOf(
        await db.execute(sql`SELECT verdict FROM x402_l0_probes WHERE endpoint_id = ${await idOf("https://censusg.example/sepolia-first")}::uuid ORDER BY probed_at DESC LIMIT 1`),
      );
      assert.equal(gL0[0]?.verdict, "pass", "除外は L0 のせいではない（L0 は合格している）");
      assert.ok(!paid.some((u) => u.includes("triedb.example")), "別の出品に行があるホストは選ばない");
      assert.ok(!paid.some((u) => u.includes("tp.example")), "ポート違いの出品に行があるホストも試し済み（選ばない）");
      assert.equal(paid.filter((u) => !isSol(u) && !isCensusHost(u)).length, 10, "主候補の LIMIT 10 は減らない（優先ホストを含む）");
      assert.equal(summary.censusCandidates, 4);
      assert.equal(summary.censusRemaining, 7, "バッチ開始時の未購入 Base ホスト: censusa・c・d・e・f・g・vg（選べないものも含む）");
      assert.deepEqual(summary.laneFloor.solana, SOL_COUNT);

      const rows = await selectionRows();
      const census = rows.filter((r) => r.selection === "census").map((r) => String(r.resource_url)).sort();
      assert.deepEqual(
        census,
        ["https://censusd.example/only", expectedA, vgPaid[0], "https://censuse.example/two"].sort(),
        "census の行だけが selection=census を持つ",
      );
      const eRow = rowsOf(
        await db.execute(sql`SELECT pu.amount_units FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id WHERE e.resource_url = 'https://censuse.example/two'`),
      );
      assert.equal(String(eRow[0].amount_units), "9000", "払った額は並べた額と同じ price_amount（W2）");
      // 売り手の決済の主張まで（照合は settlement-verifier の仕事で、ここでは settle_claimed）。
      assert.ok(
        rows.filter((r) => r.selection === "census").every((r) => r.status === "settle_claimed"),
        JSON.stringify(rows.filter((r) => r.selection === "census")),
      );
    });

    await t.test("2 回目のバッチ: 買ったホストは census から外れる（全員 1 回ずつ）", async () => {
      arm(true);
      // 直前のサブテストの台帳を引き継ぐ（seed しない）。
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.censusCandidates, 0, "残りは $1 超の censusc・price_amount の無い censusf・先頭が Base でない censusg だけ");
      assert.equal(summary.censusRemaining, 3);
      // 試し済みになった censusa の残りの出品（p2・p3）は主候補として従来どおり需要順で買われうるが、
      // census の印は付かない（census は 1 ホスト 1 回）。
      const census = (await selectionRows()).filter((r) => r.selection === "census");
      assert.equal(census.length, 4, "印つきの行は 1 回目の 4 件のまま");
      assert.ok(!w.paidUrls().includes("https://censusd.example/only"), "同じ出品は窓のあいだ買い直さない");
    });

    await t.test("既存の関門はそのまま: 日次 $25 を使い切った日は census も署名しない", async () => {
      arm(true);
      await seed();
      await db.insert(schema.x402L1Purchases).values({
        endpointId: await idOf("https://main1.example/old"),
        status: "settled",
        payer: "0x0000000000000000000000000000000000000001",
        network: "eip155:8453",
        asset: BASE_USDC,
        payTo: listings[0].payTo,
        amountUnits: "25000000",
        spentUnits: "25000000",
      });
      const w = wall();
      const summary = await run(w);
      assert.equal(w.paidUrls().length, 0, "支払い付きの要求は 1 本も出ない");
      assert.equal(summary.censusCandidates, 4, "候補には入る（並びの補助）が、予算の関門で止まる");
      assert.ok(summary.budgetDenied >= 4);
      const census = (await selectionRows()).filter((r) => r.selection === "census");
      assert.equal(census.length, 4);
      assert.ok(census.every((r) => r.status === "budget_denied"), "記帳は従来どおり budget_denied（印つき）");
    });

    await t.test("既存の関門はそのまま: 購入元の残高が無ければ census も署名しない", async () => {
      arm(true);
      await seed();
      const w = wall();
      const summary = await run(w, { getPayerUsdcBalance: async () => 0n });
      assert.equal(w.paidUrls().length, 0);
      assert.ok(summary.payerUnfunded >= 4);
      assert.equal(summary.censusCandidates, 4);
    });

    await t.test("playground の 1 件指定（onlyEndpointId）では census を使わない", async () => {
      arm(true);
      await seed();
      const w = wall();
      const summary = await run(w, { onlyEndpointId: await idOf("https://main3.example/api") });
      assert.deepEqual(w.paidUrls(), ["https://main3.example/api"]);
      assert.equal(summary.censusCandidates, 0);
      assert.equal(summary.censusRemaining, null);
    });
  });
}
