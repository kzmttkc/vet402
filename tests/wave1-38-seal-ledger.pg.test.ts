// ============================================================
// 第 1 波 3.8 と 3.8b の合格試験（DB あり）。合格テストの文は
// ~/Takeshi_Automation/output/1110/factory/specs_3.7_3.8_9a_3.4.md の 3.8 と 3.8b の節。
//
// 試験は公開の入口だけを通す。GET /api/v1/observatory/traceable-by-chain、
// GET /api/v1/observatory/state、GET /api/v1/observatory/anchors と anchors/day、
// GET /api/v1/observatory/ledger-corrections。入力は DB の行で、試験が作った戻り値を
// そのまま期待値にしない。段は DB の行から settledTier で分類し直して見る。
//
// 6c-1（ファイル・ヘッド・鎖の三つ一致と、封印の後に行を変えると落ちる）、6c-4（訂正は
// 追記だけ、自社の鍵で third_party を書けない）、6c-2 の遅れ 3 日と穴の名指しは、同じ作りの
// tests/anchors-backfill.pg.test.ts、tests/ledger-corrections.pg.test.ts、
// tests/fair-review-1110.test.ts が固定している。ここでは二重に書かず、その残り
// （ヘッドが公開日より新しい、probe402 の数を一つずつ拒む、Tempo の止まった日）を足す。
//
// [guard] の 2 行は main でも満たしている形の退行止め。他の行は、この枝と fair3 の変更が無いと落ちる。
//
// 実行: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test npm run test:db
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

/** 公開の入口を読み込む。無ければ「その公開面が無い」として落とす（import の例外で止めない）。 */
async function entry<T>(path: string): Promise<T> {
  try {
    return (await import(path)) as T;
  } catch (error) {
    assert.fail(`public entry missing: ${path} (${(error as Error).message.split("\n")[0]})`);
  }
}

type Get = (req: NextRequest) => Promise<Response>;

