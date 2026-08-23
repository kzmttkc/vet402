/**
 * vet402 × Solana Agent Kit (v2) — check trust BEFORE your agent pays,
 * as a plugin.
 *
 * `VouchPlugin` exposes one action, VOUCH_SPEND_GUARD: when the agent is
 * about to pay a wallet, the action asks Vouch SpendGuard for an allow/deny
 * decision. The action only decides — it never touches keys, funds, or
 * transaction signing. Execution stays with the kit's wallet and payment
 * plugins (e.g. @solana-agent-kit/plugin-token's TRANSFER action).
 *
 * Fail-closed contract (the SDK default, trustPolicy "allow-only"): anything
 * but a clean ALLOW verdict — a low or degraded score, a stale read, a
 * failed lookup, or a payee address vet402 cannot score — denies. When
 * VOUCH_API_KEY is not set, the action still runs: the trust lookup answers
 * 401 locally (offline, no network), which exercises the guard's REAL
 * fail-closed path: no verdict, no payment. Same design as
 * ../elizaos-plugin and ../hackathon-starter.
 *
 * Coverage note (honest by design): vet402 scores EVM settlement addresses
 * (`0x` + 40 hex) today. A base58 Solana payee is accepted as INPUT — the
 * action classifies it, reports it as unscorable, and denies fail-closed
 * (`payee_unscorable_address`) instead of guessing. An address the guard
 * cannot vet is an address the agent does not pay.
 *
 * Zero solana-agent-kit dependency on purpose: the interfaces below are
 * minimal structural mirrors of solana-agent-kit v2 (verified 2026-08-20
 * against sendaifun/solana-agent-kit branch `v2`,
 * packages/core/src/types/action.ts + types/index.ts + agent/index.ts:
 * Action {name, similes, description, examples: ActionExample[][],
 * schema: z.ZodType, handler: (agent, input) => Promise<Record<string,
 * any>>}, ActionExample {input, output, explanation}, Plugin {name,
 * methods, actions, initialize(agent): void}, and
 * SolanaAgentKit.use(plugin) which calls plugin.initialize(agent), binds
 * plugin.methods and pushes plugin.actions). Because the types are
 * structural, the exported objects typecheck as real solana-agent-kit
 * Action / Plugin values when you paste them into a v2 project — see
 * README. `zod` is a real dependency here because Action.schema is a zod
 * schema in the real API.
 */
import { z } from "zod";
import {
  createVouchClient,
  SpendGuard,
  type SpendDecision,
  type VouchClient,
} from "@vet402/sdk";

// --- Minimal structural mirrors of solana-agent-kit v2 types ---------------

/**
 * Mirror of SolanaAgentKit, reduced to what this plugin reads. The real
 * class carries connection/wallet/methods/actions too; this plugin
 * deliberately reads only `config` (it must never see key material).
 */
export interface AgentLike {
  config: {
    OTHER_API_KEYS?: Record<string, string>;
  };
}

/** Mirror of solana-agent-kit ActionExample. */
export interface ActionExampleLike {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  explanation: string;
}

