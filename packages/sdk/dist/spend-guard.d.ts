import type { PayeeScoreResult } from "./index.js";
/**
 * Trust posture toward the payee score. BREAKING (0.2.0): the default is
 * "allow-only" — money moves only on a clean ALLOW unless you explicitly
 * opt out.
 *
 *  - "allow-only" (default, fail-closed): every evaluate() performs the payee
 *    trust lookup and denies unless the verdict is a clean ALLOW — a WARN or
 *    BLOCK recommendation, a degraded read, a partial measurement
 *    (signalsUnavailable non-empty), or a failed lookup all deny.
 *  - "block-only": the lookup still always runs and a failed or degraded read
 *    still denies, but a WARN (or partially measured) verdict passes. Deny
 *    only on BLOCK.
 *  - "evidence" (0.5.0): the safe middle. Behaves exactly like "allow-only"
 *    on every data-quality question — a degraded read, a stale score, a
 *    partial measurement or a failed lookup all deny, and BLOCK always
 *    denies — but a WARN passes when the payee's own measured receiving
 *    record clears the floors you name in `requireEvidence`. Requires
 *    `requireEvidence`; see it for why this is not just "block-only".
 *  - "custom": pre-0.2.0 behaviour — only the rules you set below apply, and
 *    the lookup runs only when `minPayeeScore` or `blockOnRecommendation`
 *    is set. NOTE: this also switches OFF the staleness (H-2), degraded and
 *    partial-measurement gates. Prefer "evidence" when what you actually
 *    wanted was "accept a WARN I can justify".
 */
export type SpendGuardTrustPolicy = "allow-only" | "block-only" | "evidence" | "custom";
/**
 * Minimum measured economic evidence a WARN payee must carry before
 * `trustPolicy: "evidence"` will let a payment through. Every floor is read
 * from the payee score's own `signals.receiving` — never from anything the
 * payee asserts about itself.
 *
 * WHY THIS EXISTS (2026-08-25). Both engines cap an un-evidenced counterparty
 * BELOW the ALLOW line by design: an unregistered bare wallet tops out at 62
 * in the wallet engine, and a payee with no independent receiving record is
 * held at PAYEE_THIN_SCORE_CEILING = 69 by the 2026-08-13 score-manipulation
 * ruling. The ALLOW line is 70. Measured against production the same day,
 * that means NOTHING clears ALLOW: /accuracy's known-good benchmark returned
 * 0 of 17 allowed / 17 warned, and 0x36038e1d… — 48 delivery-verified L1
 * receipts, 0 failures — still scores WARN. Under the shipped default the
 * guard therefore denies every counterparty that exists.
 *
 * The default is deliberate and does not change: "we could not verify this"
 * must keep meaning "do not pay". What was missing is a way to say "accept a
 * WARN, but only one with real delivery behind it" WITHOUT falling back to
 * "custom", which quietly disables the freshness and degraded gates too.
 *
 * At least one floor must be >= 1. A `requireEvidence` whose floors are all
 * zero would accept every WARN — that is "block-only", and it should be
 * spelled that way rather than hidden behind a safer-sounding name.
 */
export type SpendGuardEvidenceFloors = {
    /** Delivery-verified L1 receipts (the observatory paid and checked delivery). */
    minL1Deliveries?: number;
    /** Distinct buyers behind those L1 receipts. */
    minL1DistinctBuyers?: number;
    /** Score-eligible x402 settlements received. */
    minX402Payments?: number;
    /** Distinct payers behind those settlements (post funder-folding). */
    minDistinctPayers?: number;
};
export type SpendGuardPolicy = {
    /** Deny any single payment above this USD amount. */
    maxPerTxUsd?: number;
    /**
     * Deny once cumulative allowed payments in the current UTC day would
     * exceed this USD amount. The counter lives in this process's memory and
     * resets on process restart — see README for the operational implications.
     */
    dailyBudgetUsd?: number;
    /**
     * How the Vouch payee verdict gates the payment. Default "allow-only"
     * (fail-closed): deny everything that is not a clean ALLOW. See
     * SpendGuardTrustPolicy for the explicit opt-outs.
     */
    trustPolicy?: SpendGuardTrustPolicy;
    /**
     * Evidence floors a WARN must clear under `trustPolicy: "evidence"`.
     * Required by that policy, and rejected under every other one (so the
     * opt-out is always visible at the call site). See
     * {@link SpendGuardEvidenceFloors}.
     */
    requireEvidence?: SpendGuardEvidenceFloors;
    /** Deny when the Vouch payee score is below this value (0-100). */
    minPayeeScore?: number;
    /**
     * Maximum age of the payee score, in milliseconds, before it is treated as
     * stale and denied fail-closed (`payee_score_stale`). Measured from the
     * score's own `scoredAt`. Defaults to {@link DEFAULT_MAX_SCORE_AGE_MS}
     * (5 min), matching the API's own cache TTL. The score's `cacheExpiresAt`
     * is ALSO honoured as a hard ceiling: a score past its declared expiry is
     * stale no matter how lax this value is — so this can only make the guard
     * STRICTER than the score's self-declared freshness window, never laxer.
     *
     * H-2 (2026-08-13): without this, an integrator whose fetcher returned a
     * cached score could keep clearing large payments against a verdict the
     * world had already moved past. Enforced under "allow-only"/"block-only";
     * "custom" keeps pre-0.2.0 behaviour and does not enforce it.
     */
    maxScoreAgeMs?: number;
    /**
     * Deny when the Vouch payee recommendation is BLOCK. Kept for backward
     * compatibility: under the default "allow-only" policy this is already
     * implied (anything that is not ALLOW denies). It remains meaningful with
     * `trustPolicy: "custom"`.
     */
    blockOnRecommendation?: boolean;
};
export type SpendEvaluateInput = {
    /** Payee wallet address (0x...) the agent is about to pay. */
    payee: string;
    /** Payment amount in USD. */
    amountUsd: number;
};
export type SpendDenyReason = "max_per_tx_exceeded" | "daily_budget_exceeded" | "payee_score_below_min"
/** Recommendation was WARN or BLOCK under the default "allow-only" policy. */
 | "payee_recommendation_not_allow" | "payee_recommendation_block"
