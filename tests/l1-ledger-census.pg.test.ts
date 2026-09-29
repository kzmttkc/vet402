// ============================================================
// 2026-09-29 の 2 件（お金）— 実 DB で固定する。
//
// A. 支払った後の台帳の書き込み:
//  1. 本文がバイナリ（gzip）の出品を買っても、結果の UPDATE は落ちない。売り手が名指した tx・HTTP 200・status が
//     台帳に残る（本番: cloud.trycorpus.ai の gzip TSV で 0.50 USDC の行が threw_after_reservation の settle_failed・tx なし
//     になった。原因は bodyHead の U+0000 を jsonb が受け付けないこと＝22P05）。
//  2. 結果の UPDATE が未知の理由で落ちても、小さな行で書き直し、tx・HTTP status・status を失わない（原因を残す）。
//  3. それも落ちたら settle_failed（spent_units と auth_nonce は残る＝遅延回収が拾える）。原因（SQLSTATE）が残る。
//
// B. census を 10/6 の告知までに一巡させる枠:
//  4. OBSERVATORY_L1_CENSUS_FIRST_PURCHASE_QUOTA 未設定＝従来どおり: 当日の初回購入が 120 に届いたら census も買わない
//     （行も書かない）。
//  5. 200 にすると census だけが 120 を超えて買える。主候補の初回購入は 120 のまま止まる。
//  6. 枠の境界は予約（reserveSpend）の 1 文で締まる: 残り 2 なら census は 2 件だけ、残りは行を書かずに見送る。
//  7. 既存の上限は census にもそのまま: 受取先ごとの日次上限（$2）に届いた売り手は買わない。
//  8. OBSERVATORY_L1_CENSUS_MIN_PER_RUN: retest が 40 枠を取り切る日でも census に最低枠。未設定なら従来どおり census 0。
//     census の最低枠は retest より前に買う。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-ledger-census.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const FUNDED_PAYER = async () => 1_000_000_000n;
const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 ledger + census quota (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const RETEST_HOSTS = 42;
  const CENSUS_HOSTS = 5;

  test("L1 ledger write after payment + census quota", async (t) => {
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

    const KEYS = [
      "OBSERVATORY_L1_ENABLED",
      "OBSERVATORY_WALLET_PRIVATE_KEY",
      "OBSERVATORY_SOLANA_L1_ENABLED",
      "OBSERVATORY_ARC_L1_ENABLED",
      "OBSERVATORY_TEMPO_L1_ENABLED",
      "L1_LANE_FLOOR_PER_RUN",
      "L1_SELLER_DAILY_CAP_USD",
      "OBSERVATORY_L1_CENSUS",
      "OBSERVATORY_L1_CENSUS_FIRST_PURCHASE_QUOTA",
      "OBSERVATORY_L1_CENSUS_MIN_PER_RUN",
    ] as const;
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    t.after(async () => {
      for (const k of KEYS) {
        const v = saved[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await dropTrigger();
    });
    const arm = (env: { quota?: string; min?: string } = {}) => {
      process.env.OBSERVATORY_L1_ENABLED = "true";
      process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
      delete process.env.OBSERVATORY_SOLANA_L1_ENABLED;
      delete process.env.OBSERVATORY_ARC_L1_ENABLED;
      delete process.env.OBSERVATORY_TEMPO_L1_ENABLED;
      delete process.env.L1_LANE_FLOOR_PER_RUN;
      delete process.env.L1_SELLER_DAILY_CAP_USD;
      process.env.OBSERVATORY_L1_CENSUS = "on";
      if (env.quota === undefined) delete process.env.OBSERVATORY_L1_CENSUS_FIRST_PURCHASE_QUOTA;
      else process.env.OBSERVATORY_L1_CENSUS_FIRST_PURCHASE_QUOTA = env.quota;
      if (env.min === undefined) delete process.env.OBSERVATORY_L1_CENSUS_MIN_PER_RUN;
      else process.env.OBSERVATORY_L1_CENSUS_MIN_PER_RUN = env.min;
    };

    type Listing = { url: string; amount: string; payTo: string; demand: "high" | "low" };
    const payToOf = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
    const listings: Listing[] = [];
    let seq = 1;
    const add = (url: string, amount: string, demand: "high" | "low" = "low") =>
      listings.push({ url, amount, payTo: payToOf(seq++), demand });
    // census の売り手（L1 の行が 1 件も無い Base のホスト）。安い順に census0 → census4 → bin（gzip）。
    for (let i = 0; i < CENSUS_HOSTS; i++) add(`https://census${i}.example/api`, String(1000 + i));
    add("https://bin.example/export", "1100");
    // retest の売り手（最新の行が payer_unfunded の期間の 402）。需要は低い。
    for (let i = 0; i < RETEST_HOSTS; i++) add(`https://retest${String(i).padStart(2, "0")}.example/api`, "2000");
    // 主候補: 試し済みのホストの、まだ買っていない出品（＝初回購入）。需要が高い。
    add("https://main.example/old", "3000", "high");
    add("https://main.example/new", "3000", "high");
    const byUrl = new Map(listings.map((l) => [l.url, l]));
    const isCensus = (u: string) => /census\d\.example|bin\.example/.test(u);
    const isRetest = (u: string) => u.includes("retest");

    const challengeFor = (url: string) => {
      const l = byUrl.get(url)!;
      return JSON.stringify({
        x402Version: 2,
        accepts: [
          { scheme: "exact", network: "eip155:8453", amount: l.amount, asset: BASE_USDC, payTo: l.payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } },
        ],
      });
    };
    const GZIP = gzipSync(Buffer.from("ts\tprice\n2026-09-29T06:00:00Z\t0.0296\n".repeat(20)));
    assert.equal(GZIP[3], 0x00, "gzip の 4 バイト目は 0x00（文字列にすると U+0000）");
    let txSeq = 0;
    const receipt = (tx: string) =>
      Buffer.from(JSON.stringify({ success: true, transaction: tx, network: "eip155:8453", payer: "0x0000000000000000000000000000000000000001" })).toString("base64");
    const wall = (opts: { binReceipt?: boolean; census0FailedReceipt?: boolean } = {}) => {
      const paid: string[] = [];
      const unpaid: string[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const isPaid = headers.has("PAYMENT-SIGNATURE") || headers.has("X-PAYMENT");
        if (!isPaid) {
          unpaid.push(url);
          return new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } });
        }
        paid.push(url);
        txSeq++;
        const tx = `0x${txSeq.toString(16).padStart(64, "0")}`;
        if (opts.census0FailedReceipt && url.includes("census0.example")) {
          // success:false・tx なし・errorReason に U+0000（受領証はあるが決済を名指さない）。
          const failed = Buffer.from(JSON.stringify({ success: false, errorReason: "bad\u0000pay", network: "eip155:8453" })).toString("base64");
          return new Response(JSON.stringify({ data: "goods" }), { status: 200, headers: { "content-type": "application/json", "PAYMENT-RESPONSE": failed } });
        }
        if (url.includes("bin.example")) {
          return new Response(GZIP, {
            status: 200,
            headers: { "content-type": "application/gzip", ...(opts.binReceipt === false ? {} : { "PAYMENT-RESPONSE": receipt(tx) }) },
          });
        }
        return new Response(JSON.stringify({ data: "goods" }), { status: 200, headers: { "content-type": "application/json", "PAYMENT-RESPONSE": receipt(tx) } });
      };
      return { paid, unpaid, fetchImpl };
    };
    const idOf = async (url: string) => String(rowsOf(await db.execute(sql`SELECT id FROM x402_endpoints WHERE resource_url = ${url}`))[0].id);

    async function seed(opts: { firstsToday?: number } = {}) {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      const items = listings.map((l) =>
        parseCatalogItem({
          resource: l.url,
          accepts: [{ amount: l.amount, asset: BASE_USDC, network: "eip155:8453", payTo: l.payTo }],
          extensions: { bazaar: { info: { input: { method: "GET" } } } },
          quality: l.demand === "high" ? { l30DaysTotalCalls: 5000, l30DaysUniquePayers: 500 } : { l30DaysTotalCalls: 10, l30DaysUniquePayers: 1 },
        }),
      );
      await syncCatalog({ fetchResult: { items, totalCount: items.length, fetchedCount: items.length, complete: true }, today: "2026-09-29" });
      await runL0ProbeBatch({
        limit: 500,
        concurrency: 8,
        fetchImpl: async (url: string) => new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } }),
      });
      const base = { payer: "0x0000000000000000000000000000000000000001", network: "eip155:8453", asset: BASE_USDC, spentUnits: "0" } as const;
      // main.example は試し済み（/old に古い決済済みの行）。/new は初回購入。
      const main = byUrl.get("https://main.example/old")!;
      await db.insert(schema.x402L1Purchases).values({
        ...base,
        endpointId: await idOf(main.url),
        status: "settled",
        payTo: main.payTo,
        amountUnits: main.amount,
        attemptedAt: new Date("2026-09-01T00:00:00Z"),
      });
      // retest: 残高切れの期間（2026-09-13〜15）に 402 で決済されなかった行が最新。
      for (const l of listings.filter((x) => isRetest(x.url))) {
        await db.insert(schema.x402L1Purchases).values({
          ...base,
          endpointId: await idOf(l.url),
          status: "settle_failed",
          httpStatusPaid: 402,
          payTo: l.payTo,
          amountUnits: l.amount,
          authNonce: "0x" + "cd".repeat(32),
          attemptedAt: new Date("2026-09-14T00:00:00Z"),
        });
      }
      // 当日の初回購入（カタログに無い出品の行・支出 0）。firstPurchasesTodayCountSql が数える。
      const n = opts.firstsToday ?? 0;
      if (n > 0) {
        await db.execute(sql`
          WITH eps AS (
            INSERT INTO x402_endpoints (resource_key, resource_url, source, method, network, pay_to, price_amount, status)
            SELECT 'filler' || g || '.example/x', 'https://filler' || g || '.example/x', 'cdp_bazaar', 'GET', 'eip155:8453',
                   '0x00000000000000000000000000000000000000ff', '1', 'delisted'
            FROM generate_series(1, ${n}::int) g
            RETURNING id
          )
          INSERT INTO x402_l1_purchases (endpoint_id, status, payer, network, pay_to, amount_units, spent_units)
          SELECT id, 'request_error', '0x0000000000000000000000000000000000000001', 'eip155:8453',
                 '0x00000000000000000000000000000000000000ff', '1', '0'
          FROM eps`);
      }
    }
    const run = (w: ReturnType<typeof wall>) => runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 10, fetchImpl: w.fetchImpl });
    const rowFor = async (url: string) =>
      rowsOf(
        await db.execute(sql`
          SELECT pu.status, pu.tx_hash, pu.http_status_paid, pu.spent_units, pu.auth_nonce, pu.raw_response_meta, pu.raw_settlement
          FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
          WHERE e.resource_url = ${url} ORDER BY pu.attempted_at DESC`),
      );
    const selectionCount = async (selection: string) =>
      Number(rowsOf(await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases WHERE raw_response_meta->>'selection' = ${selection}`))[0].n);

    async function dropTrigger() {
      await db.execute(sql`DROP TRIGGER IF EXISTS l1_fail_outcome ON x402_l1_purchases`);
      await db.execute(sql`DROP FUNCTION IF EXISTS l1_fail_outcome_fn()`);
    }
    /** 結果の UPDATE を落とす（本番の 22P05 と同じ SQLSTATE）。mode=full: bodyHead を持つ書き込みだけ。all: phase=paid の書き込み全部。 */
    async function failOutcomeWrites(mode: "full" | "all") {
      await dropTrigger();
      const cond =
        mode === "full"
          ? sql.raw(`NEW.raw_response_meta ? 'bodyHead'`)
          : sql.raw(`coalesce(NEW.raw_response_meta->>'phase', '') = 'paid'`);
      await db.execute(sql`
        CREATE FUNCTION l1_fail_outcome_fn() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.status <> 'in_flight' AND ${cond} THEN
            RAISE EXCEPTION 'unsupported Unicode escape sequence' USING ERRCODE = '22P05';
          END IF;
          RETURN NEW;
        END $$`);
      await db.execute(sql`CREATE TRIGGER l1_fail_outcome BEFORE UPDATE ON x402_l1_purchases FOR EACH ROW EXECUTE FUNCTION l1_fail_outcome_fn()`);
    }

    // ---------------- A. 支払った後の台帳の書き込み ----------------
    await t.test("A1: gzip の本文でも結果が書ける（tx・HTTP 200・settle_claimed）。本文の先頭に U+0000 は残らない", async () => {
      arm({ min: "10" });
      await seed();
      const w = wall();
      await run(w);
      assert.ok(w.paid.includes("https://bin.example/export"), `census として買われる: ${w.paid.join(", ")}`);
      const [row] = await rowFor("https://bin.example/export");
      assert.equal(row.status, "settle_claimed", JSON.stringify(row.raw_response_meta));
      assert.match(String(row.tx_hash), /^0x[0-9a-f]{64}$/);
      assert.equal(row.http_status_paid, 200);
      const meta = row.raw_response_meta as Record<string, unknown>;
      assert.equal(meta.phase, "paid");
      assert.equal(meta.selection, "census");
      assert.ok(typeof meta.bodyHead === "string" && !(meta.bodyHead as string).includes("\u0000"));
      assert.ok(!("reason" in meta), "threw_after_reservation ではない");
      assert.deepEqual((meta.pgSanitized as { fields: string[] }).fields, ["rawResponseMeta"], "無害化した列の印が残る");
      const [clean] = await rowFor("https://census1.example/api");
      assert.ok(!("pgSanitized" in (clean.raw_response_meta as Record<string, unknown>)), "何も変えていない行には印を付けない");
    });

    await t.test("A1b: gzip の本文・受領証なし → delivered_no_receipt（HTTP 200 が残る・settle_failed にしない）", async () => {
      arm();
      await seed();
      await run(wall({ binReceipt: false }));
      const [row] = await rowFor("https://bin.example/export");
      assert.equal(row.status, "delivered_no_receipt");
      assert.equal(row.http_status_paid, 200);
      assert.equal(row.tx_hash, null);
    });

    await t.test("A2: 結果の UPDATE が落ちても、小さな行で tx・HTTP status・status を残し、原因（SQLSTATE）を残す", async () => {
      arm({ min: "10" });
      await seed();
      await failOutcomeWrites("full");
      try {
        await run(wall());
      } finally {
        await dropTrigger();
      }
      const [row] = await rowFor("https://census0.example/api");
      assert.equal(row.status, "settle_claimed");
      assert.match(String(row.tx_hash), /^0x[0-9a-f]{64}$/, "売り手が名指した tx を失わない");
      assert.equal(row.http_status_paid, 200);
      assert.equal(row.spent_units, "1000");
      assert.ok(row.auth_nonce, "nonce は署名の直後に書き済み");
      const meta = row.raw_response_meta as Record<string, unknown>;
      assert.equal(meta.selection, "census");
      const failed = meta.outcomeWriteFailed as { cause: { code: string; message: string } | null };
      assert.equal(failed.cause?.code, "22P05");
      assert.match(String(failed.cause?.message), /unsupported Unicode escape sequence/);
      // 独立レビュー W1: 受領証の形（success の元の値・network・payer）と L2 の証拠・本文の記録を残す。
      assert.deepEqual(row.raw_settlement, {
        success: true,
        transaction: row.tx_hash,
        network: "eip155:8453",
        payer: "0x0000000000000000000000000000000000000001",
        errorReason: null,
      });
      assert.ok(meta.l2 && typeof (meta.l2 as { responseHash?: unknown }).responseHash === "string", "L2 の証拠が残る");
      assert.ok("requestBody" in meta, "本文の記録が残る");
      assert.ok(!("bodyHead" in meta), "売り手の本文は外す");
    });

    await t.test("A2b: 受領証が success:false・tx なしでも、小さな行の raw_settlement は object のまま（/sellers が「PAYMENT-RESPONSE なし」と誤らない）", async () => {
      arm({ min: "10" });
      await seed();
      await failOutcomeWrites("full");
      try {
        await run(wall({ census0FailedReceipt: true }));
      } finally {
        await dropTrigger();
      }
      const [row] = await rowFor("https://census0.example/api");
      assert.equal(row.status, "delivered_no_receipt");
      assert.equal(row.http_status_paid, 200);
      assert.equal(row.tx_hash, null);
      assert.deepEqual(row.raw_settlement, { success: false, transaction: null, network: "eip155:8453", payer: null, errorReason: "badpay" });
      const meta = row.raw_response_meta as Record<string, unknown>;
      assert.ok((meta.pgSanitized as { fields: string[] }).fields.includes("rawSettlement"), "無害化の印は小さな行にも残る");
      assert.equal((meta.outcomeWriteFailed as { cause: { code: string } }).cause.code, "22P05");
    });

    await t.test("A3: 小さな行も落ちたら settle_failed。spent_units と auth_nonce は残り、原因が残る（遅延回収の対象）", async () => {
      arm();
      await seed();
      await failOutcomeWrites("all");
      try {
        await run(wall());
      } finally {
        await dropTrigger();
      }
      const [row] = await rowFor("https://census0.example/api");
      assert.equal(row.status, "settle_failed");
      assert.equal(row.tx_hash, null);
      assert.equal(row.spent_units, "1000", "署名した＝計上は残す");
      assert.ok(row.auth_nonce, "nonce が残る（recover-late の対象・照合器が nonce で束縛する）");
      const meta = row.raw_response_meta as Record<string, unknown>;
      assert.equal(meta.reason, "threw_after_reservation");
      assert.equal(meta.credentialSent, true);
      assert.equal((meta.cause as { code: string }).code, "22P05", "原因が途中で切れずに残る");
    });

    // ---------------- B. census の枠 ----------------
    await t.test("B4: 初回購入の枠（120）に届いた日は、census の枠が未設定なら census も買わない（行も書かない）", async () => {
      arm({ min: "10" });
      await seed({ firstsToday: 120 });
      const w = wall();
      const summary = await run(w);
      assert.equal(w.paid.filter(isCensus).length, 0);
      assert.equal(summary.censusCandidates, 0);
      assert.equal(await selectionCount("census"), 0);
      assert.ok(!w.paid.includes("https://main.example/new"), "主候補の初回購入も止まる（従来どおり）");
      assert.ok(w.paid.some(isRetest), "買い直し（初回でない）は続く");
    });

    await t.test("B5: census の枠を 200 にすると census だけが 120 を超えて買える。主候補の初回購入は 120 で止まったまま", async () => {
      arm({ quota: "200", min: "10" });
      await seed({ firstsToday: 120 });
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.censusCandidates, CENSUS_HOSTS + 1);
      assert.equal(w.paid.filter(isCensus).length, CENSUS_HOSTS + 1);
      assert.equal(await selectionCount("census"), CENSUS_HOSTS + 1);
      assert.ok(!w.paid.includes("https://main.example/new"), "census でない初回購入は 120 のまま止まる");
    });

    await t.test("B6: 境界は予約の 1 文で締まる: 残り 2 なら census は 2 件だけ。残りは行を書かずに見送る", async () => {
      arm({ quota: "122", min: "10" });
      await seed({ firstsToday: 120 });
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.censusCandidates, CENSUS_HOSTS + 1, "候補にはバッチ開始時の値で入る");
      assert.deepEqual(w.paid.filter(isCensus), ["https://census0.example/api", "https://census1.example/api"], "安い順に 2 件");
      assert.equal(await selectionCount("census"), 2, "見送った census の行は書かない（翌日また候補）");
    });

    await t.test("B7: 既存の上限は census にもそのまま（受取先ごとの日次上限に届いた売り手は買わない）", async () => {
      arm({ quota: "200", min: "10" });
      await seed();
      // census0 と同じ受取先へ、当日すでに $2（別のホストの出品で。census0 のホストは未試行のまま）。
      const c0 = byUrl.get("https://census0.example/api")!;
      await db.insert(schema.x402L1Purchases).values({
        endpointId: await idOf("https://main.example/old"),
        status: "settled",
        payer: "0x0000000000000000000000000000000000000001",
        network: "eip155:8453",
        asset: BASE_USDC,
        payTo: c0.payTo,
        amountUnits: "2000000",
        spentUnits: "2000000",
      });
      const w = wall();
      await run(w);
      assert.ok(!w.paid.includes(c0.url), "受取先の日次上限（$2）に届いた census の売り手は買わない");
      assert.ok(w.paid.includes("https://census1.example/api"), "他の census は買う");
      assert.equal((await rowFor(c0.url)).length, 0, "行も書かない（翌日また候補）");
    });

    await t.test("B8: census の最低枠。未設定なら retest が 40 を取り census は 0（従来どおり）", async () => {
      arm();
      await seed();
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.retestCandidates, 40);
      assert.equal(summary.censusCandidates, 0);
      assert.equal(await selectionCount("census"), 0, "census の印の行は無い（census のホストが主候補として買われることはある）");
    });

    await t.test("B8b: 最低枠 3 なら retest が残っていても census 3 件を retest より前に買う（合計 40 のまま）", async () => {
      arm({ min: "3" });
      await seed();
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.censusCandidates, 3);
      assert.equal(summary.retestCandidates, 37);
      const firstRetest = w.paid.findIndex(isRetest);
      const census = ["https://census0.example/api", "https://census1.example/api", "https://census2.example/api"];
      assert.deepEqual(w.paid.slice(0, 3), census, `census の最低枠は安い順に先頭（retest より前）: ${w.paid.slice(0, 6).join(", ")}`);
      assert.equal(firstRetest, 3);
      for (const u of census) assert.equal(((await rowFor(u))[0].raw_response_meta as Record<string, unknown>).selection, "census");
      assert.equal(await selectionCount("census"), 3);
      assert.equal(await selectionCount("retest"), 37);
    });

    const spendToday = async (units: string) => {
      const main = byUrl.get("https://main.example/old")!;
      await db.insert(schema.x402L1Purchases).values({
        endpointId: await idOf(main.url),
        status: "settled",
        payer: "0x0000000000000000000000000000000000000001",
        network: "eip155:8453",
        asset: BASE_USDC,
        payTo: "0x00000000000000000000000000000000000000ee",
        amountUnits: units,
        spentUnits: units,
      });
    };

    await t.test("W2: 日次 $25 が尽きた日は census / retest の候補を取らず、そのホストへ無償の要求も出さない", async () => {
      arm({ quota: "200", min: "10" });
      await seed();
      await spendToday("25000000");
      const w = wall();
      // 主候補（LIMIT 0）を外し、census / retest の段だけを見る（主候補の budget_denied は従来どおりの別の経路）。
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 0, fetchImpl: w.fetchImpl });
      assert.equal(summary.censusCandidates, 0);
      assert.equal(summary.retestCandidates, 0);
      assert.equal(w.paid.length, 0, "支払いは 1 本も無い（金の関門は同じ）");
      assert.ok(!w.unpaid.some((u) => isCensus(u) || isRetest(u)), `census / retest のホストへ無償の要求を出さない: ${w.unpaid.join(", ")}`);
      assert.equal(await selectionCount("census") + (await selectionCount("retest")), 0, "印の行も無い");
    });

    await t.test("W2: 日次の残りより高い census / retest の候補は入れない（残り 1200 単位: census ≤1100 は入り、retest 2000 は入らない）", async () => {
      arm({ quota: "200", min: "10" });
      await seed();
      await spendToday(String(25_000_000 - 1_200));
      const w = wall();
      const summary = await runL1Batch({ getPayerUsdcBalance: FUNDED_PAYER, limit: 0, fetchImpl: w.fetchImpl });
      assert.equal(summary.retestCandidates, 0, "2000 単位の retest は残り 1200 を超える");
      assert.equal(summary.censusCandidates, CENSUS_HOSTS + 1);
      assert.ok(!w.unpaid.some(isRetest), "retest のホストへ無償の要求を出さない");
      assert.equal(w.paid[0], "https://census0.example/api", "予算の範囲の census は買う");
    });
  });
}
