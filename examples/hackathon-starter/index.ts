/**
 * vet402 hackathon starter — check trust BEFORE your agent pays.
 *
 * The whole pattern in one file:
 *
 *   1. Look up the payee's trust score  (getPayeeScore)
 *   2. Ask SpendGuard for an allow/deny (fail-closed: no clean ALLOW → no payment)
 *   3. ALLOW  → hand off to your wallet stack for the x402 payment (template below)
 *      DENY   → skip the payment, log the machine-readable reasons
 *   4. After a real payment settles → attest it back (template below)
 *
 * Runs with zero configuration: without VOUCH_API_KEY it enters dry-run mode,
 * where the trust lookup answers 401 locally (offline, no network). That is
 * not a mocked "happy path" — it exercises the guard's REAL fail-closed code
 * path: no verdict, no payment. Set VOUCH_API_KEY to go live.
 *
 * SpendGuard is strictly non-custodial: it decides, it never touches keys,
 * funds, signing, or transaction submission. Execution stays with your wallet
 * stack (Coinbase AgentKit, Privy, ...) — see
 * ../agentkit-spend-guard/src/agentkit-integration.ts for where the decision
 * plugs into a real wallet.
 */
import {
  createVouchClient,
  VouchApiError,
  type SpendDecision,
} from "@vet402/sdk";

// Any syntactically valid address works; unknown payees still score
// (dataDepth: "thin") instead of 404ing. Override with DEMO_PAYEE.
const PAYEE =
  process.env.DEMO_PAYEE ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AMOUNT_USD = 1;

const apiKey = process.env.VOUCH_API_KEY;
const dryRun = !apiKey;

if (dryRun) {
  console.log("VOUCH_API_KEY is not set — dry-run mode (offline).");
  console.log(
    "The trust lookup will answer 401 locally, which is exactly the case",
  );
  console.log(
    "SpendGuard fails CLOSED on: no verdict, no payment. Get a key at",
  );
  console.log("https://vet402.com/dashboard/keys to go live.\n");
}

// Dry-run injects a fetch that answers 401 without touching the network, so
// the starter runs anywhere and still goes through the real deny logic.
const offlineFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ error: "missing_api_key" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

const vouch = createVouchClient({
  apiKey: apiKey ?? "dry-run-placeholder",
  // apiUrl defaults to https://vet402.com/api/v1 — set VOUCH_API_URL to point
  // at a local dev server (see ../../README.md for running one).
  ...(process.env.VOUCH_API_URL ? { apiUrl: process.env.VOUCH_API_URL } : {}),
  ...(dryRun ? { fetch: offlineFetch } : {}),
});

// --- 1. Payee trust lookup: "should my agent pay this wallet?" ------------

console.log(`1. Payee trust lookup: ${PAYEE}`);
try {
  const payee = await vouch.getPayeeScore(PAYEE);
  console.log(
    `   score=${payee.score} recommendation=${payee.recommendation}` +
      ` dataDepth=${payee.dataDepth}`,
  );
} catch (err) {
  if (err instanceof VouchApiError) {
    console.log(
      `   lookup refused: ${err.code} (HTTP ${err.status}) — no verdict yet.`,
    );
  } else {
    throw err;
  }
}

// --- 2. SpendGuard: one allow/deny decision, fail-closed by default -------

const guard = vouch.createSpendGuard({
  maxPerTxUsd: 10, // deny any single payment above $10
  dailyBudgetUsd: 50, // deny once today's allowed total would pass $50
  // trustPolicy defaults to "allow-only": anything but a clean ALLOW —
  // WARN/BLOCK, a degraded or partial read, or a failed lookup — denies.
});

console.log(`\n2. SpendGuard decision for $${AMOUNT_USD} -> ${PAYEE}`);
const decision: SpendDecision = await guard.evaluate({
  payee: PAYEE,
  amountUsd: AMOUNT_USD,
});

if (decision.allow) {
  console.log(
    `   ALLOW — spentToday=$${decision.spentTodayUsd}` +
      ` remaining=$${decision.remainingDailyBudgetUsd ?? "n/a"}`,
  );

  // --- 3. ALLOW → execute the x402 payment with YOUR wallet stack ---------
  //
  // The guard only decides; it never signs or moves funds. Wire your own
  // execution here. The AgentKit shape (from
  // ../agentkit-spend-guard/src/agentkit-integration.ts):
  //
  //   const transfer = await walletProvider.nativeTransfer(
  //     PAYEE as `0x${string}`,
  //     usdToAsset(AMOUNT_USD),
  //   );
  //
  // Testnet walkthrough (no real money):
  //   1. Point your wallet stack at Base Sepolia (networkId "base-sepolia").
  //   2. Fund the agent wallet with testnet ETH/USDC from a faucet
  //      (e.g. the Coinbase Developer Platform faucet).
  //   3. Pay an x402 endpoint that accepts testnet settlement, or your own
  //      x402 server — ../x402-trust-gate has a runnable seller-side gate.
  //   4. If the transfer fails or you skip it, return the budget
  //      reservation: guard.release(AMOUNT_USD);
  //
  // --- 4. After the payment settles → attest it back ----------------------
  //
  // Feeding settled payments back weights future scores (idempotent on
  // txHash). Same call the MCP server's attest_x402_payment tool makes:
  //
  //   await vouch.attestX402Payment({
  //     wallet: PAYEE,
  //     txHash: transfer, // 0x… transaction hash
  //     resource: "/api/premium/data",
  //   });
  //
  console.log(
    "   (payment execution is left to your wallet stack — see the",
  );
  console.log("   commented template in this file, steps 3 and 4)");
} else {
  // --- 3'. DENY → do NOT pay. Log the machine-readable reasons. -----------
  console.log(`   DENY — reasons: ${decision.reasons.join(", ")}`);
  console.log("   Fail-closed: without a clean ALLOW verdict, no money moves.");
}

console.log(
  dryRun
    ? "\nDone (dry-run). Set VOUCH_API_KEY for live verdicts."
    : "\nDone.",
);
