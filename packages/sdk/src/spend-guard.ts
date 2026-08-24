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

export type SpendDenyReason =
  | "max_per_tx_exceeded"
  | "daily_budget_exceeded"
  | "payee_score_below_min"
  /** Recommendation was WARN or BLOCK under the default "allow-only" policy. */
  | "payee_recommendation_not_allow"
  | "payee_recommendation_block"
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

const WALLET_RE = /^0x[a-fA-F0-9]{40}$/;

/**
 * Default staleness bound (5 min), matching the score API's own cache TTL: a
 * score is trusted for exactly as long as the server itself would have served
 * it from cache. See SpendGuardPolicy.maxScoreAgeMs.
 */
export const DEFAULT_MAX_SCORE_AGE_MS = 5 * 60 * 1000;

/**
 * Is this score too old to act on? Fail-closed: an unparseable `scoredAt`
 * counts as stale (we cannot prove freshness), and the score's own
 * `cacheExpiresAt` is honoured as a hard ceiling in addition to `maxScoreAgeMs`
 * so a lax bound can never resurrect a score past its declared expiry.
 *
 * DELIBERATELY NOT THE SAME FUNCTION as `isScoreStale` in
 * `@vet402/middleware` (packages/middleware/src/core.ts), which answers
 * differently for a body carrying NEITHER timestamp: it returns FRESH, this
 * one returns STALE. Both are right for their input, and the divergence is
 * kept on purpose (2026-08-22 audit — the two were flagged as "one name, two
 * answers", and unifying them would break whichever side lost):
 *
 *   - here the input is a `PayeeScoreResult`, whose `scoredAt` and
 *     `cacheExpiresAt` are BOTH always present (docs/openapi.yaml lists them
 *     in `required`; src/lib/scoring/payee-engine.ts builds them
 *     unconditionally). A body reaching this function without them is a
 *     malformed or tampered payload, not a legitimate shape — so "cannot
 *     prove freshness" is the honest answer and it fails closed;
 *   - the middleware gates TWO endpoints and types its input as a partial
 *     `ScoreResponse`. For it, missing timestamps are a legitimate body
 *     shape, and "absence is not expiry" is the honest answer there.
 *
 * The rule of thumb the two share: never let an unreadable timestamp pass as
 * a fresh one. They differ only on whether ABSENCE is unreadable, and that
 * depends on whether absence was ever legal — which is a property of the
 * input, not of the rule.
 */
function isScoreStale(
  score: PayeeScoreResult,
  nowMs: number,
  maxScoreAgeMs: number,
): boolean {
  const scoredAtMs = Date.parse(score.scoredAt);
  if (Number.isNaN(scoredAtMs)) return true;
  if (nowMs - scoredAtMs > maxScoreAgeMs) return true;
  const expiresMs = Date.parse(score.cacheExpiresAt);
  if (!Number.isNaN(expiresMs) && nowMs >= expiresMs) return true;
  return false;
}

/**
 * API error codes that mean "the caller's credentials are the problem".
 * The REST API returns these with a 401 (src/lib/api/auth.ts).
 */
const AUTH_ERROR_CODES = new Set([
  "missing_api_key",
  "invalid_api_key",
  "forbidden",
  "unauthorized",
]);

/**
 * Why did the payee lookup fail — the caller's key, or the upstream?
 *
 * 2026-08-13 (hackathon persona R2): both collapsed into
 * `payee_trust_unavailable`, so an integrator who had simply not set
 * VOUCH_API_KEY saw the same code as a real Vouch outage and went looking for
 * our downtime. The raw API was already saying `missing_api_key`; the guard
 * was swallowing it. Distinguished by status code first (structured, from
 * VouchApiError) and by message only as a fallback, so an injected fetcher in
 * a host app still classifies sensibly.
 */
