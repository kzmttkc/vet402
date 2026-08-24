# Coinbase AgentKit upstream contribution draft — `vet402` action provider

Status: **DRAFT — not submitted.** Submission is an external-facing action and
requires owner approval. This document is the complete, paste-ready package:
every file of the proposed diff, the PR body, and the process checklist,
written against the real `coinbase/agentkit` structure (all facts below
verified against branch `main` on 2026-08-20 via the GitHub API).

## 1. Verified facts about the receiving repo

| Fact | Source (verified 2026-08-20) |
|---|---|
| Action providers live in `typescript/agentkit/src/action-providers/<name>/` with `<name>ActionProvider.ts`, `schemas.ts`, `index.ts`, `README.md`, `<name>ActionProvider.test.ts` | `CONTRIBUTING-TYPESCRIPT.md` "Adding an Action Provider"; erc20/x402/pyth folders |
| `Action` interface: `{ name, description, schema (zod), invoke: (args) => Promise<string> }` — **actions return a string** | `typescript/agentkit/src/action-providers/actionProvider.ts` |
| Providers extend `ActionProvider<TWalletProvider>`, implement `supportsNetwork(network: Network): boolean`; `Network = { protocolFamily, networkId?, chainId? }` | `actionProvider.ts`, `src/network/types.ts` |
| Actions are instance methods with the `@CreateAction({name, description, schema})` decorator; a method **without** a `WalletProvider` first parameter is valid (read-only providers: pyth, defillama) | `actionDecorator.ts` (`validateActionMethodArguments` detects the wallet arg), `pythActionProvider.ts` |
| Exposed action names are prefixed with the class name: `${ClassName}_${name}` | `actionDecorator.ts` (`const prefixedActionName = \`${target.constructor.name}_${params.name}\``) |
| New provider must be exported from `src/action-providers/index.ts` (`export * from "./<name>";`) | `src/action-providers/index.ts` |
| A `generate-action-provider` scaffolding script exists (`typescript/agentkit/scripts/generate-action-provider/`) | `CONTRIBUTING-TYPESCRIPT.md` |
| Tests: jest, colocated `*.test.ts`, `global.fetch = jest.fn()` mocking pattern, run with `pnpm test` from `typescript/agentkit` | `pythActionProvider.test.ts`, `package.json` (`jest ^29.7.0`) |
| Changelog: changesets (`pnpm run changeset`), past tense, `patch` for new action providers | `CONTRIBUTING-TYPESCRIPT.md` "Changelog" |
| PR template requires: Description, Tests (chatbot transcript format), checklist (README docs + changelog entry). **Commit signing is required.** | `.github/pull_request_template.md` |
| Toolchain: Node v22.x+, pnpm 10.7.x+, monorepo root `typescript/` | `CONTRIBUTING-TYPESCRIPT.md` |
| Precedent for payment-safety config: `x402ActionProvider` takes `X402Config` with `maxPaymentUsdc` (default 1.0, env `X402_MAX_PAYMENT_USDC`), service whitelisting | `x402/x402ActionProvider.ts`, `x402/README.md` |
| Precedent for third-party read-only API providers with zero new deps: pyth, defillama (built-in `fetch`) | `pyth/`, `defillama/` folders |

Design decisions taken to match upstream conventions:

- **Zero new dependencies.** The provider calls the vet402 REST API with the
  built-in `fetch` (pyth/defillama precedent), not `@vet402/sdk`.
- **Read-only provider.** No `WalletProvider` parameter anywhere: the provider
  never sees keys, never signs, never submits. It returns decisions.
- **Per-request cap, no daily-budget state.** Mirrors the x402 provider's
  `maxPaymentUsdc` shape; an in-process daily budget counter adds mutable
  state upstream reviewers would have to reason about, so it stays out of the
  first PR.
- **Fail-closed default,** consistent with vet402's product contract: no
  clean ALLOW verdict (missing key, API error, low/degraded score) ⇒ deny.

## 2. Proposed diff

Seven files: five new under
`typescript/agentkit/src/action-providers/vet402/`, one export line added to
`src/action-providers/index.ts`, one changeset.

### 2.1 NEW `typescript/agentkit/src/action-providers/vet402/schemas.ts`

