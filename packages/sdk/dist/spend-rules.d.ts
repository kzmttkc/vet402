/**
 * Local spend rules. A pure function: the rules, the one payment about to
 * happen, the payments already recorded on this machine, and the clock.
 * Nothing here talks to vet402, holds a key, or moves money.
 *
 * The order is fixed (the first hit wins):
 *   invalid_rules → rules_expired → deny_pay_to → max_per_tx → require_allow →
 *   min_delivery_rate → payee_max_per_day → payee_max_count_per_hour →
 *   max_per_day → max_count_per_hour.
 *
 * A field that is absent is not applied. A day is the last 24 hours and an
 * hour is the last 60 minutes, both measured back from `nowMs`. A total that
 * lands on the limit passes; a total past it refuses. `payTo` is compared
 * without regard to case. Money is compared in micro-dollars so a value that
 * is exact in decimal is exact here too.
 */
export declare const SPEND_RULE_REFUSALS: readonly ["invalid_rules", "rules_expired", "deny_pay_to", "max_per_tx", "require_allow", "min_delivery_rate", "payee_max_per_day", "payee_max_count_per_hour", "max_per_day", "max_count_per_hour"];
export type SpendRuleRefusal = (typeof SPEND_RULE_REFUSALS)[number];
/** Limits the caller wrote down. Every field is optional; an absent field is not applied. */
export type SpendRules = {
    /** Refuse when this payment's USD amount is above the cap. The cap itself passes. */
    maxPerTxUsd?: number;
    /** Refuse when the last 24 hours, including this payment, would go above this USD total. */
    maxPerDayUsd?: number;
    /** Refuse when this payment would make the last 60 minutes more than this many payments. */
    maxCountPerHour?: number;
    /** Same two caps, counted only for the payee whose address matches the key (any case). */
    perPayee?: Record<string, {
        maxPerDayUsd?: number;
        maxCountPerHour?: number;
    }>;
    /** Payees that are never paid. Compared without regard to case. */
    denyPayTo?: string[];
    /** When true, the payment needs vet402's recommendation to be exactly `ALLOW`. */
    requireAllow?: boolean;
    /** When set, `deliveryRate` must be a number and at least this (0–1, and this value itself passes). */
    minDeliveryRate?: number;
    /** ISO-8601 instant. At and after this instant the rules refuse with `rules_expired`. */
    expiresAt?: string;
};
/** The one payment under consideration. `recommendation` and `deliveryRate` come from vet402. */
export type SpendIntent = {
    payTo: string;
    host: string;
    resourceId: string;
    amountUsd: number;
    recommendation: "ALLOW" | "WARN" | "BLOCK" | null;
    deliveryRate: number | null;
};
/** One payment already made, as recorded on this machine. `at` is unix milliseconds. */
export type SpendRecord = {
    payTo: string;
    host: string;
    resourceId: string;
    amountUsd: number;
    at: number;
};
export type SpendRuleDecision = {
    allow: boolean;
    /** The first rule that refused, or null when the payment may proceed. */
    refusedBy: SpendRuleRefusal | null;
};
/**
 * May this payment proceed? `history` is what has already been paid (this
 * payment is not in it). `nowMs` is the clock the windows are measured from.
 */
export declare function evaluateSpendRules(rules: SpendRules, intent: SpendIntent, history: SpendRecord[], nowMs: number): SpendRuleDecision;