function classifyLookupFailure(error: unknown): SpendDenyReason {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") {
    return status === 401 || status === 403
      ? "payee_trust_unauthenticated"
      : "payee_trust_unavailable";
  }
  // A timed-out or aborted lookup, stated rather than inferred (2026-08-22,
  // when the SDK's fetch gained AbortSignal.timeout). `AbortSignal.timeout`
  // rejects with a DOMException named "TimeoutError" and an explicit abort
  // with "AbortError"; neither carries a `status`, and a DOMException's legacy
  // `code` is a NUMBER, so both would fall through to the message check below
  // and land on `payee_trust_unavailable` by accident. That is the right
  // answer — a lookup that never came back is an upstream problem, not a
  // credential one, and retrying may help — so it is written down instead of
  // being left to depend on the shape of a DOMException.
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return "payee_trust_unavailable";
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : "";
  const token = typeof code === "string" ? code : message;
  return AUTH_ERROR_CODES.has(token)
    ? "payee_trust_unauthenticated"
    : "payee_trust_unavailable";
}

function assertPolicy(policy: SpendGuardPolicy): void {
  for (const key of ["maxPerTxUsd", "dailyBudgetUsd", "minPayeeScore"] as const) {
    const value = policy[key];
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`invalid_policy_${key}`);
    }
  }
  if (policy.minPayeeScore !== undefined && policy.minPayeeScore > 100) {
    throw new Error("invalid_policy_minPayeeScore");
  }
  if (
    policy.maxScoreAgeMs !== undefined &&
    (Number.isNaN(policy.maxScoreAgeMs) || policy.maxScoreAgeMs <= 0)
  ) {
    // Allows +Infinity (disable the age bound; cacheExpiresAt still caps).
    throw new Error("invalid_policy_maxScoreAgeMs");
  }
  if (
    policy.trustPolicy !== undefined &&
    !["allow-only", "block-only", "evidence", "custom"].includes(policy.trustPolicy)
  ) {
    throw new Error("invalid_policy_trustPolicy");
  }
  assertEvidenceFloors(policy);
}

const EVIDENCE_FLOOR_KEYS = [
  "minL1Deliveries",
  "minL1DistinctBuyers",
  "minX402Payments",
  "minDistinctPayers",
] as const;

/**
 * `requireEvidence` is meaningful under exactly one policy, and only when it
 * actually demands something. Both halves are enforced here rather than
 * silently ignored: a floor set on the wrong policy, or a floor set to zero,
 * reads at the call site as "I gated this" while gating nothing.
 */
function assertEvidenceFloors(policy: SpendGuardPolicy): void {
  const isEvidencePolicy = policy.trustPolicy === "evidence";

  if (!isEvidencePolicy) {
    if (policy.requireEvidence !== undefined) {
      // Fail loudly rather than accept a floor we will never read.
      throw new Error("invalid_policy_requireEvidence");
    }
    return;
  }

  const floors = policy.requireEvidence;
  if (floors === null || typeof floors !== "object") {
    throw new Error("invalid_policy_requireEvidence");
  }

  let demandsSomething = false;
  for (const key of EVIDENCE_FLOOR_KEYS) {
    const value = floors[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
      throw new Error("invalid_policy_requireEvidence");
    }
    if (value > 0) demandsSomething = true;
  }
  // All-zero (or empty) floors would accept every WARN — that is "block-only",
  // and it has to be spelled that way.
  if (!demandsSomething) throw new Error("invalid_policy_requireEvidence");
}

/**
 * Does the payee's MEASURED receiving record clear every floor the caller set?
 *
 * Reads only `signals.receiving`, and treats an absent field as 0. The L1
 * counters are optional for back-compat, so an older server — or a trimmed
 * payload — must land on "no evidence", never on "requirement satisfied".
 */