```typescript
import { z } from "zod";

/**
 * Input schema for the check_payee_trust action.
 */
export const CheckPayeeTrustSchema = z
  .object({
    payeeAddress: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid EVM address (0x + 40 hex chars)")
      .describe("The EVM address of the wallet that would receive the payment"),
  })
  .strip()
  .describe("Instructions for checking a payee's vet402 trust score");

/**
 * Input schema for the evaluate_spend action.
 */
export const EvaluateSpendSchema = z
  .object({
    payeeAddress: z
      .string()
      .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid EVM address (0x + 40 hex chars)")
      .describe("The EVM address of the wallet that would receive the payment"),
    amountUsd: z
      .number()
      .positive()
      .describe("The payment amount in USD"),
  })
  .strip()
  .describe("Instructions for evaluating a payment against the vet402 spend policy");

/**
 * Configuration options for the Vet402ActionProvider.
 */
export interface Vet402Config {
  /**
   * vet402 API key. Falls back to the VET402_API_KEY environment variable.
   * Without a key, evaluate_spend denies fail-closed and check_payee_trust
   * reports the credential error explicitly.
   */
  apiKey?: string;

  /**
   * Base URL of the vet402 API. Falls back to the VET402_API_URL environment
   * variable, then to the hosted API.
   */
  apiUrl?: string;

  /**
   * Maximum payment per evaluate_spend request in USD. Falls back to the
   * VET402_MAX_PAYMENT_USD environment variable. Default: 1.0.
   */
  maxPaymentUsd?: number;

  /**
   * Minimum payee trust score (0-100) required to allow a payment. Falls
   * back to the VET402_MIN_PAYEE_SCORE environment variable. Default: 40.
   */
  minPayeeScore?: number;
}
```

### 2.2 NEW `typescript/agentkit/src/action-providers/vet402/constants.ts`

```typescript
/**
 * Default base URL of the vet402 Payee Trust API.
 */
export const DEFAULT_API_URL = "https://vet402.com/api/v1";

/**
 * Default maximum payment per evaluate_spend request, in USD.
 */
export const DEFAULT_MAX_PAYMENT_USD = 1.0;

/**
 * Default minimum payee trust score (0-100) required to allow a payment.
 */
export const DEFAULT_MIN_PAYEE_SCORE = 40;
```

### 2.3 NEW `typescript/agentkit/src/action-providers/vet402/vet402ActionProvider.ts`

```typescript
import { z } from "zod";
import { ActionProvider } from "../actionProvider";
import { Network } from "../../network";
import { CreateAction } from "../actionDecorator";
import { CheckPayeeTrustSchema, EvaluateSpendSchema, Vet402Config } from "./schemas";
import {
  DEFAULT_API_URL,
  DEFAULT_MAX_PAYMENT_USD,
  DEFAULT_MIN_PAYEE_SCORE,
} from "./constants";

/** Shape of GET /payees/{address}/score (the fields this provider reads). */
interface PayeeScoreResponse {
  payee: string;
  score: number;
  recommendation: "ALLOW" | "WARN" | "BLOCK";
  dataDepth: "thin" | "moderate" | "rich";
  degraded: boolean;
  signalsUnavailable: string[];
}

/** Internal config with all fields resolved. */
interface ResolvedVet402Config {
  apiKey: string | undefined;
  apiUrl: string;
  maxPaymentUsd: number;
  minPayeeScore: number;
}

/**
 * Vet402ActionProvider provides read-only payee trust checks for agent
 * payments, backed by the vet402 Payee Trust API (https://vet402.com).
 *
 * The provider is strictly non-custodial: it never accesses a wallet
 * provider, never signs, and never submits transactions. It returns
 * allow/deny decisions with machine-readable reasons; executing or skipping
 * the payment remains the job of the agent's wallet/payment actions.
 *
 * Decisions are fail-closed: a missing API key, an unreachable API, or a
 * degraded score reads as "deny", never as a silent pass-through.
 */
export class Vet402ActionProvider extends ActionProvider {
  private readonly config: ResolvedVet402Config;

  /**
   * Creates a new instance of Vet402ActionProvider.
   *
   * @param config - Optional configuration for API access and spend policy
   */
  constructor(config: Vet402Config = {}) {
    super("vet402", []);
    this.config = {
      apiKey: config.apiKey ?? process.env.VET402_API_KEY,
      apiUrl: config.apiUrl ?? process.env.VET402_API_URL ?? DEFAULT_API_URL,
      maxPaymentUsd:
        config.maxPaymentUsd ??
        parseFloat(process.env.VET402_MAX_PAYMENT_USD ?? String(DEFAULT_MAX_PAYMENT_USD)),
      minPayeeScore:
        config.minPayeeScore ??
        parseFloat(process.env.VET402_MIN_PAYEE_SCORE ?? String(DEFAULT_MIN_PAYEE_SCORE)),
    };
  }

  /**
   * Fetches the vet402 trust score for a payee address.
   *
   * @param args - The input arguments for the action.
   * @returns A JSON string with the payee's score, recommendation, and data depth, or an error description.
   */
  @CreateAction({
    name: "check_payee_trust",
    description: `
