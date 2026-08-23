/**
 * SpendGuard demo — pre-payment checks for an autonomous agent.
 *
 * Part 1 uses a purely local policy (per-tx cap + daily budget), so its
 * allow/deny sequence is deterministic in any environment:
 *   1. normal payment      → allow
 *   2. above per-tx cap    → deny (max_per_tx_exceeded)
 *   3a. within budget      → allow
 *   3b. budget exhausted   → deny (daily_budget_exceeded)
 *
 * Part 2 adds the trust rules, which query the live Payee Trust API
 * (`GET /v1/payees/{address}/score`) — its verdict depends on the payee and
 * the environment (a local dev server with SKIP_CHAIN_READS=true scores
 * every unknown wallet low, so expect a deny there).
 *
 * The guard only *decides*. Nothing here holds keys or moves funds — see
 * agentkit-integration.ts for where the decision plugs into a real wallet
 * stack (Coinbase AgentKit).
 */
import { createVouchClient, type SpendDecision } from "@vet402/sdk";

const apiKey = process.env.VOUCH_API_KEY;
if (!apiKey) {
  console.error("VOUCH_API_KEY is required");
  process.exit(1);
}

const vouch = createVouchClient({
  apiUrl: process.env.VOUCH_API_URL ?? "http://localhost:3000/api/v1",
  apiKey,
});

// Any syntactically valid address works for the demo; unknown payees still
// score (dataDepth: "thin") instead of 404ing.
const payee =
  process.env.DEMO_PAYEE ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function print(label: string, decision: SpendDecision) {
  const verdict = decision.allow ? "ALLOW" : `DENY (${decision.reasons.join(", ")})`;
  const score = decision.payeeScore
    ? ` payeeScore=${decision.payeeScore.score} ${decision.payeeScore.recommendation} dataDepth=${decision.payeeScore.dataDepth}`
    : "";
  console.log(
    `${label}: ${verdict} — $${decision.amountUsd} | spentToday=$${decision.spentTodayUsd}` +
      ` remaining=${decision.remainingDailyBudgetUsd ?? "n/a"}${score}`,
  );
}

// --- Part 1: local policy only (deterministic, no API calls) --------------

const localGuard = vouch.createSpendGuard({ maxPerTxUsd: 5, dailyBudgetUsd: 12 });

console.log("Part 1 — local policy (per-tx cap $5, daily budget $12):");
print("  1. normal payment  ", await localGuard.evaluate({ payee, amountUsd: 4 }));
print("  2. over per-tx cap ", await localGuard.evaluate({ payee, amountUsd: 7 }));
print("  3a. within budget  ", await localGuard.evaluate({ payee, amountUsd: 4 }));
print("  3b. budget runs out", await localGuard.evaluate({ payee, amountUsd: 4.5 }));

// --- Part 2: trust rules (live Payee Trust API lookup) ---------------------

const trustGuard = vouch.createSpendGuard({
  minPayeeScore: 30,
  blockOnRecommendation: true,
});

console.log("\nPart 2 — trust policy (minPayeeScore 30, blockOnRecommendation):");
print("  4. trust-gated pay ", await trustGuard.evaluate({ payee, amountUsd: 4 }));
