/**
 * vet402 × LangChain — check trust BEFORE your agent pays, as a tool call.
 *
 * `createVouchSpendGuardTool()` wraps Vouch SpendGuard in a
 * `DynamicStructuredTool` so a LangChain agent can ask "may I pay this
 * wallet?" before it moves money. The tool only decides — it never touches
 * keys, funds, or transaction signing. Execution stays with your wallet
 * stack (Coinbase AgentKit, Privy, ...).
 *
 * Fail-closed contract (same as the SDK default, trustPolicy "allow-only"):
 * anything but a clean ALLOW verdict — WARN/BLOCK, a degraded or partial
 * read, a stale score, or a failed lookup — returns `allow: false`. The tool
 * NEVER throws for a deny and never throws for a lookup failure either: an
 * unexpected error becomes `{ allow: false, failClosed: true }`, because an
 * agent that crashes mid-decision must not fall through to paying.
 *
 * Runs with zero configuration: without VOUCH_API_KEY the demo below enters
 * dry-run mode — the trust lookup answers 401 locally (offline, no network),
 * which exercises the guard's REAL fail-closed path: no verdict, no payment.
 * Same design as ../hackathon-starter.
 */
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  createVouchClient,
  type SpendDecision,
  type SpendGuardPolicy,
  type VouchClientOptions,
} from "@vet402/sdk";

const spendGuardSchema = z.object({
  payee: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "payee must be a 0x wallet address")
    .describe("Wallet address (0x...) the agent is about to pay"),
  amountUsd: z
    .number()
    .positive()
    .describe("Payment amount in USD"),
});

export type VouchSpendGuardToolOptions = {
  /** Passed straight to createVouchClient — apiKey required. */
  client: VouchClientOptions;
  /**
   * SpendGuard policy. Defaults to `{ maxPerTxUsd: 10, dailyBudgetUsd: 50 }`
   * with the SDK's fail-closed trustPolicy "allow-only" untouched.
   */
  policy?: SpendGuardPolicy;
};

/** What the tool hands back to the agent, as a JSON string. */
export type VouchSpendGuardToolResult = {
  allow: boolean;
  /** Machine-readable deny reasons (empty when allowed). */
  reasons: string[];
  payee: string;
  amountUsd: number;
  /** True when the deny came from an error path, not a scored verdict. */
  failClosed: boolean;
  /** One-line instruction the agent can follow verbatim. */
  guidance: string;
  payeeScore: {
    score: number;
    recommendation: string;
    dataDepth: string;
  } | null;
};

/**
 * Build the SpendGuard decision as a LangChain tool. One guard instance
 * lives behind the tool, so its in-memory daily budget counter spans every
 * call the agent makes in this process (and resets on restart).
 */
export function createVouchSpendGuardTool(options: VouchSpendGuardToolOptions) {
  const vouch = createVouchClient(options.client);
  const guard = vouch.createSpendGuard(
    options.policy ?? { maxPerTxUsd: 10, dailyBudgetUsd: 50 },
  );

  return new DynamicStructuredTool({
    name: "vouch_spend_guard",
    description:
      "MUST be called before paying any wallet. Checks the payee's vet402 " +
      "trust score and the local spend policy (per-tx cap, daily budget) and " +
      "returns an allow/deny decision. If allow is false, DO NOT pay — the " +
      "reasons field says why. This tool only decides; it never moves money.",
    schema: spendGuardSchema,
    func: async ({ payee, amountUsd }): Promise<string> => {
      let result: VouchSpendGuardToolResult;
      try {
        const decision: SpendDecision = await guard.evaluate({
          payee,
          amountUsd,
        });
        result = {
          allow: decision.allow,
          reasons: decision.reasons,
          payee: decision.payee,
          amountUsd: decision.amountUsd,
          failClosed: false,
          guidance: decision.allow
            ? "ALLOW — you may hand this payment to the wallet stack. " +
              "If you end up not executing it, budget was already reserved."
            : "DENY — do not pay this wallet. Do not retry with a smaller " +
              "amount unless the reason is max_per_tx_exceeded or " +
              "daily_budget_exceeded.",
          payeeScore: decision.payeeScore
            ? {
                score: decision.payeeScore.score,
                recommendation: decision.payeeScore.recommendation,
                dataDepth: decision.payeeScore.dataDepth,
              }
            : null,
        };
      } catch (err) {
        // invalid_payee_address / invalid_amount_usd from the guard, or
        // anything else unexpected: fail closed instead of throwing, so the
        // agent gets an explicit "no" rather than an exception it might
        // route around.
        result = {
          allow: false,
          reasons: [err instanceof Error ? err.message : "unknown_error"],
          payee,
          amountUsd,
          failClosed: true,
          guidance: "DENY (fail-closed) — the guard could not evaluate this payment. Do not pay.",
          payeeScore: null,
        };
      }
      return JSON.stringify(result);
    },
  });
}

// --------------------------------------------------------------------------
// Demo: invoke the tool exactly the way a LangChain agent executor would.
// Without VOUCH_API_KEY this is a dry run — the injected fetch answers 401
// locally and the guard denies with payee_trust_unauthenticated (the real
// fail-closed path, not a mock happy path).
// --------------------------------------------------------------------------

const PAYEE =
  process.env.DEMO_PAYEE ?? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const apiKey = process.env.VOUCH_API_KEY;
const dryRun = !apiKey;

const offlineFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ error: "missing_api_key" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

if (dryRun) {
  console.log("VOUCH_API_KEY is not set — dry-run mode (offline).");
  console.log("The trust lookup answers 401 locally; the guard fails CLOSED.");
  console.log("Get a key at https://vet402.com/dashboard/keys to go live.\n");
}

const tool = createVouchSpendGuardTool({
  client: {
    apiKey: apiKey ?? "dry-run-placeholder",
    ...(process.env.VOUCH_API_URL ? { apiUrl: process.env.VOUCH_API_URL } : {}),
    ...(dryRun ? { fetch: offlineFetch } : {}),
  },
});

console.log(`Tool: ${tool.name}`);
console.log(`Calling with { payee: ${PAYEE}, amountUsd: 1 } ...\n`);

const raw = await tool.invoke({ payee: PAYEE, amountUsd: 1 });
const parsed = JSON.parse(raw) as VouchSpendGuardToolResult;

console.log(JSON.stringify(parsed, null, 2));
console.log(
  parsed.allow
    ? "\nALLOW — hand off to your wallet stack (AgentKit, Privy, ...)."
    : `\nDENY — reasons: ${parsed.reasons.join(", ")}`,
);
console.log(
  dryRun
    ? "Done (dry-run). Set VOUCH_API_KEY for live verdicts."
    : "Done.",
);