if (!TEST_DB) {
  test("wave1 3.8 / 3.8b (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const DAY_MS = 86_400_000;
  const dayOffset = (n: number) => new Date(Date.now() + n * DAY_MS).toISOString().slice(0, 10);
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  const hex = (byte: string) => byte.repeat(32);
  const SOLANA_TX = "5".repeat(44) + "K".repeat(44);
  const BATCH_TX = `0x${hex("ba")}`;
  const BATCH_TX_IN_HASH = `0x${hex("bb")}`;

  /** 10 鎖と Robinhood（10 に入れない）。行は「既にある公開の行」の見本で、0 件の鎖を後から埋める試験ではない。 */
  const CHAIN_ROWS = [
    { label: "Base", network: "eip155:8453", tx: `0x${hex("11")}`, nonce: true, h: 3 },
    { label: "Solana", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", tx: SOLANA_TX, nonce: true, h: 4 },
    { label: "Tempo", network: "eip155:4217", tx: `0x${hex("13")}`, nonce: true, h: 5 },
    { label: "XRPL", network: "xrpl:0", tx: hex("A4"), nonce: false, h: 6 },
    { label: "Celo", network: "eip155:42220", tx: `0x${hex("15")}`, nonce: true, h: 7 },
    { label: "Arc", network: "eip155:5042", tx: `0x${hex("16")}`, nonce: true, h: 8 },
    // Stellar は auth_nonce と settlement_verified を持っていても amount_payee_only（settled-tier.ts）。
    { label: "Stellar", network: "stellar:pubnet", tx: hex("b7"), nonce: true, h: 9 },
    { label: "BNB Chain", network: "eip155:56", tx: `0x${hex("18")}`, nonce: false, h: 10 },
    { label: "Arbitrum One", network: "eip155:42161", tx: `0x${hex("19")}`, nonce: true, h: 11 },
    { label: "Avalanche C-Chain", network: "eip155:43114", tx: `0x${hex("1a")}`, nonce: true, h: 12 },
  ] as const;
  const TEN = CHAIN_ROWS.map((c) => c.label);

  test("wave1 3.8 / 3.8b through the public routes", async (t) => {
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const { settledTier } = await import("@/lib/observatory/settled-tier");
    const { formatSettledReceipt } = await import("@/lib/observatory/home-example");
    const { isPublicExplorerTxUrl } = await import("@/lib/observatory/chains");
    const db = getDb()!;
    const rows = <T>(raw: unknown) => (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];

    // 状態 API の採用数は npm を読みに行く。試験は外へ出ない（読めなければ欄ごと落ちる作り）。
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network disabled in this test");
    }) as typeof fetch;
    t.after(() => {
      globalThis.fetch = realFetch;
    });

    const resetLimits = () => db.execute(sql`TRUNCATE ip_rate_limits`);
    const endpoint = async (key: string, network: string) =>
      rows<{ id: string }>(
        await db.execute(sql`
          INSERT INTO x402_endpoints (resource_key, resource_url, method, network)
          VALUES (${key}, ${`https://${key}`}, 'GET', ${network})
          RETURNING id::text AS id
        `),
      )[0].id;
    const purchase = async (p: {
      eid: string;
      network: string;
      tx: string | null;
      nonce: boolean;
      at: string;
      meta?: unknown;
      status?: string;
    }) =>
      rows<{ id: string }>(
        await db.execute(sql`
          INSERT INTO x402_l1_purchases
            (endpoint_id, status, network, tx_hash, auth_nonce, settlement_verified, http_status_paid,
             payload_non_empty, spent_units, attempted_at, raw_response_meta)
          VALUES (${p.eid}::uuid, ${p.status ?? "settled"}, ${p.network}, ${p.tx},
                  ${p.nonce ? `0x${hex("cd")}` : null}, ${p.nonce}, 200, true, '10000',
                  ${p.at}::timestamptz, ${p.meta === undefined ? null : JSON.stringify(p.meta)}::jsonb)
          RETURNING id::text AS id
        `),
      )[0].id;

    const seedChains = async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases, x402_endpoints, ledger_anchors CASCADE`);
      const ids: Record<string, string> = {};
      for (const c of CHAIN_ROWS) {
        const eid = await endpoint(`trace-${c.label.toLowerCase().replace(/[^a-z]/g, "")}.example/api`, c.network);
        ids[c.label] = await purchase({ eid, network: c.network, tx: c.tx, nonce: c.nonce, at: hoursAgo(c.h) });
      }
      // Base にもう 1 件、弱い段（nonce 無し）。Base の強い段の例と別の一覧に出る。
      const baseEid = await endpoint("trace-base-weak.example/api", "eip155:8453");
      ids["Base weak"] = await purchase({ eid: baseEid, network: "eip155:8453", tx: `0x${hex("21")}`, nonce: false, at: hoursAgo(13) });
      // Arc の Circle Gateway。tx_hash が空でバッチ tx だけの行と、バッチ tx を tx_hash に入れた行。どちらも新しい。
      const gwEid = await endpoint("trace-arc-gateway.example/api", "eip155:5042");
      ids["Arc gateway empty"] = await purchase({
        eid: gwEid, network: "eip155:5042", tx: null, nonce: false, at: hoursAgo(1), meta: { circleGateway: { batchTx: BATCH_TX } },
      });
      ids["Arc gateway in hash"] = await purchase({
        eid: gwEid, network: "eip155:5042", tx: BATCH_TX_IN_HASH, nonce: false, at: hoursAgo(2), meta: { circleGateway: { batchTx: BATCH_TX_IN_HASH } },
      });
      // Robinhood Chain は 3.8b の 10 に入れない。
      const rhEid = await endpoint("trace-robinhood.example/api", "eip155:4663");
      ids.Robinhood = await purchase({ eid: rhEid, network: "eip155:4663", tx: `0x${hex("46")}`, nonce: true, at: hoursAgo(2) });
      return ids;
    };

    const traceable = async () => {
      const { GET } = await entry<{ GET: Get }>("@/app/api/v1/observatory/traceable-by-chain/route");
      await resetLimits();
      const res = await GET(new NextRequest("http://localhost/api/v1/observatory/traceable-by-chain"));
      assert.equal(res.status, 200, "traceable-by-chain answers 200");
      return res.json();
    };
    type Receipt = Record<string, unknown> & { purchaseId: string; tx: string; txUrl: string | null; settledTier: string; network: string };
    type Body = {
      chains: { label: string; nonceBound: Receipt | null; amountPayeeOnly: Receipt | null }[];
      lists: { nonce_bound: Receipt[]; amount_payee_only: Receipt[] };
      chainsWithoutExample: string[];
      allChainsTraceable: boolean;
      traceableCount: number;
      home: { purchaseId: string; listed: boolean } | null;
      moreThanHomeAlone: boolean;
      license: string;
      cite: string;
    };

    // ホームの 1 件の欄（HomeReceipt）。formatSettledReceipt が作る鍵の集合を正とする。
    const homeKeys = Object.keys(
      formatSettledReceipt(
        { attempted_at: "2026-11-08T12:02:00Z", resource_key: "k.example/x", network: "eip155:8453", tx_hash: `0x${hex("01")}`, spent_units: "10000", id: "x" },
        { rows: 1, settled: 1, from: "", to: "" },
      )!,
    ).sort();

    await t.test("3.8b-2: the ten public chains each have one traceable tx in the home receipt fields", async () => {
      await seedChains();
      const body = (await traceable()) as Body;
      assert.deepEqual(body.chains.map((c) => c.label).sort(), [...TEN].sort(), "exactly the ten chains, no Robinhood, Polygon or Monad");
      for (const c of body.chains) {
        const r = c.nonceBound ?? c.amountPayeeOnly;
        assert.ok(r, `${c.label} has a traceable example`);
        assert.deepEqual(Object.keys(r).filter((k) => k !== "settledTier").sort(), homeKeys, `${c.label} has the home receipt fields`);
        assert.notEqual(r.tx, "", `${c.label} tx`);
        assert.ok(isPublicExplorerTxUrl(r.txUrl), `${c.label} txUrl is a public https explorer: ${r.txUrl}`);
      }
      assert.deepEqual(body.chainsWithoutExample, []);
      assert.equal(body.allChainsTraceable, true);
      assert.ok(!JSON.stringify(body).includes(`0x${hex("46")}`), "the Robinhood row is not listed");
    });

    await t.test("3.8b-2: a chain with no settled row is named, not filled with a new purchase", async () => {
      const ids = await seedChains();
      await db.execute(sql`DELETE FROM x402_l1_purchases WHERE network = 'eip155:42220'`);
      const before = rows<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases`))[0].n;
      const body = (await traceable()) as Body;
      const after = rows<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM x402_l1_purchases`))[0].n;
      assert.equal(after, before, "reading the list does not write a purchase");
      assert.deepEqual(body.chainsWithoutExample, ["Celo"]);
      assert.equal(body.allChainsTraceable, false);
      const celo = body.chains.find((c) => c.label === "Celo")!;
      assert.equal(celo.nonceBound, null);
      assert.equal(celo.amountPayeeOnly, null);
      assert.ok(ids.Celo);
    });

    await t.test("3.8b-1: the public examples go past the home page's latest one", async () => {
      await seedChains();
      const { readHomeExample } = await import("@/lib/observatory/home-example");
      const home = await readHomeExample();
      assert.ok(home, "the home page reads a receipt from the same rows");
      const body = (await traceable()) as Body;
      assert.equal(body.home?.purchaseId, home.receipt.purchaseId);
      const ids = new Set([...body.lists.nonce_bound, ...body.lists.amount_payee_only].map((r) => r.purchaseId));
      ids.delete(home.receipt.purchaseId);
      assert.ok(ids.size >= 9, `examples other than the home one: ${ids.size}`);
      assert.equal(body.moreThanHomeAlone, true);
    });

    await t.test("3.8b-1: with only the home row, the list does not claim more", async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases, x402_endpoints CASCADE`);
      const eid = await endpoint("only-home.example/api", "eip155:8453");
      const only = await purchase({ eid, network: "eip155:8453", tx: `0x${hex("31")}`, nonce: true, at: hoursAgo(1) });
      const body = (await traceable()) as Body;
      assert.equal(body.home?.purchaseId, only);
      assert.equal(body.traceableCount, 1);
      assert.equal(body.moreThanHomeAlone, false);
    });

    await t.test("3.8b-1: with no readable home receipt, no example is made up", async () => {
      await db.execute(sql`TRUNCATE x402_l1_purchases, x402_endpoints CASCADE`);
      const body = (await traceable()) as Body;
      assert.equal(body.home, null);
      assert.equal(body.traceableCount, 0);
      assert.equal(body.moreThanHomeAlone, false);
      assert.deepEqual(body.chainsWithoutExample.sort(), [...TEN].sort());
    });

    await t.test("3.8b-3 and 6a-2: each listed row re-classifies by settledTier into its own list only", async () => {
      await seedChains();
      const body = (await traceable()) as Body;
      const db_ = rows<{ id: string; status: string; settlement_verified: boolean | null; auth_nonce: string | null; network: string }>(
        await db.execute(sql`SELECT id::text AS id, status, settlement_verified, auth_nonce, network FROM x402_l1_purchases`),
      );
      const byId = new Map(db_.map((r) => [r.id, r]));
      for (const tier of ["nonce_bound", "amount_payee_only"] as const) {
        assert.ok(body.lists[tier].length > 0, `${tier} list is not empty`);
        for (const r of body.lists[tier]) {
          const src = byId.get(r.purchaseId)!;
          const recomputed = settledTier({ status: src.status, settlementVerified: src.settlement_verified, authNonce: src.auth_nonce, network: src.network });
          assert.equal(recomputed, tier, `${r.purchaseId} re-classified`);
          assert.equal(r.settledTier, tier);
        }
      }
      const strong = new Set(body.lists.nonce_bound.flatMap((r) => [r.purchaseId, r.tx]));
      for (const r of body.lists.amount_payee_only) {
        assert.ok(!strong.has(r.purchaseId) && !strong.has(r.tx), `weak ${r.tx} is not in the strong list`);
      }
      const stellar = body.chains.find((c) => c.label === "Stellar")!;
      assert.equal(stellar.nonceBound, null, "Stellar is never nonce bound");
      assert.equal(stellar.amountPayeeOnly?.tx, hex("b7"));
      const base = body.chains.find((c) => c.label === "Base")!;
      assert.equal(base.nonceBound?.tx, `0x${hex("11")}`);
      assert.equal(base.amountPayeeOnly?.tx, `0x${hex("21")}`);
    });

    await t.test("3.8b-4: a Circle Gateway batch tx never fills the traceable tx", async () => {
      await seedChains();
      const body = (await traceable()) as Body;
      const text = JSON.stringify(body);
      assert.ok(!text.includes(BATCH_TX), "the batch tx of an empty tx_hash row is not shown");
      assert.ok(!text.includes(BATCH_TX_IN_HASH), "a batch tx written into tx_hash is not shown either");
      const arc = body.chains.find((c) => c.label === "Arc")!;
      assert.equal(arc.nonceBound?.tx, `0x${hex("16")}`, "Arc keeps its own older transfer");
      for (const r of [...body.lists.nonce_bound, ...body.lists.amount_payee_only]) {
        assert.notEqual(r.settlementSource, "circle_gateway");
      }
    });

    await t.test("3.8-6c-5: the traceable list keeps CC-BY-4.0 and the KIZUNA Creation cite", async () => {
      await seedChains();
      const body = (await traceable()) as Body;
      assert.equal(body.license, "CC-BY-4.0");
      assert.match(body.cite, /^KIZUNA Creation\. /);
    });

    await t.test("3.8-6a-1: the state API keeps the two settled tiers apart and Stellar is not nonce bound", async () => {
      await seedChains();
      const { GET } = await entry<{ GET: Get }>("@/app/api/v1/observatory/state/route");
      const { validateL1SettledTwoTier } = await entry<{
        validateL1SettledTwoTier: (l1: unknown) => { ok: boolean };
      }>("@/lib/observatory/settled-two-tier");
      await resetLimits();
      const res = await GET(new NextRequest("http://localhost/api/v1/observatory/state"));
      assert.equal(res.status, 200);
      const body = await res.json();
      const l1 = body.l1;
      const expected = rows<{ bound: number; weak: number; settled: number }>(
        await db.execute(sql`
          SELECT count(*) FILTER (WHERE status = 'settled' AND settlement_verified IS TRUE AND auth_nonce IS NOT NULL
                                    AND network <> 'stellar:pubnet')::int AS bound,
                 count(*) FILTER (WHERE status = 'settled' AND NOT (settlement_verified IS TRUE AND auth_nonce IS NOT NULL
                                    AND network <> 'stellar:pubnet'))::int AS weak,
                 count(*) FILTER (WHERE status = 'settled')::int AS settled
          FROM x402_l1_purchases
        `),
      )[0];
      assert.ok(expected.bound > 0 && expected.weak > 0);
      assert.equal(l1.settledNonceBound, expected.bound);
      assert.equal(l1.settledAmountPayeeOnly, expected.weak);
      assert.equal(l1.settledNonceBound + l1.settledAmountPayeeOnly, l1.settled);
      const stellar = (l1.byChain as { chain: string; settled: number; settledNonceBound: number; settledAmountPayeeOnly: number }[]).find(
        (c) => c.chain === "stellar:pubnet",
      );
      assert.ok(stellar, "Stellar is in l1.byChain");
      assert.equal(stellar.settledNonceBound, 0, "Stellar is never nonce bound");
      assert.equal(stellar.settledAmountPayeeOnly, stellar.settled);
      assert.equal(validateL1SettledTwoTier(l1).ok, true);
      for (const key of ["settledNonceBound", "settledAmountPayeeOnly"]) {
        const dropped = { ...l1 };
        delete dropped[key];
        assert.equal(validateL1SettledTwoTier(dropped).ok, false, `dropping ${key} fails`);
      }
      assert.equal(validateL1SettledTwoTier({ ...l1, settledNonceBound: l1.settled, settledAmountPayeeOnly: l1.settledAmountPayeeOnly }).ok, false, "lifting the weak tier into the strong one fails");
    });

    // ---------------- 6c: anchors（fair3 と同じ作り。ここは残りの行だけ） ----------------
    const anchorsGet = async () => {
      const { GET } = await entry<{ GET: Get }>("@/app/api/v1/observatory/anchors/route");
      await resetLimits();
      const res = await GET(new NextRequest("http://localhost/api/v1/observatory/anchors?days=60"));
      return { status: res.status, body: await res.json() };
    };
    const sealDays = async (days: string[]) => {
      const { anchorDay } = await import("@/lib/observatory/anchors");
      for (const d of days) await anchorDay(d);
    };
    const span = (from: string, to: string) => {
      const out: string[] = [];
      for (let t0 = Date.parse(`${from}T00:00:00Z`); t0 <= Date.parse(`${to}T00:00:00Z`); t0 += DAY_MS) {
        out.push(new Date(t0).toISOString().slice(0, 10));
      }
      return out;
    };

    await t.test("3.8-6c-2: a head newer than the day before publication is not a 200", async () => {
      await db.execute(sql`TRUNCATE ledger_anchors, x402_l1_purchases, x402_endpoints CASCADE`);
      await sealDays([dayOffset(-2), dayOffset(-1), dayOffset(0)]);
      const { status, body } = await anchorsGet();
      assert.equal(status, 503);
      assert.equal(body.headFreshness.headDay, dayOffset(0));
      assert.equal(body.headFreshness.code, "head_not_before_published");
    });

    await t.test("3.8-6c-2: with no head at all the anchors API is not a 200", async () => {
      await db.execute(sql`TRUNCATE ledger_anchors`);
      const { status, body } = await anchorsGet();
      assert.equal(status, 503);
      assert.equal(body.headFreshness.code, "no_head");
      assert.deepEqual(body.missingHeadDays.map((d: { day: string }) => d.day), [dayOffset(-1)]);
    });

    // probe402 の数は、それぞれ別の断言で拒む（要件 3.8 の最後の箇条）。
    await t.test("probe402 head stopped on 2026-11-04 is rejected by the public anchors JSON", async () => {
      await db.execute(sql`TRUNCATE ledger_anchors`);
      await sealDays(span("2026-10-20", "2026-11-04"));
      const { status, body } = await anchorsGet();
      assert.equal(status, 503);
      assert.equal(body.headFreshness.headDay, "2026-11-04");
      assert.equal(body.headFreshness.code, "head_too_stale");
    });

    await t.test("probe402 last anchor run on 2026-11-05 is rejected by the public anchors JSON", async () => {
      await db.execute(sql`TRUNCATE ledger_anchors`);
      await sealDays(span("2026-10-20", "2026-11-05"));
      const { status, body } = await anchorsGet();
      assert.equal(status, 503);
      assert.equal(body.headFreshness.headDay, "2026-11-05");
      assert.equal(body.headFreshness.code, "head_too_stale");
    });

    await t.test("probe402 hole on 2026-11-05 to 07 is named as no head and never filled", async () => {
      await db.execute(sql`TRUNCATE ledger_anchors`);
      await sealDays([...span("2026-10-20", "2026-11-04"), ...span("2026-11-08", dayOffset(-1))]);
      const { body } = await anchorsGet();
      const missing = body.missingHeadDays.map((d: { day: string; status: string }) => `${d.day}:${d.status}`);
      for (const d of ["2026-11-05", "2026-11-06", "2026-11-07"]) assert.ok(missing.includes(`${d}:no_head_for_day`), d);
      assert.equal(body.chainContinuity.intact, false);
      assert.deepEqual(body.chainContinuity.gaps, ["2026-11-05", "2026-11-06", "2026-11-07"]);
      const { anchorDay } = await import("@/lib/observatory/anchors");
      await assert.rejects(() => anchorDay("2026-11-06"), /過去の穴は埋めない/);
      const { GET } = await entry<{ GET: Get }>("@/app/api/v1/observatory/anchors/day/route");
      await resetLimits();
      const day = await GET(new NextRequest("http://localhost/api/v1/observatory/anchors/day?day=2026-11-06"));
      assert.equal(day.status, 404);
      assert.equal((await day.json()).status, "no_head_for_day");
    });

    await t.test("[guard] probe402 79 sealed against 76 published: every sealed day is a published head", async () => {
      const sealed = rows<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM ledger_anchors`))[0].n;
      const { body } = await anchorsGet();
      assert.equal(body.anchors.length, sealed);
      assert.ok(sealed > 0);
    });

    await t.test("[guard] probe402 1,036,753 objects and 8,133.3 MB are not figures of the anchors JSON", async () => {
      const { body } = await anchorsGet();
      const text = JSON.stringify(body);
      assert.ok(!/1,?036,?753/.test(text));
      assert.ok(!/8,?133\.3/.test(text));
    });

    await t.test("probe402 five corrections all by the operator are counted as self, never as third party", async () => {
      const { readFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      await db.execute(sql.raw("DROP TABLE IF EXISTS ledger_corrections CASCADE"));
      await db.execute(sql.raw(readFileSync(join(__dirname, "..", "scripts/sql/2026-11-10-ledger-corrections.sql"), "utf8")));
      process.env.LEDGER_CORRECTION_SELF_TOKEN = "tok-38";
      const { GET, POST } = await entry<{ GET: Get; POST: Get }>("@/app/api/v1/observatory/ledger-corrections/route");
      for (let i = 0; i < 5; i++) {
        await resetLimits();
        const r = await POST(
          new NextRequest("http://localhost/api/v1/observatory/ledger-corrections", {
            method: "POST",
            body: JSON.stringify({ kind: "self", citedDay: "2026-11-01", note: `operator ${i}` }),
            headers: { "content-type": "application/json", authorization: "Bearer tok-38" },
          }),
        );
        assert.equal(r.status, 201);
      }
      await resetLimits();
      const body = await (await GET(new NextRequest("http://localhost/api/v1/observatory/ledger-corrections"))).json();
      assert.deepEqual(body.counts, { self: 5, third_party: 0 });
      assert.ok(body.corrections.every((c: { kind: string }) => c.kind === "self"));
      // 自社のトークンを付けても third_party にはならない（署名が要る）。
      await resetLimits();
      const posed = await POST(
        new NextRequest("http://localhost/api/v1/observatory/ledger-corrections", {
          method: "POST",
          body: JSON.stringify({ kind: "third_party", citedDay: "2026-11-01", note: "operator posing" }),
          headers: { "content-type": "application/json", authorization: "Bearer tok-38" },
        }),
      );
      assert.ok(posed.status === 400 || posed.status === 403, `status ${posed.status}`);
      await resetLimits();
      const again = await (await GET(new NextRequest("http://localhost/api/v1/observatory/ledger-corrections"))).json();
      assert.deepEqual(again.counts, { self: 5, third_party: 0 });
      delete process.env.LEDGER_CORRECTION_SELF_TOKEN;
    });

    await t.test("3.8-6c-3: a day the daily job (or the Tempo lane) stopped stays without a head", async () => {
      await db.execute(sql`TRUNCATE ledger_anchors, x402_l1_purchases, x402_endpoints CASCADE`);
      const eid = await endpoint("tempo-halt.example/api", "eip155:4217");
      const halted = dayOffset(-2);
      await purchase({ eid, network: "eip155:4217", tx: `0x${hex("41")}`, nonce: true, at: `${halted}T06:00:00Z` });
      await sealDays([dayOffset(-3)]);
      // 止まった日を飛ばして、日次ジョブが次の日だけを封印する（metrics-rollup の cron と同じ呼び方）。
      const { anchorThrough } = await import("@/lib/observatory/anchors");
      const out = await anchorThrough(dayOffset(-1));
      assert.deepEqual(out.map((r) => r.day), [dayOffset(-1)], "the job seals only its own day");
      const have = rows<{ day: string }>(await db.execute(sql`SELECT day FROM ledger_anchors ORDER BY day`)).map((r) => String(r.day));
      assert.ok(!have.includes(halted), "no root was computed for the halted day");
      const { body } = await anchorsGet();
      assert.ok(body.missingHeadDays.some((d: { day: string; status: string }) => d.day === halted && d.status === "no_head_for_day"));
      assert.deepEqual(body.chainContinuity.gaps, [halted]);
    });
  });
}