/**
 * `trustPolicy: "evidence"` — the verdict was a WARN and the payee's
 * measured receiving record did not clear the floors in `requireEvidence`.
 * A missing evidence field counts as zero: absence is not a pass.
 */
 | "payee_insufficient_evidence"
/** The score itself came from a degraded read (inputs missing entirely). */
 | "payee_score_degraded"
/** Some inputs could not be measured (signalsUnavailable non-empty). */
 | "payee_partial_measurement"
/**
 * The score was too old to trust: its `scoredAt` is older than
 * `maxScoreAgeMs`, or it is past its own `cacheExpiresAt`, or its timestamps
 * could not be parsed. A stale score is not a current measurement.
 */
 | "payee_score_stale"
/**
 * The lookup was refused for a credential reason the CALLER owns: the API
 * key is missing, invalid, or not entitled to this endpoint (401/403).
 * Retrying will not help — fix the key.
 */
 | "payee_trust_unauthenticated"
/**
 * The score lookup itself failed for a reason on OUR side or in between:
 * network error, timeout, 5xx, rate limit. Retrying may help.
 */
 | "payee_trust_unavailable";
export type SpendDecision = {
    allow: boolean;
    /** Empty when allowed; one or more machine-readable codes when denied. */
    reasons: SpendDenyReason[];
    payee: string;
    amountUsd: number;
    /**
     * Cumulative USD counted against today's budget after this decision
     * (includes this payment when allowed).
     */
    spentTodayUsd: number;
    /** null when the policy has no dailyBudgetUsd. */
    remainingDailyBudgetUsd: number | null;
    /**
     * Full payee trust result when the Vouch lookup ran and succeeded; null
     * when the lookup was skipped (a cheaper local rule already denied, or
     * `trustPolicy: "custom"` with no trust rule set) or failed.
     */
    payeeScore: PayeeScoreResult | null;
};
/**
 * Default staleness bound (5 min), matching the score API's own cache TTL: a
 * score is trusted for exactly as long as the server itself would have served
 * it from cache. See SpendGuardPolicy.maxScoreAgeMs.
 */
export declare const DEFAULT_MAX_SCORE_AGE_MS: number;
/**
 * Non-custodial spend-policy layer: answers "may my agent send this payment?"
 * and nothing else. It never touches keys, funds, signing, or transaction
 * submission — execution stays with the agent's own wallet stack (Coinbase
 * AgentKit, Privy, ...). The guard composes:
 *
 * 1. Local policy — per-transaction cap and an in-memory daily budget
 *    counter (UTC day, resets on process restart).
 * 2. Vouch's Payee Trust API (`GET /v1/payees/{address}/score`) — consulted
 *    on every evaluate under the default fail-closed policy (skipped when a
 *    local rule already denied, so no quota is burned on a payment that's
 *    dead anyway). Only `trustPolicy: "custom"` makes the lookup conditional
 *    on `minPayeeScore` / `blockOnRecommendation` being set.
 *
 * BREAKING (0.2.0) — fail-closed by default (`trustPolicy: "allow-only"`):
 * a WARN or BLOCK recommendation, a degraded read, a partial measurement,
 * or a failed lookup all deny. Money moves only on a clean ALLOW unless the
 * integrator explicitly opts out via `trustPolicy`.
 *
 * Budget reservation is optimistic: once the local rules pass, the amount is
 * reserved against the daily budget BEFORE the trust lookup yields to the
 * event loop, and returned automatically if the trust rules then deny. This
 * keeps concurrent in-process `evaluate` calls honest — two payments racing
 * through the same guard cannot both read the pre-reservation counter and
 * slip past the budget together. If the agent ultimately does NOT execute an
 * allowed payment, call `release(amountUsd)` to return the reservation.
 */
export declare class SpendGuard {
    private readonly policy;
    private readonly fetchPayeeScore;
    private readonly now;
    private spentTodayUsd;
    private currentDay;
    constructor(policy: SpendGuardPolicy, fetchPayeeScore: (payee: string) => Promise<PayeeScoreResult>, now?: () => Date);
    evaluate(input: SpendEvaluateInput): Promise<SpendDecision>;
    /**
     * Returns a previously reserved amount to today's budget. Call when an
     * allowed payment ultimately did not execute.
     */
    release(amountUsd: number): void;
    /** Current in-memory budget state (UTC day + reserved USD). */
    state(): {
        day: string;
        spentTodayUsd: number;
    };
    private rollDayIfNeeded;
    private utcDay;
}