This tool checks the trust score of a wallet address that is about to RECEIVE a payment (the payee), using the vet402 Payee Trust API.
It takes the following input:
- payeeAddress: The EVM address (0x...) of the wallet that would receive the payment

The result contains a score (0-100), a recommendation (ALLOW / WARN / BLOCK), and how much data backs the score (thin / moderate / rich).
Important notes:
- This is a read-only check. It does not move funds and does not need a wallet.
- Use this before paying an address you have not paid before. If the recommendation is BLOCK, do not pay.
- Only EVM addresses can be scored. Never assume an address; it must be provided as input.
`,
    schema: CheckPayeeTrustSchema,
  })
  async checkPayeeTrust(args: z.infer<typeof CheckPayeeTrustSchema>): Promise<string> {
    const result = await this.fetchPayeeScore(args.payeeAddress);
    if ("error" in result) {
      return JSON.stringify({ success: false, error: result.error });
    }
    return JSON.stringify({
      success: true,
      payee: result.payee,
      score: result.score,
      recommendation: result.recommendation,
      dataDepth: result.dataDepth,
      degraded: result.degraded,
      signalsUnavailable: result.signalsUnavailable,
    });
  }

  /**
   * Evaluates a proposed payment against the spend policy: per-request USD
   * cap plus the payee's vet402 trust verdict. Fail-closed.
   *
   * @param args - The input arguments for the action.
   * @returns A JSON string with allow (boolean) and machine-readable reasons.
   */
  @CreateAction({
    name: "evaluate_spend",
    description: `
This tool decides whether the agent should proceed with a payment, and MUST be called before any payment to an address that has not been evaluated in this conversation. If the result contains "allow": false, do NOT pay.
It takes the following inputs:
- payeeAddress: The EVM address (0x...) of the wallet that would receive the payment
- amountUsd: The payment amount in USD

The decision combines a per-request USD cap with the payee's vet402 trust score, and is fail-closed: when the trust score cannot be obtained (missing API key, API unavailable, degraded data), the result is a deny with the reason spelled out.
Important notes:
- This is a decision only. It does not move funds and does not need a wallet.
- A deny is not an error: report the reasons to the user instead of retrying.
`,
    schema: EvaluateSpendSchema,
  })
  async evaluateSpend(args: z.infer<typeof EvaluateSpendSchema>): Promise<string> {
    const reasons: string[] = [];

    if (args.amountUsd > this.config.maxPaymentUsd) {
      reasons.push(
        `max_payment_exceeded: $${args.amountUsd} is above the configured cap of $${this.config.maxPaymentUsd}`,
      );
    }

    const result = await this.fetchPayeeScore(args.payeeAddress);
    if ("error" in result) {
      reasons.push(`payee_trust_unavailable: ${result.error}`);
    } else {
      if (result.degraded) {
        reasons.push("payee_score_degraded: one or more trust inputs could not be read");
      }
      if (result.recommendation === "BLOCK") {
        reasons.push("payee_recommendation_block");
      }
      if (result.score < this.config.minPayeeScore) {
        reasons.push(
          `payee_score_below_min: score ${result.score} is below the required ${this.config.minPayeeScore}`,
        );
      }
    }

    const allow = reasons.length === 0;
    return JSON.stringify({
      success: true,
      allow,
      payee: args.payeeAddress,
      amountUsd: args.amountUsd,
      reasons,
      ...("error" in result
        ? {}
        : { payeeScore: result.score, recommendation: result.recommendation }),
      guidance: allow
        ? "Allowed. You may proceed with the payment using your wallet actions."
        : "Denied (fail-closed). Do not pay this address. Report the reasons to the user.",
    });
  }

  /**
   * Fetches the payee score from the vet402 API, normalizing every failure
   * mode into an { error } object so callers can fail closed uniformly.
   *
   * @param payeeAddress - The EVM address to score.
   * @returns The parsed score response, or an object with an error description.
   */
  private async fetchPayeeScore(
    payeeAddress: string,
  ): Promise<PayeeScoreResponse | { error: string }> {
    if (!this.config.apiKey) {
      return {
        error:
          "missing_api_key: set VET402_API_KEY (get a key at https://vet402.com/dashboard/keys)",
      };
    }
    try {
      const response = await fetch(
        `${this.config.apiUrl}/payees/${payeeAddress}/score`,
        {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            Accept: "application/json",
          },
        },
      );
      if (!response.ok) {
        return { error: `api_error: HTTP ${response.status}` };
      }
      return (await response.json()) as PayeeScoreResponse;
    } catch (error) {
      return { error: `network_error: ${error}` };
    }
  }

  /**
   * Checks if the action provider supports the given network. Payee scoring
   * covers EVM settlement addresses.
   *
   * @param network - The network to check.
   * @returns True for EVM networks.
   */
  supportsNetwork = (network: Network) => network.protocolFamily === "evm";
}

export const vet402ActionProvider = (config: Vet402Config = {}) =>
  new Vet402ActionProvider(config);
```

