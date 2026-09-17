// ============================================================
// レーンの accept 優先の関門 — 挙動（2026-09-17 独立レビュー C2 / C4 / W1 / W5）。
//
// 守ること:
//  C2a 優先はレーン枠から来た候補にだけ。枠が無い（L1_LANE_FLOOR_PER_RUN=0）日は、Arc の accept を
//      2 番目に持つ主候補も Base で買う。
//  C2b バッチ内で Arc の別枠を使い切ったら、後続のレーン候補には優先を渡さない（Base で買う）。
//  C4  そのチェーンで非決済（settle_failed）が 1 度でも出た endpoint は secondary の枠に入らず、
//      主候補として来ても Base で買う。settle_claimed も決済主張として数える（別ファイルで固定）。
//  W1  Solana 主ネットワークの endpoint は、Solana で settled 済みでも Solana の枠に載る（従来の意味）。
//  W5  raw_accepts が `arc` スラグだけの行は枠に載らない（実行時と同じ完全一致）。
//
// Run: TEST_DATABASE_URL=postgres://localhost/vet402_observatory_test \
//   npx tsx --test --test-force-exit --test-concurrency=1 tests/l1-lane-preference-gate.pg.test.ts
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("l1 lane preference gate (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
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
  const BASE = "eip155:8453";

  test("L1 lane preference gate", async (t) => {
    const { Keypair } = await import("@solana/web3.js");
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncCatalog } = await import("@/lib/observatory/catalog-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { parseCatalogItem } = await import("@/lib/observatory/catalog-source");
    const { BASE_USDC } = await import("@/lib/observatory/x402-payer");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const db = getDb()!;
    const solPayTo = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(70 + n)).publicKey.toBase58();
    const solKeypair = Keypair.fromSeed(new Uint8Array(32).fill(9));

    const saved = {
      l1: process.env.OBSERVATORY_L1_ENABLED,
      pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY,
      arcOn: process.env.OBSERVATORY_ARC_L1_ENABLED,
      arcCap: process.env.L1_ARC_DAILY_CAP_USD,
      solOn: process.env.OBSERVATORY_SOLANA_L1_ENABLED,
      solKey: process.env.OBSERVATORY_SOLANA_SECRET_KEY,
      floor: process.env.L1_LANE_FLOOR_PER_RUN,
    };
    const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
    t.after(() => {
      restore("OBSERVATORY_L1_ENABLED", saved.l1);
      restore("OBSERVATORY_WALLET_PRIVATE_KEY", saved.pk);
      restore("OBSERVATORY_ARC_L1_ENABLED", saved.arcOn);
      restore("L1_ARC_DAILY_CAP_USD", saved.arcCap);
      restore("OBSERVATORY_SOLANA_L1_ENABLED", saved.solOn);
      restore("OBSERVATORY_SOLANA_SECRET_KEY", saved.solKey);
      restore("L1_LANE_FLOOR_PER_RUN", saved.floor);
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    process.env.OBSERVATORY_ARC_L1_ENABLED = "true";
    process.env.OBSERVATORY_SOLANA_L1_ENABLED = "true";
    process.env.OBSERVATORY_SOLANA_SECRET_KEY = Buffer.from(solKeypair.secretKey).toString("base64");

    const method = { extensions: { bazaar: { info: { input: { method: "GET" } } } } };
    const hi = { quality: { l30DaysTotalCalls: 5000, l30DaysUniquePayers: 500 } };
    const lo = { quality: { l30DaysTotalCalls: 10, l30DaysUniquePayers: 1 } };
    const baseAccept = (n: number, amount = "3000") => ({ scheme: "exact", network: BASE, amount, asset: BASE_USDC, payTo: payToFor(n), maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } });
    const arcAccept = (n: number, amount = "4000", network = ARC_CAIP2) => ({ scheme: "exact", network, amount, asset: ARC_USDC, payTo: payToFor(n), maxTimeoutSeconds: 300, extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2", acceptId: "arc-usdc-circle" } });
    const solAccept = (n: number) => ({ scheme: "exact", network: SOL_CAIP2, amount: "4000", asset: SOL_USDC, payTo: solPayTo(n), maxTimeoutSeconds: 60, extra: { feePayer: FEE_PAYER } });

    type Item = { url: string; accepts: unknown[]; demand: "hi" | "lo" };
    let ACCEPTS: Record<string, unknown[]> = {};
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
        const network = accepted?.network ?? BASE;
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
      const paidNet = (url: string) => seen.filter((s) => s.paid && s.url === url).map((s) => s.network);
      return { seen, fetchImpl, paidNet };
    };

    async function seed(items: Item[]) {
      ACCEPTS = Object.fromEntries(items.map((i) => [i.url, i.accepts]));
      await db.execute(
        sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases, observed_purchases`,
      );
      const list = items.map((i) => parseCatalogItem({ resource: i.url, accepts: i.accepts, ...method, ...(i.demand === "hi" ? hi : lo) }));
      await syncCatalog({ fetchResult: { items: list, totalCount: list.length, fetchedCount: list.length, complete: true }, today: "2026-09-17" });
      await runL0ProbeBatch({ limit: 20, concurrency: 2, fetchImpl: async (url: string) => new Response(challengeFor(url), { status: 402, headers: { "content-type": "application/json" } }) });
    }
    /** endpoint に network の行（status）を daysAgo 日前に置く。 */
    async function history(url: string, network: string, status: string, daysAgo: number, payTo: string) {
      await db.execute(sql`
        INSERT INTO x402_l1_purchases (endpoint_id, attempted_at, status, payer, network, asset, pay_to, amount_units, spent_units, tx_hash)
        SELECT e.id, now() - make_interval(days => ${daysAgo}), ${status}, 'payer', ${network}, 'asset', ${payTo}, '4000', '4000',
               ${status === "settled" || status === "settle_claimed" ? `0x${(daysAgo + 10).toString(16).padStart(2, "0").repeat(32)}` : null}
        FROM x402_endpoints e WHERE e.resource_url = ${url}`);
    }
    const run = async (w: ReturnType<typeof wall>) =>
      await runL1Batch({ limit: 10, fetchImpl: w.fetchImpl, getSolanaBlockhash: async () => BLOCKHASH, getPayerUsdcBalance: async () => 1_000_000_000n });

    await t.test("C2a: 枠が無い日（L1_LANE_FLOOR_PER_RUN=0）は、Arc を 2 番目に持つ主候補も Base で買う", async () => {
      process.env.L1_LANE_FLOOR_PER_RUN = "0";
      delete process.env.L1_ARC_DAILY_CAP_USD;
      try {
        await seed([{ url: "https://exa.example/search", accepts: [baseAccept(1), arcAccept(1)], demand: "hi" }]);
        const w = wall();
        const summary = await run(w);
        assert.equal(summary.laneFloor.arc ?? 0, 0);
        assert.deepEqual(w.paidNet("https://exa.example/search"), [BASE], "主候補には優先を掛けない");
      } finally {
        delete process.env.L1_LANE_FLOOR_PER_RUN;
      }
    });

    await t.test("C2b: バッチ内で Arc の別枠を使い切ったら、後続のレーン候補は Base で買う", async () => {
      process.env.L1_ARC_DAILY_CAP_USD = "0.5"; // 500,000 units
      try {
        await seed([
          { url: "https://exa1.example/search", accepts: [baseAccept(1), arcAccept(1, "400000")], demand: "lo" },
          { url: "https://exa2.example/search", accepts: [baseAccept(2, "300000"), arcAccept(2, "400000")], demand: "lo" },
        ]);
        const w = wall();
        const summary = await run(w);
        assert.equal(summary.laneFloor.arc, 2, "両方レーン枠に載る");
        const nets = [...w.paidNet("https://exa1.example/search"), ...w.paidNet("https://exa2.example/search")];
        assert.deepEqual(nets.sort(), [BASE, ARC_CAIP2].sort(), "1 件目は Arc（別枠 0.5 の内側）、2 件目は別枠を使い切ったので Base");
        const raw = await db.execute(sql`SELECT coalesce(sum(spent_units::numeric), 0)::text AS s FROM x402_l1_purchases WHERE network = ${ARC_CAIP2}`);
        assert.equal(Number(((Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as { s: string }[])[0].s), 400_000, "Arc の支出は別枠以内");
      } finally {
        delete process.env.L1_ARC_DAILY_CAP_USD;
      }
    });

    await t.test("C4: Arc で settle_failed が 1 度でも出た endpoint は枠に載らず、主候補としては Base で買う", async () => {
      await seed([{ url: "https://exa.example/search", accepts: [baseAccept(1), arcAccept(1)], demand: "hi" }]);
      await history("https://exa.example/search", ARC_CAIP2, "settle_failed", 8, payToFor(1));
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.laneFloor.arc ?? 0, 0, "非決済の履歴がある endpoint は secondary の枠に入らない");
      assert.deepEqual(w.paidNet("https://exa.example/search"), [BASE]);
    });

    await t.test("W1: Solana 主ネットワークの endpoint は Solana で settled 済みでも Solana の枠に載る（従来の意味）", async () => {
      await seed([{ url: "https://solseller1.example/api", accepts: [solAccept(1)], demand: "lo" }]);
      await history("https://solseller1.example/api", SOL_CAIP2, "settled", 8, solPayTo(1));
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.laneFloor.solana, 1, "主ネットワーク一致の枝には settled の除外を掛けない");
      assert.deepEqual(w.paidNet("https://solseller1.example/api"), [SOL_CAIP2]);
    });

    await t.test("W5: raw_accepts が `arc` スラグだけの行は枠に載らず、Base で買う（実行時と同じ完全一致）", async () => {
      await seed([{ url: "https://slug.example/api", accepts: [baseAccept(1), arcAccept(1, "4000", "arc")], demand: "lo" }]);
      const w = wall();
      const summary = await run(w);
      assert.equal(summary.laneFloor.arc ?? 0, 0);
      assert.deepEqual(w.paidNet("https://slug.example/api"), [BASE]);
    });
  });
}