function meetsEvidenceFloors(
  score: PayeeScoreResult,
  floors: SpendGuardEvidenceFloors,
): boolean {
  const receiving = score.signals?.receiving;
  const measured = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;

  const actual: Record<(typeof EVIDENCE_FLOOR_KEYS)[number], number> = {
    minL1Deliveries: measured(receiving?.l1DeliveryCount),
    minL1DistinctBuyers: measured(receiving?.l1DistinctBuyers),
    minX402Payments: measured(receiving?.paymentCount),
    minDistinctPayers: measured(receiving?.distinctPayers),
  };

  return EVIDENCE_FLOOR_KEYS.every((key) => {
    const floor = floors[key];
    return floor === undefined || actual[key] >= floor;
  });
}

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
export class SpendGuard {
  private readonly policy: SpendGuardPolicy;
  private readonly fetchPayeeScore: (payee: string) => Promise<PayeeScoreResult>;
  private readonly now: () => Date;
  private spentTodayUsd = 0;
  private currentDay: string;

  constructor(
    policy: SpendGuardPolicy,
    fetchPayeeScore: (payee: string) => Promise<PayeeScoreResult>,
    now: () => Date = () => new Date(),
  ) {
    assertPolicy(policy);
    this.policy = { ...policy };
    this.fetchPayeeScore = fetchPayeeScore;
    this.now = now;
    this.currentDay = this.utcDay();
  }

