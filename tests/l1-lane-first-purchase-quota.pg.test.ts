// ============================================================
// 初回購入の日次枠は別枠レーンに掛からない — 予約と候補選び（2026-09-17・本番 21:5x の穴）。
//
// 守ること（初回購入の枠 FIRST_PURCHASE_DAILY_QUOTA を当日ぶん使い切った状態で）:
//  1. Solana・Arc の枠候補（購入行がまだ無いエンドポイント）は先頭に載り、予約が通り、
//     支払い付きで買われて行が書かれる（別枠 $2/日の内側）。
//  2. Base の未購入エンドポイントは従来どおり除外されたまま（1 リクエストも出ず、行も無い）。
//  3. Base の買い直し（購入履歴あり）は従来どおり続く。
//  4. 主ネットワークが Base で Arc の accept を 2 番目に持つ行（exa 相当）も、Arc の枠候補として
//     初回購入できる（レーンの accept 優先と組み合わせ）。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-lane-first-purchase-quota.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 lane first-purchase quota (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const payToFor = (n: number) => `0x${String(n % 10).repeat(40)}`;
  const SOL_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const FEE_PAYER = "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd";
  const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
  const ARC_CAIP2 = "eip155:5042";
  const ARC_USDC = "0x3600000000000000000000000000000000000000";

  test("L1 lane first-purchase quota", async (t) => {
    const { Keypair } = await import("@solana/web3.js");
    const { runL1Batch, FIRST_PURCHASE_DAILY_QUOTA } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const solPayTo = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(60 + n)).publicKey.toBase58();
    const solKeypair = Keypair.fromSeed(new Uint8Array(32).fill(9));

    const saved = {
      l1: process.env.OBSERVATORY_L1_ENABLED,
      pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY,
      arcOn: process.env.OBSERVATORY_ARC_L1_ENABLED,
      solOn: process.env.OBSERVATORY_SOLANA_L1_ENABLED,
      solKey: process.env.OBSERVATORY_SOLANA_SECRET_KEY,
      floor: process.env.L1_LANE_FLOOR_PER_RUN,
    };
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    t.after(() => {
      restore("OBSERVATORY_L1_ENABLED", saved.l1);
      restore("OBSERVATORY_WALLET_PRIVATE_KEY", saved.pk);
      restore("OBSERVATORY_ARC_L1_ENABLED", saved.arcOn);
      restore("OBSERVATORY_SOLANA_L1_ENABLED", saved.solOn);
      restore("OBSERVATORY_SOLANA_SECRET_KEY", saved.solKey);
      restore("L1_LANE_FLOOR_PER_RUN", saved.floor);
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
    process.env.OBSERVATORY_SOLANA_L1_ENABLED = "true";
    process.env.OBSERVATORY_SOLANA_SECRET_KEY = Buffer.from(solKeypair.secretKey).toString("base64");
    delete process.env.L1_LANE_FLOOR_PER_RUN;

    const URLS = {
      baseNew: "https://basenew.example/api",
      baseRepeat: "https://baserepeat.example/api",
      arc1: "https://arcseller1.example/api",
      exa: "https://api.exa.example/search",
      sol1: "https://solseller1.example/api",
    };
    const method = { extensions: { bazaar: { info: { input: { method: "GET" } } } } };
    const hi = { quality: { l30DaysTotalCalls: 5000, l30DaysUniquePayers: 500 } };
    const lo = { quality: { l30DaysTotalCalls: 10, l30DaysUniquePayers: 1 } };
    const baseAccept = (n: number) => ({ scheme: "exact", network: "eip155:8453", amount: "3000", asset: BASE_USDC, payTo: payToFor(n), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } });
    const arcAccept = (n: number) => ({ scheme: "exact", network: ARC_CAIP2, amount: "4000", asset: ARC_USDC, payTo: payToFor(n), maxTimeoutSeconds: 300, extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2", acceptId: "arc-usdc-circle" } });
    const solAccept = (n: number) => ({ scheme: "exact", network: SOL_CAIP2, amount: "4000", asset: SOL_USDC, payTo: solPayTo(n), maxTimeoutSeconds: 60, extra: { feePayer: FEE_PAYER } });
    const ACCEPTS: Record<string, unknown[]> = {
      [URLS.baseNew]: [baseAccept(1)],
      [URLS.baseRepeat]: [baseAccept(2)],
      [URLS.arc1]: [arcAccept(3)],
      [URLS.exa]: [baseAccept(4), arcAccept(4)],
      [URLS.sol1]: [solAccept(1)],
    };
    const items = () => [
      parseCatalogItem({ resource: URLS.baseNew, accepts: ACCEPTS[URLS.baseNew], ...method, ...hi }),
      parseCatalogItem({ resource: URLS.baseRepeat, accepts: ACCEPTS[URLS.baseRepeat], ...method, ...hi }),
      parseCatalogItem({ resource: URLS.arc1, accepts: ACCEPTS[URLS.arc1], ...method, ...lo }),
      parseCatalogItem({ resource: URLS.exa, accepts: ACCEPTS[URLS.exa], ...method, ...lo }),
      parseCatalogItem({ resource: URLS.sol1, accepts: ACCEPTS[URLS.sol1], ...method, ...lo }),
    ];
    const challengeFor = (url: string) => JSON.stringify({ x402Version: 2, accepts: ACCEPTS[url] ?? [] });

    let txSeq = 0;
    const wall = () => {
      const seen: { url: string; paid: boolean; network: string | null }[] = [];
      const fetchImpl = async (url: string, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const sig = headers.get("PAYMENT-SIGNATURE") ?? headers.get("X-PAYMENT");
        const accepted = sig ? ((JSON.parse(Buffer.from(sig, "base64").toString("utf8")) as { accepted?: { network?: string } }).accepted ?? null) : null;
        seen.push({ url, paid: sig !== null, network: accepted?.network ?? null });
        if (!sig) return new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } });
        txSeq += 1;
        const network = accepted?.network ?? "eip155:8453";
        const isSol = network.startsWith("solana:");
        const tx = isSol
          ? `5SoLSig${"abcdefghjkmnpqrstuvwxyz"[txSeq % 23].repeat(4)}${"ABCDEFGHJKLMNPQRSTUVWXYZ".repeat(4)}`.slice(0, 88)
          : `0x${txSeq.toString(16).padStart(4, "0").repeat(16)}`;
        return new Response(JSON.stringify({ data: "goods" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "PAYMENT-RESPONSE": Buffer.from(JSON.stringify({ success: true, transaction: tx, network, payer: isSol ? FEE_PAYER : "0x0000000000000000000000000000000000000001" })).toString("base64"),
          },
        });
      };
      return { seen, fetchImpl };
    };

    async function seed() {
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      const list = items();
      await syncCatalog({ fetchResult: { items: list, totalCount: list.length, fetchedCount: list.length, complete: true }, today: "2026-09-17" });
      await runL0ProbeBatch({ limit: 10, concurrency: 2, fetchImpl: async (url: string) => new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } }) });
    }
    /** baseRepeat に 7 日前の settled 行（買い直しの対象）。 */
    async function historyForRepeat() {
      await db.execute(sql`
        INSERT INTO x402_l1_purchases (endpoint_id, attempted_at, status, payer, network, asset, pay_to, amount_units, spent_units, tx_hash)
        SELECT e.id, now() - interval '7 days', 'settled', '0x0000000000000000000000000000000000000001', 'eip155:8453', ${BASE_USDC}, ${payToFor(2)}, '3000', '3000', ${`0x${"ee".repeat(32)}`}
        FROM x402_endpoints e WHERE e.resource_url = ${URLS.baseRepeat}`);
    }
    /** その UTC 日の初回購入を枠いっぱい（無関係な endpoint_id で）置く。 */
    async function fillFirstPurchases(count: number) {
      await db.execute(sql`
        INSERT INTO x402_l1_purchases (endpoint_id, attempted_at, status, payer, network, asset, pay_to, amount_units, spent_units)
        SELECT gen_random_uuid(), (date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc') + interval '1 second', 'settled',
               '0x0000000000000000000000000000000000000001', 'eip155:8453', ${BASE_USDC}, '0x0000000000000000000000000000000000000002', '0', '0'
        FROM generate_series(1, ${count})`);
    }
    const rowsFor = async (url: string) => {
      const raw = await db.execute(sql`
        SELECT pu.status, pu.network FROM x402_l1_purchases pu JOIN x402_endpoints e ON e.id = pu.endpoint_id
        WHERE e.resource_url = ${url} ORDER BY pu.attempted_at`);
      return ((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { status: string; network: string }[]).map((r) => ({ status: r.status, network: r.network }));
    };
    const paid = (w: ReturnType<typeof wall>, url: string) => w.seen.filter((s) => s.paid && s.url === url);
    const touched = (w: ReturnType<typeof wall>, url: string) => w.seen.some((s) => s.url === url);

    await seed();
    await historyForRepeat();
    await fillFirstPurchases(FIRST_PURCHASE_DAILY_QUOTA);
    const w = wall();
    const summary = await runL1Batch({ limit: 10, fetchImpl: w.fetchImpl, getSolanaBlockhash: async () => BLOCKHASH, getPayerUsdcBalance: async () => 1_000_000_000n });

    await t.test("Solana・Arc の枠候補（購入行なし）は先頭に載り、予約が通り、買われる", async () => {
      assert.equal(summary.laneFloor.solana, 1, `laneFloor=${JSON.stringify(summary.laneFloor)}`);
      assert.equal(summary.laneFloor.arc, 2, "Arc 主ネットワークの 1 件 + exa 相当（Arc が 2 番目）の 1 件");
      assert.equal(paid(w, URLS.sol1).length, 1);
      assert.equal(paid(w, URLS.arc1).length, 1);
      assert.equal(paid(w, URLS.exa).length, 1);
      assert.equal(paid(w, URLS.exa)[0].network, ARC_CAIP2, "exa は Arc の accept で初回購入");
      assert.deepEqual(await rowsFor(URLS.sol1), [{ status: "settle_claimed", network: SOL_CAIP2 }]);
      assert.deepEqual(await rowsFor(URLS.arc1), [{ status: "settle_claimed", network: ARC_CAIP2 }]);
      assert.deepEqual(await rowsFor(URLS.exa), [{ status: "settle_claimed", network: ARC_CAIP2 }]);
    });

    await t.test("Base の未購入は除外されたまま（1 リクエストも出ず、行も無い）。買い直しは続く", async () => {
      assert.equal(touched(w, URLS.baseNew), false, "初回購入の枠は Base に従来どおり効く");
      assert.deepEqual(await rowsFor(URLS.baseNew), []);
      assert.equal(paid(w, URLS.baseRepeat).length, 1, "購入履歴のある Base は買い直す");
      assert.equal((await rowsFor(URLS.baseRepeat)).length, 2);
    });

    await t.test("レーンの支出は別枠の内側（Arc 8000・Solana 4000）で、日次 $25 の合計にも載る", async () => {
      const raw = await db.execute(sql`
        SELECT network, coalesce(sum(spent_units::numeric), 0)::text AS s FROM x402_l1_purchases
        WHERE attempted_at >= (date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc') GROUP BY network`);
      const by = Object.fromEntries(((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { network: string; s: string }[]).map((r) => [r.network, Number(r.s)]));
      assert.equal(by[ARC_CAIP2], 8000);
      assert.equal(by[SOL_CAIP2], 4000);
      assert.equal(summary.spentUnitsTotal, String(8000 + 4000 + 3000));
    });
  });
}
