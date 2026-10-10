// ============================================================
// L1 の Celo レーン — フラグ・別枠・残高・受取先の関門（2026-10-10）。
//
// Celo mainnet（eip155:42220）は、Base と同じ EOA（OBSERVATORY_WALLET_PRIVATE_KEY）で EIP-3009 に署名する
// 3 本目の EVM レーン。Arc のレーン（l1-arc-lane.pg.test.ts・l1-arc-declared-payto.pg.test.ts）と同じ規律で守る:
//
//  1. OBSERVATORY_CELO_L1_ENABLED が "true" でなければ、Celo を主ネットワークにする売り手には 1 リクエストも
//     出さず、台帳に行を書かない。Celo の accept を 2 番目以降に持つ売り手は従来どおり Base で買う。
//  2. フラグが on なら Celo の USDC（0xcebA…118C）の accept で買い、行は network eip155:42220・asset は Celo の USDC。
//     署名の前に読む残高は **celo**（Base の残高で Celo の署名を通さない）。
//  3. その UTC 日の Celo の支出が別枠（既定 $2・L1_CELO_DAILY_CAP_USD）に届いたら Celo では 1 件も払わない。
//     L1_CELO_DAILY_CAP_USD=0 はフラグ on のままでも Celo を止める。
//  4. Celo の購入元残高が足りない／読めないなら署名せず、行も書かない。Base はそのまま買う。
//  5. 壁が Celo の accept に、カタログが宣言していない payTo・宣言と違う額・USDC 以外の資産を出したら Celo では払わない。
//  6. 売り手ごとの日次上限（L1_SELLER_DAILY_CAP_USD）は Celo の購入にも同じ 1 文で掛かる。
//
// 壁の形は 2026-10-10 に払わずに読んだ実物:
//   api.blockscout.com/42220/api/v2/addresses  Celo が先頭・Base が 2 番目・**payTo はチェーンごとに別**
//   agent402.tools/api/hash                    Base が先頭・Celo は後ろ・payTo は同じ
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-celo-lane.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 celo lane (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const CELO_CAIP2 = "eip155:42220";
  const BASE_CAIP2 = "eip155:8453";
  const CELO_USDC = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C";
  const CELO_USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
  /** blockscout 形: Celo の受取先と Base の受取先が別。 */
  const SCOUT_CELO_PAYTO = "0x242ba6d68ffeb4a098b591b32d370f973ff882b7";
  const SCOUT_BASE_PAYTO = "0xd441D9F4c59CB26253E2F0A7a62ac9cE7823b4b4";
  /** agent402 形: 全チェーン同じ受取先。 */
  const TOOLS_PAYTO = "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0";
  const ROGUE_PAYTO = "0x1111111111111111111111111111111111111111";
  const BASE_ONLY_PAYTO = "0x2222222222222222222222222222222222222222";
  /** 自己取引の検査用: 先頭（Base）の受取先は他人、Celo の受取先だけが運用者。 */
  const OPS_BASE_PAYTO = "0x4444444444444444444444444444444444444444";
  const OPS_CELO_PAYTO = "0x5555555555555555555555555555555555555555";

  const SCOUT_URL = "https://scout.example/42220/api/v2/addresses";
  const SCOUT2_URL = "https://scout.example/42220/api/v2/blocks";
  const TOOLS_URL = "https://tools.example/api/hash";
  const BASE_URL = "https://baseonly.example/api";
  const OPS_URL = "https://ops.example/api";

  test("L1 Celo lane", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;

    const ENV = [
      "OBSERVATORY_L1_ENABLED",
      "OBSERVATORY_WALLET_PRIVATE_KEY",
      "OBSERVATORY_CELO_L1_ENABLED",
      "OBSERVATORY_ARC_L1_ENABLED",
      "OBSERVATORY_SOLANA_L1_ENABLED",
      "OBSERVATORY_TEMPO_L1_ENABLED",
      "OBSERVATORY_XRPL_L1_ENABLED",
      "OBSERVATORY_L1_CENSUS",
      "L1_CELO_DAILY_CAP_USD",
      "L1_SELLER_DAILY_CAP_USD",
      "L1_DOMAIN_DAILY_CAP_USD",
      "L1_LANE_FLOOR_PER_RUN",
      "VET402_OPERATOR_PAYTO",
    ] as const;
    const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    t.after(() => {
      for (const k of ENV) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });
    for (const k of ENV) delete process.env[k];
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;

    const celoUsdc = (payTo: string, amount: string) => ({
      scheme: "exact", network: CELO_CAIP2, amount, asset: CELO_USDC, payTo, maxTimeoutSeconds: 60, extra: { name: "USDC", version: "2" },
    });
    const baseUsdc = (payTo: string, amount: string) => ({
      scheme: "exact", network: BASE_CAIP2, amount, asset: BASE_USDC, payTo, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" },
    });
    const celoUsdt = (payTo: string, amount: string) => ({
      scheme: "exact", network: CELO_CAIP2, amount, asset: CELO_USDT, payTo, maxTimeoutSeconds: 60, extra: { name: "Tether USD", version: "1", assetTransferMethod: "eip3009" },
    });

    /** カタログ（＝正直な壁）の accepts。 */
    const CATALOG: Record<string, unknown[]> = {
      [SCOUT_URL]: [celoUsdc(SCOUT_CELO_PAYTO, "2000"), baseUsdc(SCOUT_BASE_PAYTO, "2000")],
      [SCOUT2_URL]: [celoUsdc(SCOUT_CELO_PAYTO, "2000"), baseUsdc(SCOUT_BASE_PAYTO, "2000")],
      // Celo の USDT を USDC より前に置く——選ばれてはいけない資産が先にあっても USDC を選ぶこと。
      [TOOLS_URL]: [baseUsdc(TOOLS_PAYTO, "1000"), celoUsdt(TOOLS_PAYTO, "1000"), celoUsdc(TOOLS_PAYTO, "1000")],
      [BASE_URL]: [baseUsdc(BASE_ONLY_PAYTO, "3000")],
      [OPS_URL]: [baseUsdc(OPS_BASE_PAYTO, "1000"), celoUsdc(OPS_CELO_PAYTO, "1000")],
    };

    let txSeq = 0;
    /** 壁。`over` で URL ごとに「壁が出す accepts」をカタログと違うものに差し替えられる。 */
    const wall = (over: Record<string, unknown[]> = {}) => {
      const seen: { url: string; paid: boolean; accepted: Record<string, unknown> | null; authorization: Record<string, string> | null }[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const sig = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
        const decoded = sig
          ? (JSON.parse(Buffer.from(sig, "base64").toString("utf8")) as { accepted?: Record<string, unknown>; payload?: { authorization?: Record<string, string> } })
          : null;
        seen.push({ url, paid: sig !== null, accepted: decoded?.accepted ?? null, authorization: decoded?.payload?.authorization ?? null });
        if (!sig) {
          return new Response(JSON.stringify({ x402Version: 2, accepts: over[url] ?? CATALOG[url] ?? [] }), { status: 402, headers: { "content-type": "application/json" } });
        }
        txSeq += 1;
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({
                success: true,
                transaction: `0x${txSeq.toString(16).padStart(4, "0").repeat(16)}`,
                network: String(decoded?.accepted?.network ?? BASE_CAIP2),
                payer: "0x0000000000000000000000000000000000000001",
              }),
            ).toString("base64"),
          },
        });
      };
      const paid = (url?: string) => seen.filter((s) => s.paid && (url === undefined || s.url === url));
      const requests = (url: string) => seen.filter((s) => s.url === url);
      const paidOn = (network: string) => seen.filter((s) => s.paid && s.accepted?.network === network);
      return { seen, fetchImpl, paid, requests, paidOn };
    };

    async function seed(urls: string[] = [SCOUT_URL, TOOLS_URL, BASE_URL]) {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      const items = urls.map((resource) =>
        parseCatalogItem({
          resource,
          accepts: CATALOG[resource],
          extensions: { bazaar: { info: { input: { method: "GET" } } } },
          quality: { l30DaysTotalCalls: 100, l30DaysUniquePayers: 10 },
        }),
      );
      await syncCatalog({ fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true }, today: "2026-10-10" });
      await runL0ProbeBatch({
        limit: 10,
        concurrency: 2,
        fetchImpl: async (url: string) => new Response(JSON.stringify({ x402Version: 2, accepts: CATALOG[url] ?? [] }), { status: 402, headers: { "content-type": "application/json" } }),
      });
      // seed の前提を固定する: 主ネットワーク・pay_to・price_amount は先頭の accept。
      const raw = await db.execute(sql`SELECT resource_url, pay_to, network, price_amount FROM x402_endpoints ORDER BY resource_url`);
      const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { resource_url: string; pay_to: string; network: string; price_amount: string }[];
      const by = new Map(rows.map((r) => [r.resource_url, r]));
      if (urls.includes(SCOUT_URL)) {
        assert.deepEqual({ ...by.get(SCOUT_URL)! }, { resource_url: SCOUT_URL, pay_to: SCOUT_CELO_PAYTO, network: CELO_CAIP2, price_amount: "2000" });
      }
      if (urls.includes(TOOLS_URL)) {
        assert.deepEqual({ ...by.get(TOOLS_URL)! }, { resource_url: TOOLS_URL, pay_to: TOOLS_PAYTO.toLowerCase(), network: BASE_CAIP2, price_amount: "1000" });
      }
    }

    /** その UTC 日の Celo の支出を、無関係な endpoint の既存行として台帳に置く。 */
    async function spendCeloToday(units: number) {
      const raw = await db.execute(sql`SELECT id FROM x402_endpoints WHERE resource_url = ${BASE_URL}`);
      const list = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { id: string }[];
      await db.insert(schema.x402L1Purchases).values({
        endpointId: list[0].id,
        status: "settle_claimed",
        payer: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
        network: CELO_CAIP2,
        asset: CELO_USDC,
        payTo: "0x3333333333333333333333333333333333333333",
        amountUnits: String(units),
        spentUnits: String(units),
        // 当日ぶんとして数えるが、BASE_URL のスイープ窓には掛からない時刻にはできないので、Base の対照は別の検査で見る。
      });
    }

    const ledgerFor = async (resourceUrl: string) => {
      const raw = await db.execute(sql`
        SELECT pu.status, pu.network, pu.asset, pu.pay_to, pu.spent_units FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE e.resource_url = ${resourceUrl} ORDER BY pu.attempted_at ASC`);
      return ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Record<string, string>[]).map((r) => ({
        status: r.status,
        network: r.network,
        asset: r.asset,
        pay_to: r.pay_to,
        spent_units: r.spent_units,
      }));
    };
    const celoSpent = async () => {
      const raw = await db.execute(sql`SELECT coalesce(sum(spent_units::numeric), 0)::text AS s FROM x402_l1_purchases WHERE network = ${CELO_CAIP2}`);
      return Number(((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { s: string }[])[0].s);
    };
    const FUNDED = async () => 1_000_000_000n;

    await t.test("フラグ off（既定）: Celo が主の売り手には 1 リクエストも出さず行も書かない。Base 先頭の売り手は Base で買う", async () => {
      await seed();
      const w = wall();
      const chains: string[] = [];
      const summary = await runL1Batch({
        limit: 10,
        fetchImpl: w.fetchImpl,
        getPayerUsdcBalance: async ({ chain }) => {
          chains.push(chain);
          return 1_000_000_000n;
        },
      });
      assert.equal(w.requests(SCOUT_URL).length, 0, "Celo が主の売り手へのリクエストは 0 本（無払いも含む）");
      assert.deepEqual(await ledgerFor(SCOUT_URL), [], "行を書かない");
      assert.equal(w.paidOn(CELO_CAIP2).length, 0, "Celo の accept には 1 件も署名しない");
      assert.equal(await celoSpent(), 0);
      assert.ok(!chains.includes("celo"), "Celo の残高も読まない");
      assert.equal(summary.laneFloor.celo ?? 0, 0, "レーン枠も問い合わせない");
      assert.equal(w.paid(TOOLS_URL)[0]?.accepted?.network, BASE_CAIP2, "Celo を後ろに持つ売り手は従来どおり Base");
      assert.ok(w.paid(BASE_URL).length === 1, "Base の候補は買う");
    });

    for (const value of ["1", "TRUE", "on"]) {
      await t.test(`フラグ ${JSON.stringify(value)} は off（"true" だけが on）`, async () => {
        await seed();
        process.env.OBSERVATORY_CELO_L1_ENABLED = value;
        const w = wall();
        await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
        assert.equal(w.requests(SCOUT_URL).length, 0);
        assert.equal(w.paidOn(CELO_CAIP2).length, 0);
        assert.equal(await celoSpent(), 0);
      });
    }

    await t.test("フラグ on: Celo が主の売り手を Celo の USDC で買い、行は eip155:42220・Celo USDC・宣言の payTo。残高は celo として読む", async () => {
      await seed([SCOUT_URL, BASE_URL]);
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      const w = wall();
      const chains: string[] = [];
      const summary = await runL1Batch({
        limit: 10,
        fetchImpl: w.fetchImpl,
        getPayerUsdcBalance: async ({ chain }) => {
          chains.push(chain);
          return 1_000_000_000n;
        },
      });
      const paid = w.paid(SCOUT_URL);
      assert.equal(paid.length, 1);
      assert.equal(paid[0].accepted?.network, CELO_CAIP2);
      assert.equal(paid[0].accepted?.asset, CELO_USDC);
      assert.equal(paid[0].accepted?.payTo, SCOUT_CELO_PAYTO);
      assert.equal(paid[0].accepted?.amount, "2000");
      // 署名した認可そのもの: 宛先は宣言の payTo・額は宣言の額。
      assert.equal(paid[0].authorization?.to, SCOUT_CELO_PAYTO);
      assert.equal(paid[0].authorization?.value, "2000");
      assert.deepEqual(await ledgerFor(SCOUT_URL), [
        { status: "settle_claimed", network: CELO_CAIP2, asset: CELO_USDC, pay_to: SCOUT_CELO_PAYTO, spent_units: "2000" },
      ]);
      assert.equal(await celoSpent(), 2000, "別枠 celo に載る");
      assert.ok(chains.includes("celo"), "Celo の残高を celo として読む");
      assert.ok(w.paid(BASE_URL).length === 1, "Base も買う");
      assert.ok(summary.settled >= 2);
    });

    await t.test("フラグ on: Base 先頭の売り手はレーン枠から Celo の USDC で買われる（USDT は選ばれない）。残高は celo だけを読む", async () => {
      await seed([TOOLS_URL]);
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      const w = wall();
      const chains: string[] = [];
      const summary = await runL1Batch({
        limit: 10,
        fetchImpl: w.fetchImpl,
        getPayerUsdcBalance: async ({ chain }) => {
          chains.push(chain);
          return 1_000_000_000n;
        },
      });
      assert.equal(summary.laneFloor.celo, 1, "レーン枠に載る");
      const paid = w.paid(TOOLS_URL);
      assert.equal(paid.length, 1);
      assert.equal(paid[0].accepted?.network, CELO_CAIP2);
      assert.equal(paid[0].accepted?.asset, CELO_USDC, "USDT が先に並んでいても USDC");
      assert.equal(paid[0].accepted?.payTo, TOOLS_PAYTO);
      assert.deepEqual(await ledgerFor(TOOLS_URL), [
        { status: "settle_claimed", network: CELO_CAIP2, asset: CELO_USDC, pay_to: TOOLS_PAYTO.toLowerCase(), spent_units: "1000" },
      ]);
      assert.deepEqual([...new Set(chains)], ["celo"], "Base では買っていないので Base の残高は読まない");
    });

    await t.test("L1_CELO_DAILY_CAP_USD=0: フラグ on のままでも Celo では 1 件も払わない", async () => {
      await seed();
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      process.env.L1_CELO_DAILY_CAP_USD = "0";
      try {
        const w = wall();
        await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
        assert.equal(w.requests(SCOUT_URL).length, 0, "Celo が主の売り手には触れない");
        assert.equal(w.paidOn(CELO_CAIP2).length, 0, "Celo の accept には 1 件も署名しない");
        assert.equal(await celoSpent(), 0);
        assert.deepEqual(await ledgerFor(SCOUT_URL), []);
        assert.equal(w.paid(TOOLS_URL)[0]?.accepted?.network, BASE_CAIP2, "Base 先頭の売り手は Base で買う");
        assert.ok(w.paid(BASE_URL).length === 1, "Base は買う");
      } finally {
        delete process.env.L1_CELO_DAILY_CAP_USD;
      }
    });

    await t.test("別枠を使い切った日は Celo では 1 件も払わない", async () => {
      await seed([SCOUT_URL, TOOLS_URL, BASE_URL]);
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      await spendCeloToday(2_000_000); // $2 ちょうど
      const w = wall();
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
      assert.equal(w.requests(SCOUT_URL).length, 0, "Celo が主の売り手には触れない");
      assert.equal(w.paidOn(CELO_CAIP2).length, 0);
      assert.equal(await celoSpent(), 2_000_000, "別枠ちょうどのまま");
      assert.deepEqual(await ledgerFor(SCOUT_URL), [], "行が無い＝翌日また選ばれる");
    });

    await t.test("別枠の残りが 1 件分に足りない: 予約で断り、行を書かず、支払い付きで出さない", async () => {
      await seed([SCOUT_URL, BASE_URL]);
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      await spendCeloToday(2_000_000 - 1999); // 残り 1999 units < 1 件 2000 units
      const w = wall();
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
      assert.equal(w.paidOn(CELO_CAIP2).length, 0, "Celo へ支払い付きのリクエストは出ない");
      assert.deepEqual(await ledgerFor(SCOUT_URL), [], "行が無い");
      assert.equal(await celoSpent(), 2_000_000 - 1999);
    });

    await t.test("別枠の残りがちょうど 1 件分なら 1 件だけ買え、当日の Celo の支出は別枠ちょうどで止まる", async () => {
      await seed([SCOUT_URL, SCOUT2_URL, BASE_URL]);
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      process.env.L1_SELLER_DAILY_CAP_USD = "25"; // この検査では売り手ごとの上限を効かせない（別枠だけを見る）
      process.env.L1_DOMAIN_DAILY_CAP_USD = "25";
      try {
        await spendCeloToday(2_000_000 - 2000);
        const w = wall();
        await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
        assert.equal(w.paidOn(CELO_CAIP2).length, 1, "2 件の候補のうち 1 件だけ");
        assert.equal(await celoSpent(), 2_000_000);
      } finally {
        delete process.env.L1_SELLER_DAILY_CAP_USD;
        delete process.env.L1_DOMAIN_DAILY_CAP_USD;
      }
    });

    await t.test("残高の関門: Celo の USDC が 0 なら署名せず行も書かない。Base の残高が十分でも Celo の署名は通らない", async () => {
      await seed();
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      const w = wall();
      const chains: string[] = [];
      const summary = await runL1Batch({
        limit: 10,
        fetchImpl: w.fetchImpl,
        getPayerUsdcBalance: async ({ chain }) => {
          chains.push(chain);
          return chain === "celo" ? 0n : 60_000_000n;
        },
      });
      assert.ok(chains.includes("celo"), "Celo の残高を celo として読む");
      assert.equal(w.paidOn(CELO_CAIP2).length, 0, "Celo へ支払い付きのリクエストは出ない");
      assert.ok(summary.payerUnfunded >= 1);
      assert.deepEqual(summary.payerFundsUnreadable, [], "足りないのであって、読めなかったのではない");
      assert.deepEqual(await ledgerFor(SCOUT_URL), [], "行を書かない（売り手の失敗として記録しない）");
      assert.equal(await celoSpent(), 0);
      assert.ok(w.paid(BASE_URL).length === 1, "Base は買う");
    });

    await t.test("残高が読めなければ署名しない（Celo の RPC が落ちていても Base は買う）", async () => {
      await seed();
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      const w = wall();
      const summary = await runL1Batch({
        limit: 10,
        fetchImpl: w.fetchImpl,
        getPayerUsdcBalance: async ({ chain }) => {
          if (chain === "celo") throw new Error("celo rpc down: https://forno.example/secret");
          return 60_000_000n;
        },
      });
      assert.equal(w.paidOn(CELO_CAIP2).length, 0);
      assert.deepEqual(summary.payerFundsUnreadable, ["celo"]);
      assert.deepEqual(await ledgerFor(SCOUT_URL), []);
      assert.ok(w.paid(BASE_URL).length === 1, "Base は買う");
    });

    await t.test("壁が Celo の accept に別の payTo を出したら払わない（Celo が主: payto_mismatch・支出 0）", async () => {
      await seed([SCOUT_URL]);
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      const w = wall({ [SCOUT_URL]: [celoUsdc(ROGUE_PAYTO, "2000")] });
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
      assert.equal(w.paid().length, 0, "署名しない");
      const rows = await ledgerFor(SCOUT_URL);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "payto_mismatch");
      assert.equal(await celoSpent(), 0);
    });

    await t.test("壁が Celo の accept にカタログの Base の payTo を出しても払わない（受取先の宣言はチェーンごと）", async () => {
      await seed([SCOUT_URL]);
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      // カタログは Base の accept を 0xd441… で宣言している。その住所を Celo の accept に載せ替えた壁。
      const w = wall({ [SCOUT_URL]: [celoUsdc(SCOUT_BASE_PAYTO, "2000")] });
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
      assert.equal(w.paid().length, 0);
      assert.equal((await ledgerFor(SCOUT_URL))[0]?.status, "payto_mismatch");
      assert.equal(await celoSpent(), 0);
    });

    await t.test("レーン枠の売り手: 壁が Celo の accept に宣言に無い payTo を出したら Celo では払わず、宣言どおりの Base で買う", async () => {
      await seed([TOOLS_URL]);
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      const w = wall({ [TOOLS_URL]: [baseUsdc(TOOLS_PAYTO, "1000"), celoUsdc(ROGUE_PAYTO, "1000")] });
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
      assert.equal(summary.laneFloor.celo, 1, "枠には載る（カタログは Celo を宣言している）");
      const paid = w.paid(TOOLS_URL);
      assert.equal(paid.length, 1);
      assert.equal(paid[0].accepted?.network, BASE_CAIP2);
      assert.equal(paid[0].accepted?.payTo, TOOLS_PAYTO);
      assert.equal(await celoSpent(), 0);
    });

    await t.test("レーン枠の売り手: Celo の accept が出品より高ければ Celo では払わない（安ければ払う）", async () => {
      await seed([TOOLS_URL]);
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      const dearer = wall({ [TOOLS_URL]: [baseUsdc(TOOLS_PAYTO, "1000"), celoUsdc(TOOLS_PAYTO, "1001")] });
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: dearer.fetchImpl });
      assert.equal(dearer.paidOn(CELO_CAIP2).length, 0);
      assert.equal(dearer.paid(TOOLS_URL)[0]?.accepted?.network, BASE_CAIP2);
      assert.equal(await celoSpent(), 0);
      await seed([TOOLS_URL]);
      const cheaper = wall({ [TOOLS_URL]: [baseUsdc(TOOLS_PAYTO, "1000"), celoUsdc(TOOLS_PAYTO, "900")] });
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: cheaper.fetchImpl });
      assert.equal(cheaper.paid(TOOLS_URL)[0]?.accepted?.network, CELO_CAIP2);
      assert.equal(await celoSpent(), 900);
    });

    await t.test("壁が宣言と違う額を出したら払わない（price_mismatch）。USDC 以外しか出さなければ払わない（no_eligible_accept）", async () => {
      await seed([SCOUT_URL]);
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      const priced = wall({ [SCOUT_URL]: [celoUsdc(SCOUT_CELO_PAYTO, "20000")] });
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: priced.fetchImpl });
      assert.equal(priced.paid().length, 0);
      assert.equal((await ledgerFor(SCOUT_URL))[0]?.status, "price_mismatch");
      assert.equal(await celoSpent(), 0);

      await seed([SCOUT_URL]);
      const usdtOnly = wall({ [SCOUT_URL]: [celoUsdt(SCOUT_CELO_PAYTO, "2000")] });
      await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: usdtOnly.fetchImpl });
      assert.equal(usdtOnly.paid().length, 0, "USDT には署名しない");
      assert.equal((await ledgerFor(SCOUT_URL))[0]?.status, "no_eligible_accept");
      assert.equal(await celoSpent(), 0);
    });

    await t.test("売り手ごとの日次上限は Celo にも掛かる: 同じ受取先の 2 件目は払わない", async () => {
      await seed([SCOUT_URL, SCOUT2_URL]);
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      process.env.L1_SELLER_DAILY_CAP_USD = "0.003"; // 3000 units: 1 件（2000）は通り、2 件目（計 4000）は通らない
      try {
        const w = wall();
        const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
        assert.equal(w.paidOn(CELO_CAIP2).length, 1, "同じ受取先へは 1 件だけ");
        assert.equal(await celoSpent(), 2000);
        assert.ok(summary.sellerCapped >= 1);
      } finally {
        delete process.env.L1_SELLER_DAILY_CAP_USD;
      }
    });

    await t.test("自己取引の関門は選んだ accept の payTo に掛かる: Celo の payTo が運用者のものなら払わない", async () => {
      const { resetDerivedOperatorAddresses } = await import("@/lib/observatory/operator");
      await seed([OPS_URL]);
      process.env.OBSERVATORY_CELO_L1_ENABLED = "true";
      // 候補 SQL の自己除外は先頭 pay_to（Base の 0x4444…）しか見ない。Celo の payTo を運用者として登録する。
      process.env.VET402_OPERATOR_PAYTO = OPS_CELO_PAYTO;
      try {
        const w = wall();
        const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED, limit: 10, fetchImpl: w.fetchImpl });
        assert.equal(summary.laneFloor.celo, 1, "レーン枠には載る");
        assert.equal(w.paid().length, 0, "署名しない");
        const r = await ledgerFor(OPS_URL);
        assert.equal(r.length, 1);
        assert.equal(r[0].status, "payto_operator_self");
        assert.equal(r[0].spent_units, "0");
        assert.equal(await celoSpent(), 0);
      } finally {
        delete process.env.VET402_OPERATOR_PAYTO;
        resetDerivedOperatorAddresses();
      }
    });
  });
}