  async evaluate(input: SpendEvaluateInput): Promise<SpendDecision> {
    if (!WALLET_RE.test(input.payee)) throw new Error("invalid_payee_address");
    if (!Number.isFinite(input.amountUsd) || input.amountUsd <= 0) {
      throw new Error("invalid_amount_usd");
    }

    this.rollDayIfNeeded();

    const reasons: SpendDenyReason[] = [];
    const { maxPerTxUsd, dailyBudgetUsd, minPayeeScore, blockOnRecommendation } = this.policy;
    const trustPolicy = this.policy.trustPolicy ?? "allow-only";

    if (maxPerTxUsd !== undefined && input.amountUsd > maxPerTxUsd) {
      reasons.push("max_per_tx_exceeded");
    }
    if (
      dailyBudgetUsd !== undefined &&
      this.spentTodayUsd + input.amountUsd > dailyBudgetUsd
    ) {
      reasons.push("daily_budget_exceeded");
    }

    // Optimistic reservation: once the local rules pass, take the amount out
    // of today's budget BEFORE the trust lookup yields to the event loop.
    // Otherwise two concurrent evaluate() calls could both read the same
    // pre-reservation counter while their lookups were in flight and jointly
    // overshoot the budget (TOCTOU). A trust-rule deny returns it below.
    let reserved = false;
    if (reasons.length === 0) {
      this.spentTodayUsd += input.amountUsd;
      reserved = true;
    }

    let payeeScore: PayeeScoreResult | null = null;
    // Fail-closed default: "allow-only" and "block-only" always vet the
    // payee. Only the explicit "custom" opt-out makes the lookup conditional
    // on a trust rule being configured (pre-0.2.0 behaviour).
    const needsTrustLookup =
      trustPolicy !== "custom" ||
      minPayeeScore !== undefined ||
      blockOnRecommendation === true;

    if (needsTrustLookup && reasons.length === 0) {
      try {
        payeeScore = await this.fetchPayeeScore(input.payee);
      } catch (error) {
        reasons.push(classifyLookupFailure(error));
      }
      if (payeeScore) {
        // Freshness gate (H-2): a stale score is not a current measurement, so
        // it ranks with the fundamental defects below — enforced under the
        // fail-closed policies, not under the pre-0.2.0 "custom" opt-out.
        const maxScoreAgeMs = this.policy.maxScoreAgeMs ?? DEFAULT_MAX_SCORE_AGE_MS;
        const stale =
          trustPolicy !== "custom" &&
          isScoreStale(payeeScore, this.now().getTime(), maxScoreAgeMs);

        // Policy verdicts, most fundamental defect first: a degraded read is
        // not a measurement at all, a stale one is no longer current, a
        // partial measurement is not a clean one, and only then does the
        // recommendation itself get a say.
        if (trustPolicy === "allow-only") {
          if (payeeScore.degraded === true) {
            reasons.push("payee_score_degraded");
          } else if (stale) {
            reasons.push("payee_score_stale");
          } else if ((payeeScore.signalsUnavailable?.length ?? 0) > 0) {
            reasons.push("payee_partial_measurement");
          } else if (payeeScore.recommendation !== "ALLOW") {
            reasons.push("payee_recommendation_not_allow");
          }
        } else if (trustPolicy === "evidence") {
          // Identical to allow-only on every data-quality question — the whole
          // point is that opting into WARN does not cost you the H-2 freshness
          // gate or the degraded/partial refusals the way "custom" does.
          if (payeeScore.degraded === true) {
            reasons.push("payee_score_degraded");
          } else if (stale) {
            reasons.push("payee_score_stale");
          } else if ((payeeScore.signalsUnavailable?.length ?? 0) > 0) {
            reasons.push("payee_partial_measurement");
          } else if (payeeScore.recommendation === "BLOCK") {
            // BLOCK is never purchasable with evidence. Evidence explains a
            // WARN; it does not overturn a refusal.
            reasons.push("payee_recommendation_block");
          } else if (
            payeeScore.recommendation !== "ALLOW" &&
            !meetsEvidenceFloors(payeeScore, this.policy.requireEvidence ?? {})
          ) {
            reasons.push("payee_insufficient_evidence");
          }
        } else if (trustPolicy === "block-only") {
          if (payeeScore.degraded === true) {
            reasons.push("payee_score_degraded");
          } else if (stale) {
            reasons.push("payee_score_stale");
          } else if (payeeScore.recommendation === "BLOCK") {
            reasons.push("payee_recommendation_block");
          }
        }
        // Explicit rules compose on top in every mode.
        if (minPayeeScore !== undefined && payeeScore.score < minPayeeScore) {
          reasons.push("payee_score_below_min");
        }
        if (
          blockOnRecommendation === true &&
          payeeScore.recommendation === "BLOCK" &&
          !reasons.includes("payee_recommendation_block")
        ) {
          reasons.push("payee_recommendation_block");
        }
      }
    }

    const allow = reasons.length === 0;
    if (!allow && reserved) {
      // Trust rules denied after the optimistic reservation — give it back.
      // rollDayIfNeeded first: if the UTC day flipped while the lookup was in
      // flight, the counter was already reset and the release must clamp at 0
      // instead of dragging the fresh day's counter negative.
      this.rollDayIfNeeded();
      this.spentTodayUsd = Math.max(0, this.spentTodayUsd - input.amountUsd);
    }

    return {
      allow,
      reasons,
      payee: input.payee,
      amountUsd: input.amountUsd,
      spentTodayUsd: this.spentTodayUsd,
      remainingDailyBudgetUsd:
        dailyBudgetUsd !== undefined
          ? Math.max(0, dailyBudgetUsd - this.spentTodayUsd)
          : null,
      payeeScore,
    };
  }

  /**
   * Returns a previously reserved amount to today's budget. Call when an
   * allowed payment ultimately did not execute.
   */
  release(amountUsd: number): void {
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      throw new Error("invalid_amount_usd");
    }
    this.rollDayIfNeeded();
    this.spentTodayUsd = Math.max(0, this.spentTodayUsd - amountUsd);
  }

  /** Current in-memory budget state (UTC day + reserved USD). */
  state(): { day: string; spentTodayUsd: number } {
    this.rollDayIfNeeded();
    return { day: this.currentDay, spentTodayUsd: this.spentTodayUsd };
  }

  private rollDayIfNeeded(): void {
    const day = this.utcDay();
    if (day !== this.currentDay) {
      this.currentDay = day;
      this.spentTodayUsd = 0;
    }
  }

  private utcDay(): string {
    return this.now().toISOString().slice(0, 10);
  }
}
