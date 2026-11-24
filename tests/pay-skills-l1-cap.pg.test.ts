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

    const pin = PAYSH_PINNED_PURCHASES.find((p) => p.reason === "presign-gate-2611")!;
    const listing = PAY_SKILLS_LISTINGS.find((l) => l.url === pin.url)!;
    assert.equal(listing.network, SOLANA_MAINNET_CAIP2);

    const insideMs = Date.parse("2026-11-27T12:00:00.000Z");
    const saved = {
      l1: process.env.OBSERVATORY_L1_ENABLED,
      sol: process.env.OBSERVATORY_SOLANA_L1_ENABLED,
      pk: process.env.OBSERVATORY_WALLET_PRIVATE_KEY,
      cap: process.env.L1_SOLANA_DAILY_CAP_USD,
    };
    t.after(() => {
      for (const [k, v] of Object.entries({ OBSERVATORY_L1_ENABLED: saved.l1, OBSERVATORY_SOLANA_L1_ENABLED: saved.sol, OBSERVATORY_WALLET_PRIVATE_KEY: saved.pk, L1_SOLANA_DAILY_CAP_USD: saved.cap })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    process.env.OBSERVATORY_L1_ENABLED = "true";
    process.env.OBSERVATORY_SOLANA_L1_ENABLED = "true";
    process.env.OBSERVATORY_WALLET_PRIVATE_KEY = TEST_PK;
    delete process.env.L1_SOLANA_DAILY_CAP_USD;

    const db = getDb()!;
    await db.execute(
      sql`TRUNCATE x402_endpoints, x402_catalog_snapshots, x402_l0_probes, x402_delisting_events, x402_payee_watchers, x402_l1_purchases`,
    );
    await syncPaySkillsListings({ listings: [listing], today: "2026-11-27" });
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
              },
            ],
          }),
          { status: 402, headers: { "content-type": "application/json" } },
        ),
    });

    const cap = solanaDailyCapUnits();
    await db.execute(sql`
      INSERT INTO x402_l1_purchases (endpoint_id, status, payer, network, asset, pay_to, amount_units, spent_units, attempted_at)
      SELECT id, 'settled', 'FakePayer', ${listing.network}, ${listing.asset}, ${listing.payTo}, '1', ${String(cap)}, now()
      FROM x402_endpoints WHERE resource_url = ${listing.url}
    `);

    let tx = 0;
    const summary = await runL1Batch({
      limit: 3,
      now: () => insideMs,
      getPayerUsdcBalance: FUNDED_PAYER,
      fetchImpl: async (url, init) => {
        if (init?.headers && (new Headers(init.headers).has("PAYMENT-SIGNATURE") || new Headers(init.headers).has("X-PAYMENT"))) {
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
            accepts: [{ scheme: "exact", network: listing.network, amount: listing.amount, asset: listing.asset, payTo: listing.payTo }],
          }),
          { status: 402, headers: { "content-type": "application/json" } },
        );
      },
    });

    const purchases = await db.select().from(schema.x402L1Purchases);
    const pinRows = purchases.filter(
      (p) => (p.rawResponseMeta as Record<string, unknown> | null)?.pinnedPurchaseReason === "presign-gate-2611",
    );
    assert.equal(pinRows.length, 0, `expected no new presign buy, skipped=${summary.skipped}`);
    assert.ok(summary.skipped > 0 || summary.chainDailyCap >= 0);
  });
}