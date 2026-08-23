/**
 * vet402 × ElizaOS — check trust BEFORE your agent pays, as an Action.
 *
 * `vouchPlugin` exposes one action, VOUCH_SPEND_GUARD: when the agent is
 * about to pay a wallet, the action asks Vouch SpendGuard for an allow/deny
 * decision. The action only decides — it never touches keys, funds, or
 * transaction signing. Execution stays with whatever wallet plugin your
 * character uses.
 *
 * Fail-closed contract (the SDK default, trustPolicy "allow-only"): anything
 * but a clean ALLOW verdict — WARN/BLOCK, a degraded or partial read, a
 * stale score, or a failed lookup — denies. When VOUCH_API_KEY is not set,
 * the action still runs: the trust lookup answers 401 locally (offline, no
 * network), which exercises the guard's REAL fail-closed path: no verdict,
 * no payment. Same design as ../hackathon-starter.
 *
 * Zero ElizaOS dependency on purpose: the interfaces below are minimal
 * structural mirrors of @elizaos/core (packages/core/src/types/components.ts
 * and plugin.ts on elizaOS/eliza develop, verified 2026-08-20: Action
 * {name, description, similes?, examples?, validate, handler}, Handler
 * (runtime, message, state?, options?, callback?) => Promise<ActionResult |
 * undefined>, Plugin {name, description, actions?}). Because the types are
 * structural, the exported objects typecheck as real @elizaos/core Action /
 * Plugin values when you paste them into an ElizaOS project — see README.
 */
import {
  createVouchClient,
  SpendGuard,
  type SpendDecision,
  type VouchClient,
} from "@vet402/sdk";

// --- Minimal structural mirrors of @elizaos/core types --------------------

/** Mirror of IAgentRuntime, reduced to what this action reads. */
export interface RuntimeLike {
  getSetting(key: string): string | boolean | number | null;
}

/** Mirror of Memory, reduced to the message text. */
export interface MessageLike {
  content: { text?: string };
}

/** Mirror of HandlerCallback (used to speak the verdict into the chat). */
export type CallbackLike = (content: {
  text: string;
}) => Promise<unknown> | unknown;

/** Mirror of @elizaos/core ActionResult (the fields this action uses). */
export interface ActionResultLike {
  success: boolean;
  text?: string;
  data?: Record<string, unknown>;
  error?: string;
}

/** Mirror of @elizaos/core Action. */
export interface ActionLike {
  name: string;
  description: string;
  similes?: string[];
  examples?: { name: string; content: { text: string } }[][];
  validate: (runtime: RuntimeLike, message: MessageLike) => Promise<boolean>;
  handler: (
    runtime: RuntimeLike,
    message: MessageLike,
    state?: unknown,
    options?: Record<string, unknown>,
    callback?: CallbackLike,
  ) => Promise<ActionResultLike>;
}

/** Mirror of @elizaos/core Plugin. */
export interface PluginLike {
  name: string;
  description: string;
  actions?: ActionLike[];
}

// --- Guard wiring ----------------------------------------------------------

const WALLET_RE = /0x[a-fA-F0-9]{40}/;
const AMOUNT_RE = /(?:\$|usd\s*)?(\d+(?:\.\d+)?)\s*(?:usd|dollars?|\$)?/i;

