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

export const SPEND_RULE_REFUSALS = [
  "invalid_rules",
  "rules_expired",
  "deny_pay_to",
  "max_per_tx",
  "require_allow",
  "min_delivery_rate",
  "payee_max_per_day",
  "payee_max_count_per_hour",
  "max_per_day",
  "max_count_per_hour",
] as const;

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
  perPayee?: Record<string, { maxPerDayUsd?: number; maxCountPerHour?: number }>;
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

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MICROS_PER_USD = 1_000_000;

type PayeeCaps = { maxPerDayUsd?: number; maxCountPerHour?: number };

type NormalizedRules = {
  maxPerTxUsd?: number;
  maxPerDayUsd?: number;
  maxCountPerHour?: number;
  minDeliveryRate?: number;
  requireAllow: boolean;
  /** Null when the caller did not write an expiry. */
  expiresAtMs: number | null;
  denyPayTo: string[];
  perPayee: Record<string, PayeeCaps>;
};

function refuse(refusedBy: SpendRuleRefusal): SpendRuleDecision {
  return { allow: false, refusedBy };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A written number that can be a cap: finite and not negative. Absent means "not written". */
function optionalCap(value: unknown): { ok: true; value: number | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return { ok: false };
  return { ok: true, value };
}

function optionalRate(value: unknown): { ok: true; value: number | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return { ok: false };
  return { ok: true, value };
}

/**
 * Turn the caller's object into the rules we know how to apply.
 * Null means the object is not a usable rule set (`invalid_rules`): a negative
 * cap, a cap written as a string, a rate outside 0–1, an expiry that is not a
 * date, or a list / per-payee map in the wrong shape. Unknown fields are ignored.
 */
function normalizeRules(rules: unknown): NormalizedRules | null {
  if (!isPlainObject(rules)) return null;
  const maxPerTxUsd = optionalCap(rules.maxPerTxUsd);
  const maxPerDayUsd = optionalCap(rules.maxPerDayUsd);
  const maxCountPerHour = optionalCap(rules.maxCountPerHour);
  const minDeliveryRate = optionalRate(rules.minDeliveryRate);
  if (!maxPerTxUsd.ok || !maxPerDayUsd.ok || !maxCountPerHour.ok || !minDeliveryRate.ok) return null;

  if (rules.requireAllow !== undefined && typeof rules.requireAllow !== "boolean") return null;

  let expiresAtMs: number | null = null;
  if (rules.expiresAt !== undefined) {
    if (typeof rules.expiresAt !== "string") return null;
    const parsed = Date.parse(rules.expiresAt);
    if (Number.isNaN(parsed)) return null;
    expiresAtMs = parsed;
  }

  if (rules.denyPayTo !== undefined) {
    if (!Array.isArray(rules.denyPayTo) || rules.denyPayTo.some((item) => typeof item !== "string")) return null;
  }

  const perPayee: Record<string, PayeeCaps> = {};
  if (rules.perPayee !== undefined) {
    if (!isPlainObject(rules.perPayee)) return null;
    for (const [key, raw] of Object.entries(rules.perPayee)) {
      if (typeof key !== "string" || !isPlainObject(raw)) return null;
      const day = optionalCap(raw.maxPerDayUsd);
      const hour = optionalCap(raw.maxCountPerHour);
      if (!day.ok || !hour.ok) return null;
      perPayee[key] = {
        ...(day.value !== undefined ? { maxPerDayUsd: day.value } : {}),
        ...(hour.value !== undefined ? { maxCountPerHour: hour.value } : {}),
      };
    }
  }

  return {
    ...(maxPerTxUsd.value !== undefined ? { maxPerTxUsd: maxPerTxUsd.value } : {}),
    ...(maxPerDayUsd.value !== undefined ? { maxPerDayUsd: maxPerDayUsd.value } : {}),
    ...(maxCountPerHour.value !== undefined ? { maxCountPerHour: maxCountPerHour.value } : {}),
    ...(minDeliveryRate.value !== undefined ? { minDeliveryRate: minDeliveryRate.value } : {}),
    requireAllow: rules.requireAllow === true,
    expiresAtMs,
    denyPayTo: Array.isArray(rules.denyPayTo) ? rules.denyPayTo.filter((item): item is string => typeof item === "string") : [],
    perPayee,
  };
}

/** Micro-dollars, with the same ulp tolerance SpendGuard uses so exact decimals stay exact. */
function toMicros(usd: number, direction: "up" | "down"): number {
  const x = usd * MICROS_PER_USD;
  const rounded = Math.round(x);
  if (Math.abs(x - rounded) <= Math.abs(x) * 4 * Number.EPSILON) return rounded;
  return direction === "up" ? Math.ceil(x) : Math.floor(x);
}

/** True when `amountUsd` is past `limitUsd`. An amount that is not a real non-negative number is past every cap. */
function exceeds(amountUsd: number, limitUsd: number): boolean {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) return true;
  return toMicros(amountUsd, "up") > toMicros(limitUsd, "down");
}