### 2.4 NEW `typescript/agentkit/src/action-providers/vet402/index.ts`

```typescript
export * from "./vet402ActionProvider";
export * from "./schemas";
```

### 2.5 NEW `typescript/agentkit/src/action-providers/vet402/README.md`

````markdown
# Vet402 Action Provider

This directory contains the **Vet402ActionProvider** implementation, which
provides read-only payee trust checks for agent payments, backed by the
[vet402](https://vet402.com) Payee Trust API.

## Directory Structure

```
vet402/
├── vet402ActionProvider.ts       # Main provider with trust check actions
├── schemas.ts                    # Action schemas and configuration types
├── constants.ts                  # Defaults (API URL, caps)
├── index.ts                      # Main exports
├── vet402ActionProvider.test.ts  # Tests
└── README.md                     # This file
```

## What it does

Autonomous payments have an asymmetry: wallets and payment rails verify that
the payer CAN pay, but nothing verifies that the payee SHOULD be paid. This
provider closes that gap with two decision-only actions:

1. `check_payee_trust` — fetch the vet402 trust score of a receiving
   address (0-100, ALLOW / WARN / BLOCK, backed-by-data depth).
2. `evaluate_spend` — combine a per-request USD cap with the payee's trust
   verdict into a single fail-closed allow/deny with machine-readable
   reasons.

The provider is strictly non-custodial: no wallet access, no signing, no
transaction submission. Execution stays with the agent's wallet actions —
this provider only tells the agent when NOT to use them.

## Configuration

```typescript
import { vet402ActionProvider } from "@coinbase/agentkit";

const provider = vet402ActionProvider({
  apiKey: process.env.VET402_API_KEY,  // default: VET402_API_KEY env var
  maxPaymentUsd: 1.0,                  // default: 1.0 (VET402_MAX_PAYMENT_USD)
  minPayeeScore: 40,                   // default: 40 (VET402_MIN_PAYEE_SCORE)
});
```

Fail-closed contract: a missing API key, an unreachable API, or a degraded
score all produce `allow: false` with the reason spelled out — never a
silent pass-through.

## Network Support

EVM networks (`protocolFamily === "evm"`). Scoring covers EVM settlement
addresses.
````

### 2.6 NEW `typescript/agentkit/src/action-providers/vet402/vet402ActionProvider.test.ts`

```typescript
import { vet402ActionProvider } from "./vet402ActionProvider";

const PAYEE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const scoreResponse = {
  payee: PAYEE,
  score: 82,
  recommendation: "ALLOW",
  dataDepth: "rich",
  degraded: false,
  signalsUnavailable: [],
};

describe("Vet402ActionProvider", () => {
  const fetchMock = jest.fn();
  global.fetch = fetchMock;

  beforeEach(() => {
    jest.resetAllMocks().restoreAllMocks();
  });

  describe("checkPayeeTrust", () => {
    it("should return the payee score", async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => scoreResponse });
      const provider = vet402ActionProvider({ apiKey: "test-key" });

      const result = JSON.parse(await provider.checkPayeeTrust({ payeeAddress: PAYEE }));
      expect(result.success).toBe(true);
      expect(result.score).toBe(82);
      expect(result.recommendation).toBe("ALLOW");
    });

    it("should report a missing API key without calling the network", async () => {
      const provider = vet402ActionProvider({ apiKey: undefined });

      const result = JSON.parse(await provider.checkPayeeTrust({ payeeAddress: PAYEE }));
      expect(result.success).toBe(false);
      expect(result.error).toContain("missing_api_key");
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("evaluateSpend", () => {
    it("should allow a payment within policy for a trusted payee", async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => scoreResponse });
      const provider = vet402ActionProvider({ apiKey: "test-key", maxPaymentUsd: 5 });

      const result = JSON.parse(
        await provider.evaluateSpend({ payeeAddress: PAYEE, amountUsd: 1 }),
      );
      expect(result.allow).toBe(true);
      expect(result.reasons).toEqual([]);
    });

    it("should deny when the amount exceeds the cap", async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => scoreResponse });
      const provider = vet402ActionProvider({ apiKey: "test-key", maxPaymentUsd: 5 });

      const result = JSON.parse(
        await provider.evaluateSpend({ payeeAddress: PAYEE, amountUsd: 50 }),
      );
      expect(result.allow).toBe(false);
      expect(result.reasons.join()).toContain("max_payment_exceeded");
    });

    it("should deny fail-closed when the API key is missing", async () => {
      const provider = vet402ActionProvider({ apiKey: undefined });

      const result = JSON.parse(
        await provider.evaluateSpend({ payeeAddress: PAYEE, amountUsd: 1 }),
      );
      expect(result.allow).toBe(false);
      expect(result.reasons.join()).toContain("payee_trust_unavailable");
    });

    it("should deny fail-closed when the API errors", async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
      const provider = vet402ActionProvider({ apiKey: "test-key" });

      const result = JSON.parse(
        await provider.evaluateSpend({ payeeAddress: PAYEE, amountUsd: 1 }),
      );
      expect(result.allow).toBe(false);
      expect(result.reasons.join()).toContain("payee_trust_unavailable");
    });

    it("should deny when the recommendation is BLOCK", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...scoreResponse, score: 12, recommendation: "BLOCK" }),
      });
      const provider = vet402ActionProvider({ apiKey: "test-key" });

      const result = JSON.parse(
        await provider.evaluateSpend({ payeeAddress: PAYEE, amountUsd: 0.5 }),
      );
      expect(result.allow).toBe(false);
      expect(result.reasons).toEqual(
        expect.arrayContaining(["payee_recommendation_block"]),
      );
    });

    it("should deny when the score is degraded", async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ...scoreResponse, degraded: true }),
      });
      const provider = vet402ActionProvider({ apiKey: "test-key" });

      const result = JSON.parse(
        await provider.evaluateSpend({ payeeAddress: PAYEE, amountUsd: 0.5 }),
      );
      expect(result.allow).toBe(false);
      expect(result.reasons.join()).toContain("payee_score_degraded");
    });
  });

  describe("supportsNetwork", () => {
    it("should support EVM networks only", () => {
      const provider = vet402ActionProvider();
      expect(provider.supportsNetwork({ protocolFamily: "evm" })).toBe(true);
      expect(provider.supportsNetwork({ protocolFamily: "svm" })).toBe(false);
    });
  });
});
```

### 2.7 MODIFY `typescript/agentkit/src/action-providers/index.ts`

Add one line, keeping the file's ordering (after `truemarkets`, before
`twitter` alphabetically — note the existing file is only loosely
alphabetical; match whatever ordering review prefers):