const offlineFetch: typeof fetch = async () =>
  new Response(JSON.stringify({ error: "missing_api_key" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });

// One guard per runtime: the in-memory daily budget counter must span every
// payment the character considers in this process (it resets on restart).
const guards = new WeakMap<RuntimeLike, { client: VouchClient; guard: SpendGuard }>();

function getGuard(runtime: RuntimeLike): { client: VouchClient; guard: SpendGuard } {
  const existing = guards.get(runtime);
  if (existing) return existing;

  const apiKey = runtime.getSetting("VOUCH_API_KEY");
  const apiUrl = runtime.getSetting("VOUCH_API_URL");
  const dryRun = typeof apiKey !== "string" || apiKey.trim() === "";

  const client = createVouchClient({
    apiKey: dryRun ? "dry-run-placeholder" : (apiKey as string),
    ...(typeof apiUrl === "string" && apiUrl ? { apiUrl } : {}),
    // Without a key the lookup answers 401 locally — the guard then denies
    // fail-closed (payee_trust_unauthenticated) instead of paying blind.
    ...(dryRun ? { fetch: offlineFetch } : {}),
  });

  const maxPerTx = Number(runtime.getSetting("VOUCH_MAX_PER_TX_USD") ?? 10);
  const dailyBudget = Number(runtime.getSetting("VOUCH_DAILY_BUDGET_USD") ?? 50);
  const guard = client.createSpendGuard({
    maxPerTxUsd: Number.isFinite(maxPerTx) ? maxPerTx : 10,
    dailyBudgetUsd: Number.isFinite(dailyBudget) ? dailyBudget : 50,
    // trustPolicy defaults to "allow-only": fail-closed.
  });

  const entry = { client, guard };
  guards.set(runtime, entry);
  return entry;
}

/** Pull { payee, amountUsd } from action options or from the message text. */
export function extractPaymentIntent(
  message: MessageLike,
  options?: Record<string, unknown>,
): { payee: string | null; amountUsd: number | null } {
  const optPayee = typeof options?.payee === "string" ? options.payee : null;
  const optAmount =
    typeof options?.amountUsd === "number" ? options.amountUsd : null;
  const text = message.content.text ?? "";
  const payee = optPayee ?? text.match(WALLET_RE)?.[0] ?? null;
  let amountUsd = optAmount;
  if (amountUsd === null) {
    // Strip the address first so "0x12…" hex digits never parse as a price.
    const withoutAddress = text.replace(WALLET_RE, " ");
    const m = withoutAddress.match(AMOUNT_RE);
    amountUsd = m ? Number(m[1]) : null;
  }
  return { payee, amountUsd };
}

// --- The action ------------------------------------------------------------

export const vouchSpendGuardAction: ActionLike = {
  name: "VOUCH_SPEND_GUARD",
  similes: ["CHECK_PAYEE_TRUST", "VERIFY_BEFORE_PAYING", "SPEND_GUARD"],
  description:
    "Run this BEFORE paying any wallet. Checks the payee's vet402 trust " +
    "score plus the local spend policy (per-tx cap, daily budget) and " +
    "returns allow/deny. On deny, the agent must not pay. Decision only — " +
    "never moves money.",

  validate: async (_runtime, message) => {
    // Relevant whenever the message names a wallet address.
    return WALLET_RE.test(message.content.text ?? "");
  },

  handler: async (runtime, message, _state, options, callback) => {
    const { payee, amountUsd } = extractPaymentIntent(message, options);
    if (!payee || !amountUsd || amountUsd <= 0) {
      const text =
        "I could not find a payee wallet address and a USD amount in this " +
        "request, so I will not approve any payment (fail-closed).";
      await callback?.({ text });
      return { success: false, text, error: "missing_payee_or_amount" };
    }

    let decision: SpendDecision;
    const { guard } = getGuard(runtime);
    try {
      decision = await guard.evaluate({ payee, amountUsd });
    } catch (err) {
      // invalid_payee_address / invalid_amount_usd or anything unexpected:
      // fail closed with an explicit "no" instead of throwing.
      const text = `Spend check failed (${
        err instanceof Error ? err.message : "unknown_error"
      }) — do not pay ${payee} (fail-closed).`;
      await callback?.({ text });
      return { success: false, text, error: "spend_guard_error" };
    }

    const score = decision.payeeScore;
    const text = decision.allow
      ? `ALLOW — $${amountUsd} to ${payee} passes the spend policy` +
        (score ? ` (payee score ${score.score}, ${score.recommendation})` : "") +
        `. Remaining daily budget: $${decision.remainingDailyBudgetUsd ?? "n/a"}.`
      : `DENY — do not pay ${payee}. Reasons: ${decision.reasons.join(", ")}. ` +
        "No clean ALLOW verdict, no payment (fail-closed).";
    await callback?.({ text });

    // The evaluation itself succeeded — a DENY verdict is a successful
    // result, not an error. The verdict lives in data.decision.
    return {
      success: true,
      text,
      data: { decision: decision as unknown as Record<string, unknown> },
    };
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: {
          text: "Pay 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 $5 for the API access",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Let me check that payee with vet402 before any money moves.",
        },
      },
    ],
  ],
};

export const vouchPlugin: PluginLike = {
  name: "vouch-spend-guard",
  description:
    "vet402 trust check before payments: SpendGuard allow/deny as an action. " +
    "Fail-closed — no clean ALLOW verdict, no payment.",
  actions: [vouchSpendGuardAction],
};

export default vouchPlugin;

// --------------------------------------------------------------------------
// Demo: run the action handler the way the ElizaOS runtime would.
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

  // Stand-in for IAgentRuntime: settings come from process.env, exactly what
  // the real runtime does for character secrets it has no override for.
  const runtime: RuntimeLike = {
    getSetting: (key) => process.env[key] ?? null,
  };
  const message: MessageLike = {
    content: {
      text:
        process.env.DEMO_MESSAGE ??
        "Pay 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 $1 for the report",
    },
  };

  console.log(`Message: "${message.content.text}"`);
  const relevant = await vouchSpendGuardAction.validate(runtime, message);
  console.log(`validate() -> ${relevant}\n`);

  const result = await vouchSpendGuardAction.handler(
    runtime,
    message,
    undefined,
    undefined,
    (content) => console.log(`[agent says] ${content.text}`),
  );

  console.log(`\nActionResult.success = ${result.success}`);
  const decision = result.data?.decision as SpendDecision | undefined;
  if (decision) {
    console.log(
      `decision: allow=${decision.allow} reasons=[${decision.reasons.join(", ")}]`,
    );
  }
  console.log(
    dryRun
      ? "\nDone (dry-run). Set VOUCH_API_KEY for live verdicts."
      : "\nDone.",
  );
}