function samePayee(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function inWindow(row: SpendRecord, nowMs: number, windowMs: number): boolean {
  return typeof row.at === "number" && Number.isFinite(row.at) && row.at >= nowMs - windowMs;
}

function rowsFor(history: SpendRecord[], nowMs: number, windowMs: number, payTo?: string): SpendRecord[] {
  return history.filter((row) => {
    if (!inWindow(row, nowMs, windowMs)) return false;
    if (payTo === undefined) return true;
    return typeof row.payTo === "string" && samePayee(row.payTo, payTo);
  });
}

/** The running total plus this payment, in micro-dollars. A row with an unusable amount fails closed. */
function totalWouldExceed(rows: SpendRecord[], amountUsd: number, limitUsd: number): boolean {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) return true;
  let total = toMicros(amountUsd, "up");
  for (const row of rows) {
    if (typeof row.amountUsd !== "number" || !Number.isFinite(row.amountUsd) || row.amountUsd < 0) return true;
    total += toMicros(row.amountUsd, "up");
  }
  return total > toMicros(limitUsd, "down");
}

function payeeCaps(rules: NormalizedRules, payTo: string): PayeeCaps | undefined {
  const needle = payTo.toLowerCase();
  for (const [key, caps] of Object.entries(rules.perPayee)) {
    if (key.toLowerCase() === needle) return caps;
  }
  return undefined;
}

/**
 * May this payment proceed? `history` is what has already been paid (this
 * payment is not in it). `nowMs` is the clock the windows are measured from.
 */
export function evaluateSpendRules(
  rules: SpendRules,
  intent: SpendIntent,
  history: SpendRecord[],
  nowMs: number,
): SpendRuleDecision {
  const normalized = normalizeRules(rules);
  if (!normalized || !Array.isArray(history) || typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
    return refuse("invalid_rules");
  }

  if (normalized.expiresAtMs !== null && nowMs >= normalized.expiresAtMs) return refuse("rules_expired");

  const payTo = typeof intent?.payTo === "string" ? intent.payTo : "";
  if (payTo !== "" && normalized.denyPayTo.some((denied) => samePayee(denied, payTo))) return refuse("deny_pay_to");

  if (normalized.maxPerTxUsd !== undefined && exceeds(intent?.amountUsd, normalized.maxPerTxUsd)) {
    return refuse("max_per_tx");
  }

  if (normalized.requireAllow && intent?.recommendation !== "ALLOW") return refuse("require_allow");

  if (normalized.minDeliveryRate !== undefined) {
    const rate = intent?.deliveryRate;
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate < normalized.minDeliveryRate) {
      return refuse("min_delivery_rate");
    }
  }

  const caps = payTo !== "" ? payeeCaps(normalized, payTo) : undefined;
  if (caps?.maxPerDayUsd !== undefined) {
    const rows = rowsFor(history, nowMs, DAY_MS, payTo);
    if (totalWouldExceed(rows, intent?.amountUsd, caps.maxPerDayUsd)) return refuse("payee_max_per_day");
  }
  if (caps?.maxCountPerHour !== undefined) {
    const rows = rowsFor(history, nowMs, HOUR_MS, payTo);
    if (rows.length + 1 > caps.maxCountPerHour) return refuse("payee_max_count_per_hour");
  }

  if (normalized.maxPerDayUsd !== undefined) {
    const rows = rowsFor(history, nowMs, DAY_MS);
    if (totalWouldExceed(rows, intent?.amountUsd, normalized.maxPerDayUsd)) return refuse("max_per_day");
  }
  if (normalized.maxCountPerHour !== undefined) {
    const rows = rowsFor(history, nowMs, HOUR_MS);
    if (rows.length + 1 > normalized.maxCountPerHour) return refuse("max_count_per_hour");
  }

  return { allow: true, refusedBy: null };
}