/** Mirror of solana-agent-kit Handler. */
export type HandlerLike = (
  agent: AgentLike,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** Mirror of solana-agent-kit Action. */
export interface ActionLike {
  name: string;
  similes: string[];
  description: string;
  examples: ActionExampleLike[][];
  schema: z.ZodType<unknown>;
  handler: HandlerLike;
}

/** Mirror of solana-agent-kit Plugin. */
export interface PluginLike {
  name: string;
  methods: Record<string, unknown>;
  actions: ActionLike[];
  initialize(agent: AgentLike): void;
}

// --- Payee address classification ------------------------------------------

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export type PayeeFormat = "evm" | "base58" | "unknown";

/** Classify a payee address. vet402 scores "evm" today; see README. */
export function classifyPayee(payee: string): PayeeFormat {
  if (EVM_RE.test(payee)) return "evm";
  if (BASE58_RE.test(payee)) return "base58";
  return "unknown";
}

// --- Guard wiring ----------------------------------------------------------

const offlineFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ error: "missing_api_key" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

// One guard per agent: the in-memory daily budget counter must span every
// payment this agent considers in this process (it resets on restart).
const guards = new WeakMap<AgentLike, { client: VouchClient; guard: SpendGuard }>();

function readKey(agent: AgentLike, key: string): string | undefined {
  // The kit's Config has no vet402-specific fields; OTHER_API_KEYS is the
  // real API's designated bag for exactly this (types/index.ts, branch v2).
  return agent.config.OTHER_API_KEYS?.[key] ?? process.env[key] ?? undefined;
}

function getGuard(agent: AgentLike): { client: VouchClient; guard: SpendGuard } {
  const existing = guards.get(agent);
  if (existing) return existing;

  const apiKey = readKey(agent, "VOUCH_API_KEY");
  const apiUrl = readKey(agent, "VOUCH_API_URL");
  const dryRun = !apiKey || apiKey.trim() === "";

  const client = createVouchClient({
    apiKey: dryRun ? "dry-run-placeholder" : apiKey,
    ...(apiUrl ? { apiUrl } : {}),
    // Without a key the lookup answers 401 locally — the guard then denies
    // fail-closed (payee_trust_unauthenticated) instead of paying blind.
    ...(dryRun ? { fetch: offlineFetch } : {}),
  });

  const maxPerTx = Number(readKey(agent, "VOUCH_MAX_PER_TX_USD") ?? 10);
  const dailyBudget = Number(readKey(agent, "VOUCH_DAILY_BUDGET_USD") ?? 50);
  const guard = client.createSpendGuard({
    maxPerTxUsd: Number.isFinite(maxPerTx) ? maxPerTx : 10,
    dailyBudgetUsd: Number.isFinite(dailyBudget) ? dailyBudget : 50,
    // trustPolicy defaults to "allow-only": fail-closed.
  });

  const entry = { client, guard };
  guards.set(agent, entry);
  return entry;
}

// --- The action ------------------------------------------------------------

const spendGuardSchema = z.object({
  payee: z
    .string()
    .min(32, "Payee must be a wallet address (0x... or base58)")
    .describe("The wallet address the agent is about to pay"),
  amountUsd: z
    .number()
    .positive("Amount must be a positive USD value")
    .describe("The payment amount in USD"),
});

export const vouchSpendGuardAction: ActionLike = {
  name: "VOUCH_SPEND_GUARD",
  similes: [
    "check payee trust",
    "verify before paying",
    "spend guard",
    "should I pay this wallet",
    "vet payee",
  ],
  description:
    "Run this BEFORE paying any wallet, and do not pay when it denies. " +
    "Checks the payee's vet402 trust score plus the local spend policy " +
    "(per-tx USD cap, daily budget) and returns allow/deny with " +
    "machine-readable reasons. Decision only — never moves money. " +
    "Inputs: payee (wallet address), amountUsd (payment amount in USD).",

  examples: [
    [
      {
        input: {
          payee: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amountUsd: 5,
        },
        output: {
          status: "success",
          allow: true,
          payee: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amountUsd: 5,
          reasons: [],
          payeeScore: 82,
          recommendation: "ALLOW",
          remainingDailyBudgetUsd: 45,
          message: "ALLOW — $5 passes the spend policy (payee score 82).",
        },
        explanation:
          "The payee scored well and the amount fits the local policy, so the payment may proceed.",
      },
    ],
    [
      {
        input: {
          payee: "0x000000000000000000000000000000000000dEaD",
          amountUsd: 500,
        },
        output: {
          status: "success",
          allow: false,
          payee: "0x000000000000000000000000000000000000dEaD",
          amountUsd: 500,
          reasons: ["max_per_tx_exceeded"],
          message:
            "DENY — do not pay. Reasons: max_per_tx_exceeded. No clean ALLOW verdict, no payment (fail-closed).",
        },
        explanation:
          "The amount exceeds the per-transaction cap, so the agent must not pay.",
      },
    ],
  ],

  schema: spendGuardSchema,

  handler: async (agent, input) => {
    const parsed = spendGuardSchema.safeParse(input);
    if (!parsed.success) {
      // Unreadable request: refuse rather than guess (fail-closed).
      return {
        status: "error",
        allow: false,
        reasons: ["invalid_input"],
        message:
          "Could not read a payee address and a positive USD amount — " +
          "no payment (fail-closed). " +
          parsed.error.issues.map((i) => i.message).join("; "),
      };
    }
    const { payee, amountUsd } = parsed.data;

    // vet402 scores EVM settlement addresses today. A base58 payee is a
    // valid input but an unscorable one — deny explicitly instead of
    // letting the SDK throw or, worse, waving the payment through.
    const format = classifyPayee(payee);
    if (format !== "evm") {
      const reason =
        format === "base58" ? "payee_unscorable_address" : "invalid_payee_address";
      return {
        status: "success",
        allow: false,
        payee,
        amountUsd,
        payeeFormat: format,
        reasons: [reason],
        message:
          format === "base58"
            ? `DENY — ${payee} is a base58 (Solana) address; vet402 scores ` +
              "EVM settlement addresses (0x...) today, so this payee cannot " +
              "be vetted. No verdict, no payment (fail-closed)."
            : `DENY — ${payee} is not a recognizable wallet address. ` +
              "No verdict, no payment (fail-closed).",
      };
    }

    let decision: SpendDecision;
    try {
      decision = await getGuard(agent).guard.evaluate({ payee, amountUsd });
    } catch (err) {
      // invalid_amount_usd or anything unexpected: fail closed with an
      // explicit "no" instead of throwing into the agent loop.
      return {
        status: "error",
        allow: false,
        payee,
        amountUsd,
        reasons: ["spend_guard_error"],
        message: `Spend check failed (${
          err instanceof Error ? err.message : "unknown_error"
        }) — do not pay ${payee} (fail-closed).`,
      };
    }

    const score = decision.payeeScore;
    const message = decision.allow
      ? `ALLOW — $${amountUsd} to ${payee} passes the spend policy` +
        (score ? ` (payee score ${score.score}, ${score.recommendation})` : "") +
        `. Remaining daily budget: $${decision.remainingDailyBudgetUsd ?? "n/a"}.`
      : `DENY — do not pay ${payee}. Reasons: ${decision.reasons.join(", ")}. ` +
        "No clean ALLOW verdict, no payment (fail-closed).";

    // A DENY verdict is a successful evaluation, not an error; the verdict
    // is machine-readable so a downstream payment action can gate on
    // `allow` and the kit's LLM loop can explain `reasons`.
    return {
      status: "success",
      allow: decision.allow,
      payee,
      amountUsd,
      payeeFormat: format,
      reasons: decision.reasons,
      ...(score
        ? {
            payeeScore: score.score,
            recommendation: score.recommendation,
            dataDepth: score.dataDepth,
          }
        : {}),
      ...(decision.remainingDailyBudgetUsd !== undefined
        ? { remainingDailyBudgetUsd: decision.remainingDailyBudgetUsd }
        : {}),
      message,
    };
  },
};

// --- The plugin ------------------------------------------------------------

/**
 * Register with `agent.use(VouchPlugin)`. Methods land on `agent.methods.*`
 * (the kit binds them), the action joins `agent.actions` for the LLM loop.
 */
export const VouchPlugin: PluginLike = {
  name: "vouch-spend-guard",

  methods: {
    /** Raw payee trust lookup (EVM address). Throws on non-EVM input. */
    checkPayeeTrust(agent: AgentLike, payee: string) {
      return getGuard(agent).client.getPayeeScore(payee);
    },
    /** Full spend decision: local policy + payee trust, fail-closed. */
    evaluateSpend(agent: AgentLike, payee: string, amountUsd: number) {
      return vouchSpendGuardAction.handler(agent, { payee, amountUsd });
    },
    /**
     * Return an allowed-but-unspent reservation to today's budget (call
     * when the transfer failed or was skipped after an ALLOW).
     */
    releaseSpend(agent: AgentLike, amountUsd: number) {
      getGuard(agent).guard.release(amountUsd);
    },
  },

  actions: [vouchSpendGuardAction],

  initialize(_agent: AgentLike): void {
    // Guards are created lazily per agent (see getGuard) so that config
    // set after .use() is still honored. Nothing to do here.
  },
};

export default VouchPlugin;

// --------------------------------------------------------------------------
// Demo: run the action handler the way SolanaAgentKit's executor would.
// `npx tsx index.ts` — without VOUCH_API_KEY this is a dry run (offline 401,
// real fail-closed deny). Set VOUCH_API_KEY for live verdicts.
// --------------------------------------------------------------------------

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const dryRun = !process.env.VOUCH_API_KEY;
  if (dryRun) {
    console.log("VOUCH_API_KEY is not set — dry-run mode (offline).");
    console.log("The trust lookup answers 401 locally; the guard fails CLOSED.");
    console.log("Get a key at https://vet402.com/dashboard/keys to go live.\n");
  }

  // Stand-in for `new SolanaAgentKit(wallet, rpcUrl, config)`: the only part
  // this plugin reads is `config`, and the real Config's designated slot for
  // third-party keys is OTHER_API_KEYS.
  const agent: AgentLike = {
    config: {
      OTHER_API_KEYS: {
        ...(process.env.VOUCH_API_KEY
          ? { VOUCH_API_KEY: process.env.VOUCH_API_KEY }
          : {}),
        ...(process.env.VOUCH_API_URL
          ? { VOUCH_API_URL: process.env.VOUCH_API_URL }
          : {}),
      },
    },
  };

  // Stand-in for the payment tool the agent would call NEXT (e.g.
  // @solana-agent-kit/plugin-token's TRANSFER action). The demo proves the
  // gate: this function must never run without a clean ALLOW.
  let transfersExecuted = 0;
  const mockTransferTool = async (payee: string, amountUsd: number) => {
    transfersExecuted += 1;
    console.log(`  [transfer tool] EXECUTED: $${amountUsd} -> ${payee}`);
  };

  const payIfAllowed = async (payee: string, amountUsd: number) => {
    const verdict = await vouchSpendGuardAction.handler(agent, {
      payee,
      amountUsd,
    });
    console.log(`  verdict: allow=${verdict.allow} reasons=[${(verdict.reasons as string[]).join(", ")}]`);
    console.log(`  message: ${verdict.message}`);
    if (verdict.allow === true) {
      await mockTransferTool(payee, amountUsd); // AgentKit-of-Solana's job
    } else {
      console.log("  [transfer tool] NOT invoked — guard denied.");
    }
  };

  const EVM_PAYEE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const SOL_PAYEE = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  console.log("Case 1 — EVM payee, $1 (within local policy):");
  await payIfAllowed(EVM_PAYEE, 1);

  console.log("\nCase 2 — EVM payee, $999 (over the $10 per-tx cap, deterministic):");
  await payIfAllowed(EVM_PAYEE, 999);

  console.log("\nCase 3 — base58 (Solana) payee, $1 (unscorable today):");
  await payIfAllowed(SOL_PAYEE, 1);

  console.log(`\nTransfers executed: ${transfersExecuted}`);
  console.log(
    dryRun
      ? "Done (dry-run): every path above denied fail-closed and the " +
          "transfer tool was never invoked. Set VOUCH_API_KEY for live verdicts."
      : "Done.",
  );
}