```diff
 export * from "./truemarkets";
 export * from "./twitter";
+export * from "./vet402";
 export * from "./wallet";
```

### 2.8 NEW `.changeset/<generated-name>.md`

Generated via `pnpm run changeset` (select `@coinbase/agentkit`, `patch`):

```markdown
---
"@coinbase/agentkit": patch
---

Added a new action provider for vet402 payee trust checks (check_payee_trust, evaluate_spend)
```

## 3. PR body draft (paste into the PR description)

> Title: `feat: add vet402 payee trust action provider`

````markdown
## Description

This PR adds a new read-only action provider, `Vet402ActionProvider`, that
lets an agent check the trustworthiness of a payment recipient (the payee)
before executing a payment.

Motivation: AgentKit's payment paths verify that the payer can pay (wallet
actions, x402's payment caps and service whitelisting), but nothing scores
the receiving address itself. For autonomous payments this leaves a gap:
an agent that discovers a new x402 service or is asked to pay an unknown
address has no signal about whether that address is safe to pay. The
vet402 Payee Trust API (https://vet402.com) scores EVM receiving addresses
from on-chain settlement history, wallet health, and drain-pattern
detection, and this provider exposes that as two decision-only actions:

- `check_payee_trust(payeeAddress)` — trust score (0-100), recommendation
  (ALLOW/WARN/BLOCK), and data depth for a payee address.
- `evaluate_spend(payeeAddress, amountUsd)` — a single fail-closed
  allow/deny combining a configurable per-request USD cap (default $1,
  same shape as the x402 provider's `maxPaymentUsdc`) with the payee's
  trust verdict, returning machine-readable deny reasons.

Design notes for review:

- **Read-only / non-custodial.** No action takes a `WalletProvider`; the
  provider never sees keys, never signs, never submits. It composes with —
  and does not modify — the existing wallet and x402 actions.
- **Zero new dependencies.** The vet402 API is called with the built-in
  `fetch` (same approach as the pyth and defillama providers).
- **Fail-closed.** A missing `VET402_API_KEY`, an unreachable API, or a
  degraded score produce `allow: false` with the reason spelled out, never
  a silent pass-through, and never a thrown error into the agent loop.
- **External API disclosure.** Actions call `https://vet402.com/api/v1`
  (configurable via `VET402_API_URL`). The only data sent is the payee
  address being scored; an API key is required (free tier available). No
  telemetry beyond the scored request itself.
- **EVM scope.** `supportsNetwork` returns true for
  `protocolFamily === "evm"`; scoring covers EVM settlement addresses.

## Tests

Unit tests (`vet402ActionProvider.test.ts`, jest with mocked `fetch`) cover:
score fetch happy path, missing-key short-circuit (no network call),
per-request cap deny, API-error fail-closed deny, BLOCK-recommendation
deny, degraded-score deny, and network support.

```
cd typescript/agentkit
pnpm test -- vet402
```

Manual end-to-end (transcript to be filled in from a run of
typescript/examples/langchain-cdp-smart-wallet-chatbot before submission):

```
Chatbot: typescript/examples/langchain-cdp-smart-wallet-chatbot/chatbot.ts
Network: Base Sepolia
Setup: VET402_API_KEY set

Prompt: Before paying 0x..., check whether it is safe to pay $0.50 there.

<agent output showing Vet402ActionProvider_evaluate_spend verdict>
```

## Checklist

- [x] Added documentation to all relevant README.md files
      (new `action-providers/vet402/README.md`)
- [x] Added a changelog entry (changeset, patch)
````

## 4. Pre-submission checklist (our side)

1. Fork `coinbase/agentkit`, branch from `main`.
2. `cd typescript && pnpm i` (Node v22+, pnpm 10.7+).
3. Optionally scaffold with
   `typescript/agentkit/scripts/generate-action-provider` and transplant the
   code from section 2 into the generated skeleton (keeps us aligned with any
   scaffold conventions the script adds).
4. Apply the diff (section 2), run `pnpm run format && pnpm run lint` and
   `pnpm test` from `typescript/agentkit`.
5. Run the manual chatbot test and paste the real transcript into the PR
   body's Tests section (the template asks for actual prompts and outputs —
   do not submit with the placeholder).
6. `pnpm run changeset` (patch, `@coinbase/agentkit`).
7. **Sign commits** (repo requires commit signing).
8. Open the PR with the body from section 3. Do not submit before owner
   approval of this draft.

## 5. Known uncertainties (honest list)

- **Hosted API URL**: the draft uses `https://vet402.com/api/v1` as the
  default. Our SDK's current default (`packages/sdk`) points at the current
  deployment URL; before submission, confirm the stable public API base URL
  and rate limits we are prepared to honor for upstream users.
- **Recommendation enum**: the draft types recommendation as
  `ALLOW | WARN | BLOCK`, matching the SDK's `Recommendation` usage in our
  examples. Re-verify against the OpenAPI spec at submission time.
- **`generate-action-provider` scaffold output**: the CONTRIBUTING guide
  references it, but the scaffold's exact output was not fetched; step 3 of
  the checklist exists precisely to absorb any differences.
- **Acceptance risk**: AgentKit has accepted third-party read-only API
  providers (pyth, defillama, messari, zerion), so there is precedent, but a
  provider that requires a third-party API key for a paid-tier service may
  draw "why upstream rather than a community provider" review. Mitigation in
  the PR body: zero deps, read-only, fail-closed, free tier. If rejected,
  the identical code ships as a standalone npm package
  (`@vet402/agentkit-provider`) usable via `customActionProvider` or
  direct import — no wasted work.
- **Exposed action names** are `Vet402ActionProvider_check_payee_trust` /
  `Vet402ActionProvider_evaluate_spend` (class-name prefix is added by
  `actionDecorator.ts`). The description text, not the name, is what steers
  the LLM; the drafted descriptions instruct the model to call
  evaluate_spend before paying and to stop on `allow: false`.
