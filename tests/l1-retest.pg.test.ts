// ============================================================
// 公平な買い直し（retest・2026-09-28）— SQL の選び方と、購入の経路。
//
// 守ること:
//  1. 売り手（ポートを除いたホスト名）の**最新の** L1 行が、こちらの側の理由で失敗しているときだけ選ぶ:
//     (a) payer_unfunded（残高切れの期間に 402 / 5xx で決済されなかった Base の行）
//     (b) 宣言本文を送る実装（DECLARED_BODY_SENT_SINCE）より前の POST が 400 / 422 で決済されず、今の掲載が本文を宣言
//     (c) Base で宣言クエリを送り始める前（BASE_DECLARED_QUERY_SINCE）の 400/422・掲載は queryParams を宣言（2026-09-28）
//  2. 選ばない: 宣言の無い 400・実装後の 400・最新が決済済み・売り手側の失敗（404・price_mismatch）・
//     主ネットワークが Base 以外の出品。
//  3. 1 売り手 1 件（ポート違いも 1 売り手）・払う額（price_amount）の最安・$1 以下。
//  4. 並びは「優先ホスト → retest → census → 主候補の残り」。retest と census に同じ売り手は入らない。
//  5. 行は raw_response_meta.selection = "retest"。summary.retestCandidates に数が出る。
//  6. 旗（OBSERVATORY_L1_CENSUS=on）が無い日は何も変わらない。買い直した後の 2 回目のバッチでは選ばない。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_census_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-retest.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const FUNDED_PAYER = async () => 1_000_000_000n;
const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 retest (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const MAIN_HOSTS = 12;
  const SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

  test("L1 retest lane", async (t) => {
    const { runL1Batch, DECLARED_BODY_SENT_SINCE } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const schema = await import("@/lib/db/schema");
    const { sql } = await import("drizzle-orm");

    const db = getDb()!;
    const rowsOf = (raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];

    const KEYS = [
      "OBSERVATORY_L1_ENABLED",
      "OBSERVATORY_WALLET_PRIVATE_KEY",
      "OBSERVATORY_SOLANA_L1_ENABLED",
      "OBSERVATORY_ARC_L1_ENABLED",
      "OBSERVATORY_TEMPO_L1_ENABLED",
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
    const arm = (on: boolean) => {
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      delete process.env.OBSERVATORY_SOLANA_L1_ENABLED;
      delete process.env.OBSERVATORY_ARC_L1_ENABLED;
      delete process.env.OBSERVATORY_TEMPO_L1_ENABLED;
      delete process.env.L1_LANE_FLOOR_PER_RUN;
      if (on) process.env.OBSERVATORY_L1_CENSUS = "on";
      else delete process.env.OBSERVATORY_L1_CENSUS;
    };

    type Past = {
      status: string;
      http: number | null;
      at: string;
      requestBody?: "declared" | "empty";
      requestQuery?: "declared" | "empty" | "refused";
      /** 行の network（既定 Base）。 */
      network?: string;
    };
    type Listing = {
      url: string;
      amount: string;
      payTo: string;
      demand: "high" | "low";
      method: "GET" | "POST";
      declaresBody: boolean;
      /** 掲載が queryParams を宣言しているか（(c)・2026-09-28）。 */
      declaresQuery?: boolean;
      /** カタログの先頭の network（既定 Base）。 */
      primary?: string;
      /** この出品の過去の L1 行（古い順）。 */
      past?: Past[];
    };
    const listings: Listing[] = [];
    let n = 0;
    const add = (url: string, amount: string, opts: Partial<Omit<Listing, "url" | "amount" | "payTo">> = {}) => {
      n++;
      listings.push({
        url,
        amount,
        payTo: `0x${(n % 16).toString(16).repeat(40)}`,
        demand: "low",
        method: "GET",
        declaresBody: false,
        ...opts,
      });
    };
    const UNFUNDED_AT = "2026-09-14T03:00:00Z"; // 残高切れの期間（delivery.ts PAYER_UNFUNDED_WINDOWS）の内側
    const BEFORE_BODY = "2026-09-15T03:00:00Z"; // 宣言本文の実装より前
    const AFTER_BODY = "2026-09-18T03:00:00Z"; // 実装より後
    const QUERY_BEFORE = "2026-09-20T03:00:00Z"; // Base で宣言クエリを送り始める前（本文の実装の後）
    const QUERY_AFTER = "2026-09-28T01:00:00Z"; // 送り始めた後
    const OLD_OK = "2026-09-10T03:00:00Z";

    // 試し済みで最新が決済済みの主候補（需要が高い）。
    for (let i = 1; i <= MAIN_HOSTS; i++) {
      add(`https://main${i}.example/old`, "3000", { demand: "high", past: [{ status: "settled", http: 200, at: OLD_OK }] });
      add(`https://main${i}.example/api`, "3000", { demand: "high" });
    }
    // 優先ホスト（試し済み・/search は需要の高い未購入）。
    add("https://x402.tavily.com/old", "3000", { demand: "high", past: [{ status: "settled", http: 200, at: OLD_OK }] });
    add("https://x402.tavily.com/search", "3000", { demand: "high" });

    // (a) payer_unfunded: 最新の行が残高切れ。安い /cheap（1000）が選ばれ、/dear（5000・失敗した出品）は選ばれない。
    add("https://ra.example/dear", "5000", { past: [{ status: "settle_failed", http: 402, at: UNFUNDED_AT }] });
    add("https://ra.example/cheap", "1000");
    // (b) 宣言本文より前の POST が 400・今の掲載は本文を宣言 → 選ぶ。同じ売り手のもっと安い GET（500）ではなく、
    // 失敗した POST そのもの（2000）を買い直す（レビュー W2）。
    add("https://rb.example/post", "2000", { method: "POST", declaresBody: true, past: [{ status: "settle_failed", http: 400, at: BEFORE_BODY }] });
    add("https://rb.example/cheapget", "500");
    // (b) を 422 にも広げる（レビュー W1）→ 選ぶ。
    add("https://rk.example/post", "2500", { method: "POST", declaresBody: true, past: [{ status: "settle_failed", http: 422, at: BEFORE_BODY }] });
    // 401 は本文の話ではない → 選ばない。
    add("https://rl.example/post", "1500", { method: "POST", declaresBody: true, past: [{ status: "settle_failed", http: 401, at: BEFORE_BODY }] });
    // (b) だが失敗した出品がもう買えない（$1 超）→ 同じ売り手の最安（700）に落ちる。
    add("https://rm.example/post", "2000000", { method: "POST", declaresBody: true, past: [{ status: "settle_failed", http: 400, at: BEFORE_BODY }] });
    add("https://rm.example/alt", "700");

    // (c) Base で宣言クエリを送る前（BASE_DECLARED_QUERY_SINCE より前）の 400/422・掲載は queryParams を宣言（2026-09-28）。
    // 失敗した出品（1800）を、同じ売り手の安い出品（300）より先に買い直す。
    add("https://qa.example/get", "1800", { declaresQuery: true, past: [{ status: "settle_failed", http: 400, at: QUERY_BEFORE }] });
    add("https://qa.example/cheap", "300");
    // requestQuery が empty の行も (c)（Base は許可リストに無かった）→ 選ぶ。
    add("https://qf.example/get", "2200", { declaresQuery: true, past: [{ status: "settle_failed", http: 422, at: QUERY_BEFORE, requestQuery: "empty" }] });
    // 境目の後の 422 → 選ばない。
    add("https://qb.example/get", "1200", { declaresQuery: true, past: [{ status: "settle_failed", http: 422, at: QUERY_AFTER }] });
    // queryParams の宣言が無い → 選ばない。
    add("https://qc.example/get", "1200", { past: [{ status: "settle_failed", http: 400, at: QUERY_BEFORE }] });
    // XRPL の行（2026-09-21 から送っていた）→ (c) に入らない。
    add("https://qd.example/get", "1200", { declaresQuery: true, past: [{ status: "settle_failed", http: 400, at: QUERY_BEFORE, network: "xrpl:0" }] });
    // 宣言クエリを送った行（declared）→ 選ばない。
    add("https://qe.example/get", "1200", { declaresQuery: true, past: [{ status: "settle_failed", http: 400, at: QUERY_BEFORE, requestQuery: "declared" }] });
    // 宣言の無い 400 → 選ばない。
    add("https://rc.example/post", "1500", { method: "POST", declaresBody: false, past: [{ status: "settle_failed", http: 400, at: BEFORE_BODY }] });
    // 実装後の 400（宣言本文を送った）→ 選ばない。
    add("https://rd.example/post", "1500", {
      method: "POST",
      declaresBody: true,
      past: [{ status: "settle_failed", http: 400, at: AFTER_BODY, requestBody: "declared" }],
    });
    // 実装後の 400 で requestBody の記録も無い行（境目の時刻だけが外す）→ 選ばない。
    add("https://rj.example/post", "1500", { method: "POST", declaresBody: true, past: [{ status: "settle_failed", http: 400, at: AFTER_BODY }] });
    // 以前は残高切れだが、最新は決済済み → 選ばない。
    add("https://re.example/api", "1500", {
      past: [
        { status: "settle_failed", http: 402, at: UNFUNDED_AT },
        { status: "settled", http: 200, at: "2026-09-16T03:00:00Z" },
      ],
    });
    // 売り手側の失敗（404・price_mismatch）→ 選ばない。
    add("https://rf.example/api", "1500", { past: [{ status: "settle_failed", http: 404, at: BEFORE_BODY }] });
    add("https://rg.example/api", "1500", { past: [{ status: "price_mismatch", http: null, at: BEFORE_BODY }] });
    // 最新の行は残高切れだが、出品の先頭が Base 以外 → 選ばない。
    add("https://rh.example/api", "1500", { primary: "eip155:84532", past: [{ status: "settle_failed", http: 402, at: UNFUNDED_AT }] });
    // ポート違いの同じ売り手: :4449 の行が残高切れ。:4450 と :4451 の出品から 1 件だけ。
    add("https://ri.example:4449/old", "3000", { past: [{ status: "settle_failed", http: 402, at: UNFUNDED_AT }] });
    add("https://ri.example:4450/api", "3000");
    add("https://ri.example:4451/api", "3000");
    // census の相手（購入行の無い売り手）。retest の後ろに並ぶ。
    add("https://cz.example/api", "500");

    const byUrl = new Map(listings.map((l) => [l.url, l]));
    const challengeFor = (url: string) => {
      const l = byUrl.get(url)!;
      const base = { scheme: "exact", network: "eip155:8453", amount: l.amount, asset: BASE_USDC, payTo: l.payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
      // 先頭が Base 以外の出品（rh）は、壁もカタログと同じ並びの accepts を出す（L0 はそれで合格する）。
      const accepts = l.primary
        ? [{ ...base, network: l.primary, asset: SEPOLIA_USDC }, base]
        : [base];
      return JSON.stringify({ x402Version: 2, accepts });
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
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({ success: true, transaction: `0x${(0xbeef0000 + txSeq).toString(16).padStart(64, "0")}`, network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" }),
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
      const items = listings.map((l) => {
        const base = { amount: l.amount, asset: BASE_USDC, network: "eip155:8453", payTo: l.payTo };
        const accepts = l.primary ? [{ amount: l.amount, asset: SEPOLIA_USDC, network: l.primary, payTo: l.payTo }, base] : [base];
        return parseCatalogItem({
          resource: l.url,
          accepts,
          extensions: {
            bazaar: {
              info: {
                input: {
                  method: l.method,
                  ...(l.declaresBody ? { body: { q: "x" } } : {}),
                  ...(l.declaresQuery ? { queryParams: { q: "x" } } : {}),
                },
              },
              ...(l.declaresBody || l.declaresQuery
                ? {
                    schema: {
                      type: "object",
                      properties: {
                        input: {
                          type: "object",
                          properties: {
                            ...(l.declaresBody ? { body: { type: "object", properties: { q: { type: "string" } } } } : {}),
                            ...(l.declaresQuery ? { queryParams: { type: "object", properties: { q: { type: "string" } } } } : {}),
                          },
                        },
                      },
                    },
                  }
                : {}),
            },
          },
          quality: l.demand === "high" ? { l30DaysTotalCalls: 5000, l30DaysUniquePayers: 500 } : { l30DaysTotalCalls: 10, l30DaysUniquePayers: 1 },
        });
      });
      await syncCatalog({ fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true }, today: "2026-09-28" });
      await runL0ProbeBatch({
        limit: 200,
        concurrency: 4,
        fetchImpl: async (url: string) => new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } }),
      });
      for (const l of listings) {
        for (const p of l.past ?? []) {
          await db.insert(schema.x402L1Purchases).values({
            endpointId: await idOf(l.url),
            status: p.status,
            payer: "0x0000000000000000000000000000000000000001",
            network: p.network ?? "eip155:8453",
            asset: BASE_USDC,
            payTo: l.payTo,
            amountUnits: l.amount,
            spentUnits: "0",
            httpStatusPaid: p.http,
            attemptedAt: new Date(p.at),
            rawResponseMeta: {
              phase: "paid",
              ...(p.requestBody ? { requestBody: p.requestBody } : {}),
              ...(p.requestQuery ? { requestQuery: p.requestQuery } : {}),
            },
          });
        }
      }
    }

    const run = (w: ReturnType<typeof wall>) =>
      runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 10, fetchImpl: w.fetchImpl });
    const bySelection = async (selection: string) =>
      rowsOf(
        await db.execute(sql`
          SELECT e.resource_url FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
          WHERE pu.raw_response_meta->>'selection' = ${selection}
        `),
      ).map((r) => String(r.resource_url));
    const hostOf = (url: string) => new URL(url).hostname;

    await t.test("前提: Base の宣言クエリの境目は本番の再デプロイの ready（2026-09-27T23:27:16Z）", async () => {
      const { BASE_DECLARED_QUERY_SINCE } = await import("@/lib/observatory/request-query");
      assert.equal(BASE_DECLARED_QUERY_SINCE, "2026-09-27T23:27:16Z");
      assert.ok(Date.parse(QUERY_BEFORE) < Date.parse(BASE_DECLARED_QUERY_SINCE) && Date.parse(BASE_DECLARED_QUERY_SINCE) < Date.parse(QUERY_AFTER));
    });

    await t.test("前提: 境目の時刻は本番のデプロイ記録（2b4a4ee0・2026-09-16T23:25:55Z）", () => {
      assert.equal(DECLARED_BODY_SENT_SINCE, "2026-09-16T23:25:55Z");
      assert.ok(Date.parse(BEFORE_BODY) < Date.parse(DECLARED_BODY_SENT_SINCE) && Date.parse(DECLARED_BODY_SENT_SINCE) < Date.parse(AFTER_BODY));
    });

    await t.test("前提: 選ばれないはずの出品も L0 は合格している（除外が L0 のせいで起きていない）", async () => {
      arm(true);
      await seed();
      for (const url of ["https://rc.example/post", "https://rd.example/post", "https://re.example/api", "https://rh.example/api", "https://ra.example/cheap"]) {
        const v = rowsOf(await db.execute(sql`SELECT verdict FROM x402_l0_probes WHERE endpoint_id = ${await idOf(url)}::uuid ORDER BY probed_at DESC LIMIT 1`));
        assert.equal(v[0]?.verdict, "pass", url);
      }
    });

    await t.test("対象の売り手の一覧（RETEST_SELLERS_SQL を 1 回・W3）: 理由と、(b) で優先する出品", async () => {
      arm(true);
      await seed();
      const { readRetestSellers } = await import("@/lib/observatory/l1-runner");
      const r = await readRetestSellers(db);
      assert.ok(r);
      assert.deepEqual(
        (JSON.parse(r.hostsJson) as string[]).sort(),
        ["qa.example", "qf.example", "ra.example", "rb.example", "rh.example", "ri.example", "rk.example", "rm.example"],
        "rh（先頭が Base 以外）は売り手としては当たるが、出品の条件で外れる",
      );
      assert.deepEqual(
        (JSON.parse(r.preferredIdsJson) as string[]).sort(),
        [
          await idOf("https://rb.example/post"),
          await idOf("https://rk.example/post"),
          await idOf("https://rm.example/post"),
          await idOf("https://qa.example/get"),
          await idOf("https://qf.example/get"),
        ].sort(),
        "優先するのは (b)(c) の失敗した出品だけ（(a) は最安のまま）",
      );
    });

    await t.test("旗が無い日: retest は動かない（summary 0・印なし・対象の出品は買わない）", async () => {
      arm(false);
      await seed();
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.retestCandidates, 0);
      assert.equal(summary.censusCandidates, 0);
      assert.deepEqual(await bySelection("retest"), []);
      for (const h of ["ra.example", "rb.example", "ri.example"]) assert.ok(!w.paidUrls().some((u) => hostOf(u) === h), h);
    });

    await t.test("旗が on: こちらの側の理由の売り手だけを 1 件ずつ、優先ホストの後・census の前に買い直す", async () => {
      arm(true);
      await seed();
      const w = wall();
      const summary = await run(w);
      const paid = w.paidUrls();
      const riPaid = paid.filter((u) => hostOf(u) === "ri.example");
      assert.equal(paid[0], "https://x402.tavily.com/search", `優先ホストが先頭: ${paid.slice(0, 6).join(", ")}`);
      assert.equal(riPaid.length, 1, `ポート違いは 1 売り手: ${riPaid.join(", ")}`);
      assert.deepEqual(
        paid.slice(1, 9),
        [
          "https://rm.example/alt",
          "https://ra.example/cheap",
          "https://qa.example/get",
          "https://rb.example/post",
          "https://qf.example/get",
          "https://rk.example/post",
          riPaid[0],
          "https://cz.example/api",
        ],
        "retest（選んだ出品の払う額の安い順 700 → 1000 → 1800 → 2000 → 2200 → 2500 → 3000）の後に census（500 でも retest より後ろ）",
      );
      assert.ok(!paid.includes("https://rb.example/cheapget"), "(b) は失敗した出品そのものを買い直す（同じ売り手の安い GET ではない・W2）");
      assert.ok(!paid.includes("https://rm.example/post"), "$1 超の出品は買わない（最安に落ちる）");
      assert.ok(!paid.includes("https://qa.example/cheap"), "(c) も失敗した出品そのものを買い直す（同じ売り手の安い出品ではない）");
      for (const h of ["qb.example", "qc.example", "qd.example", "qe.example"]) {
        assert.ok(!paid.some((u) => hostOf(u) === h), `${h} は (c) に入らない（境目の後・宣言なし・XRPL・送った行）`);
      }
      for (const h of ["rc.example", "rd.example", "rj.example", "rl.example", "re.example", "rf.example", "rg.example", "rh.example"]) {
        assert.ok(!paid.some((u) => hostOf(u) === h), `${h} は選ばない`);
      }
      assert.ok(!paid.includes("https://ra.example/dear"), "同じ売り手の高い出品は選ばない");
      assert.equal(summary.retestCandidates, 7);
      assert.equal(summary.censusCandidates, 1);
      assert.deepEqual(
        (await bySelection("retest")).sort(),
        [
          "https://rm.example/alt",
          "https://ra.example/cheap",
          "https://qa.example/get",
          "https://rb.example/post",
          "https://qf.example/get",
          "https://rk.example/post",
          riPaid[0],
        ].sort(),
      );
      assert.deepEqual(await bySelection("census"), ["https://cz.example/api"]);
      const hosts = paid.map(hostOf);
      const fair = hosts.filter((h) => /^r[a-m]\.example$|^q[a-f]\.example$|^cz\.example$/.test(h));
      assert.equal(new Set(fair).size, fair.length, "同じ売り手が 2 度入らない");
      assert.equal(fair.length, 8);
    });

    await t.test("2 回目のバッチ: 買い直した売り手は選ばない（最新の行がもう失敗ではない）", async () => {
      arm(true);
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.retestCandidates, 0);
      assert.equal((await bySelection("retest")).length, 7, "印つきの行は 1 回目の 7 件のまま");
    });
  });
}
