// ============================================================
// pay.sh 予約 + Solana 別枠 $2: 偽支出で当日枠を埋めたら買わない。
// ============================================================
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { assertTestDatabaseIsNotProduction } from "./helpers/pg-test-guard";

const FUNDED_PAYER = async () => 1_000_000_000n;
const TEST_DB = process.env.TEST_DATABASE_URL;

if (!TEST_DB) {
  test("pay-skills l1 cap (skipped: TEST_DATABASE_URL not set)", { skip: true }, () => {});
} else {
  assertTestDatabaseIsNotProduction(TEST_DB);
  process.env.DATABASE_URL = TEST_DB;

  const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

  after(async () => {
    const { getDb } = await import("@/lib/db/client");
    const db = getDb() as unknown as { $client?: { end?: () => Promise<void> } } | null;
    await db?.$client?.end?.();
  });

  test("Solana chain cap blocks further pinned pay_skills buys same UTC day", async (t) => {
    const { runL1Batch } = await import("@/lib/observatory/l1-runner");
    const { syncPaySkillsListings } = await import("@/lib/observatory/pay-skills-sync");
    const { runL0ProbeBatch } = await import("@/lib/observatory/probe-runner");
    const { PAY_SKILLS_LISTINGS } = await import("@/lib/observatory/pay-skills-listings");
    const { PAYSH_PINNED_PURCHASES } = await import("@/lib/observatory/pay-skills-pinned-data");
    const { SOLANA_USDC_MINT, SOLANA_MAINNET_CAIP2 } = await import("@/lib/observatory/sol402-payer");
    const { solanaDailyCapUnits } = await import("@/lib/observatory/budget");
    const { getDb } = await import("@/lib/db/client");
    const { sql } = await import("drizzle-orm");
    const schema = await import("@/lib/db/schema");

    const { Keypair } = await import("@solana/web3.js");
    const pin = PAYSH_PINNED_PURCHASES.find((p) => p.reason === "presign-gate-2611")!;
    const listing = PAY_SKILLS_LISTINGS.find((l) => l.url === pin.url)!;
    // 2026-11-24: the day's Solana spend is pre-filled on a different listing. A row on the target
    // itself counts as its one pinned purchase, so the batch never picked it (CI: attempted 0, seen []).
    const filler = PAY_SKILLS_LISTINGS.find(
      (l) => l.network === listing.network && l.payTo !== listing.payTo && new URL(l.url).host !== new URL(listing.url).host,
    )!;
    assert.ok(filler, "a second Solana pay.sh listing with another host and payTo exists");
    assert.equal(listing.network, SOLANA_MAINNET_CAIP2);
    const listingAmount = BigInt(listing.amount);
    const solKeypair = Keypair.fromSeed(new Uint8Array(32).fill(9));
    const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";
    // Solana x402 needs extra.feePayer. Without it the runner records no_fee_payer before reserveSpend (CI 2026-11-24).
    const FEE_PAYER = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58();

    const insideMs = Date.parse("2026-11-27T12:00:00.000Z");
    const saved = {
      l1: process.env.OBSERVATORY_L1_ENABLED,
      sol: process.env.OBSERVATORY_SOLANA_L1_ENABLED,
      solKey: process.env.OBSERVATORY_SOLANA_SECRET_KEY,
      pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY,
      cap: process.env.L1_SOLANA_DAILY_CAP_USD,
    };
    t.after(() => {
      for (const [k, v] of Object.entries({
        OBSERVATORY_L1_ENABLED: saved.l1,
        OBSERVATORY_SOLANA_L1_ENABLED: saved.sol,
        OBSERVATORY_SOLANA_SECRET_KEY: saved.solKey,
        OBSERVATORY_WALLET_PRIVATE_KEY: saved.pk,
        L1_SOLANA_DAILY_CAP_USD: saved.cap,
      })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_SOLANA_L1_ENABLED = "true";
    process.env.OBSERVATORY_SOLANA_SECRET_KEY = Buffer.from(solKeypair.secretKey).toString("base64");
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    delete process.env.L1_SOLANA_DAILY_CAP_USD;

    const db = getDb()!;
    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases`,
    );
    await syncPaySkillsListings({ listings: [listing, filler], today: "2026-11-27" });
  await runL0ProbeBatch({
      limit: 5,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            x402Version: 2,
            accepts: [
              {
                scheme: "exact",
                network: listing.network,
                amount: listing.amount,
                asset: listing.asset,
                payTo: listing.payTo,
                maxTimeoutSeconds: 300,
                extra: { feePayer: FEE_PAYER },
              },
            ],
          }),
          { status: 402, headers: { "content-type": "application/json" } },
        ),
    });

  // 別枠ちょうど埋めると候補 SQL が Solana を丸ごと外し purchaseOne まで届かない（l1-runner.ts 2633–2655）。
  // 1 件分足りない残りにして reserveSpend の chain_daily_cap 経路（4608–4611・1660–1661）を踏む。
    const cap = solanaDailyCapUnits();
    const prefillUnits = cap - listingAmount + 1n;
    assert.ok(prefillUnits > 0n && prefillUnits < cap, "prefill leaves room in lane SQL but not for this purchase");
    await db.execute(sql`
      INSERT INTO x402_l1_purchases (endpoint_id, status, payer, network, asset, pay_to, amount_units, spent_units, attempted_at)
      SELECT id, 'settled', 'FakePayer', ${filler.network}, ${filler.asset}, ${filler.payTo}, '1', ${String(prefillUnits)}, now()
      FROM x402_endpoints WHERE resource_url = ${filler.url}
    `);

    let tx = 0;
    const seen: { url: string; paid: boolean }[] = [];
    const summary = await runL1Batch({
      limit: 3,
      now: () => insideMs,
      getPayerUsdcBalance: FUNDED_PAYER,
      getSolanaBlockhash: async () => BLOCKHASH,
      fetchImpl: async (url, init) => {
        const paid = !!(init?.headers && (new Headers(init.headers).has("PAYMENT-SIGNATURE") || new Headers(init.headers).has("X-PAYMENT")));
        seen.push({ url, paid });
        if (paid) {
          tx++;
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "PAYMENT-RESPONSE": Buffer.from(
                JSON.stringify({ success: true, transaction: `SolTx${tx}`, network: listing.network }),
              ).toString("base64"),
            },
          });
        }
        return new Response(
          JSON.stringify({
            x402Version: 2,
            accepts: [{ scheme: "exact", network: listing.network, amount: listing.amount, asset: listing.asset, payTo: listing.payTo, maxTimeoutSeconds: 60, extra: { feePayer: FEE_PAYER } }],
          }),
          { status: 402, headers: { "content-type": "application/json" } },
        );
      },
    });

    const purchases = await db.select().from(schema.x402L1Purchases);
    const pinRows = purchases.filter(
      (p) => (p.rawResponseMeta as Record<string, unknown> | null)?.pinnedPurchaseReason === "presign-gate-2611",
    );
    const pinDbg = JSON.stringify(
      { tx, seen, pinRows: pinRows.map((r) => ({ status: r.status, spent: r.spentUnits, http: r.httpStatusPaid, meta: r.rawResponseMeta })), skipped: summary.skipped, attempted: summary.attempted },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    );
    assert.equal(pinRows.length, 0, `expected no new presign buy ${pinDbg}`);
    assert.equal(tx, 0, "Solana 別枠を使い切った日は支払い付きを出さない");
    const dbg = JSON.stringify({ summary, seen }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    assert.ok(summary.skipped > 0, `別枠で買えない候補は skipped に数える ${dbg}`);
    assert.ok(
      seen.some((s) => s.url === listing.url && !s.paid),
      `予約枠の内側で 402 を取りに行き、支払い付きには進まない ${dbg}`,
    );
    assert.ok(!seen.some((s) => s.paid), "chain_daily_cap で署名しない");
    const solSpent = await db.execute(sql`
      SELECT coalesce(sum(spent_units::numeric), 0)::text AS s
      FROM x402_l1_purchases
      WHERE network = ${listing.network} AND attempted_at >= (date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc')
    `);
    const spentToday = (
      (Array.isArray(solSpent) ? solSpent : (solSpent as { rows?: unknown[] }).rows ?? []) as { s: string }[]
    )[0]!.s;
    assert.ok(BigInt(spentToday.split(".")[0]) <= cap, `Solana 当日 spent ${spentToday} must stay <= ${cap}`);
    assert.equal(BigInt(spentToday.split(".")[0]), prefillUnits, "新しい Solana 支出は無い");
    const solRows = purchases.filter((p) => p.network === listing.network);
    assert.equal(solRows.length, 1, "台帳の Solana 行は当日枠を埋めた 1 件だけ");
  });
}