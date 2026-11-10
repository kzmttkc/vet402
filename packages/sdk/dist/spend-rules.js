/**
 * Local spend rules. A pure function: the rules, the one payment about to
 * happen, the payments already recorded on this machine, and the clock.
 * Nothing here talks to vet402, holds a key, or moves money.
 *
 * The order is fixed (the first hit wins):
 *   invalid_rules → rules_expired → deny_pay_to → max_per_tx → require_allow →
 *   min_delivery_rate → payee_max_per_day → payee_max_count_per_hour →
 *   host_max_per_day → host_max_count_per_hour → resource_max_per_day →
 *   resource_max_count_per_hour → max_per_day → max_count_per_hour.
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
    "host_max_per_day",
    "host_max_count_per_hour",
    "resource_max_per_day",
    "resource_max_count_per_hour",
    "max_per_day",
    "max_count_per_hour",
];
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const MICROS_PER_USD = 1_000_000;
function refuse(refusedBy) {
    return { allow: false, refusedBy };
}
function isPlainObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** A written number that can be a cap: finite and not negative. Absent means "not written". */
function optionalCap(value) {
    if (value === undefined)
        return { ok: true, value: undefined };
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
        return { ok: false };
    return { ok: true, value };
}
function optionalRate(value) {
    if (value === undefined)
        return { ok: true, value: undefined };
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
        return { ok: false };
    return { ok: true, value };
}
/**
 * Turn the caller's object into the rules we know how to apply.
 * Null means the object is not a usable rule set (`invalid_rules`): a negative
 * cap, a cap written as a string, a rate outside 0–1, an expiry that is not a
 * date, or a list / per-payee map in the wrong shape. Unknown fields are ignored.
 */
function normalizeRules(rules) {
    if (!isPlainObject(rules))
        return null;
    const maxPerTxUsd = optionalCap(rules.maxPerTxUsd);
    const maxPerDayUsd = optionalCap(rules.maxPerDayUsd);
    const maxCountPerHour = optionalCap(rules.maxCountPerHour);
    const minDeliveryRate = optionalRate(rules.minDeliveryRate);
    if (!maxPerTxUsd.ok || !maxPerDayUsd.ok || !maxCountPerHour.ok || !minDeliveryRate.ok)
        return null;
    if (rules.requireAllow !== undefined && typeof rules.requireAllow !== "boolean")
        return null;
    let expiresAtMs = null;
    if (rules.expiresAt !== undefined) {
        if (typeof rules.expiresAt !== "string")
            return null;
        const parsed = Date.parse(rules.expiresAt);
        if (Number.isNaN(parsed))
            return null;
        expiresAtMs = parsed;
    }
    if (rules.denyPayTo !== undefined) {
        if (!Array.isArray(rules.denyPayTo) || rules.denyPayTo.some((item) => typeof item !== "string"))
            return null;
    }
    const parseCapsMap = (raw) => {
        if (!isPlainObject(raw))
            return null;
        const out = {};
        for (const [key, row] of Object.entries(raw)) {
            if (typeof key !== "string" || !isPlainObject(row))
                return null;
            const day = optionalCap(row.maxPerDayUsd);
            const hour = optionalCap(row.maxCountPerHour);
            if (!day.ok || !hour.ok)
                return null;
            out[key] = {
                ...(day.value !== undefined ? { maxPerDayUsd: day.value } : {}),
                ...(hour.value !== undefined ? { maxCountPerHour: hour.value } : {}),
            };
        }
        return out;
    };
    let perPayee = {};
    if (rules.perPayee !== undefined) {
        const parsed = parseCapsMap(rules.perPayee);
        if (parsed === null)
            return null;
        perPayee = parsed;
    }
    let perHost = {};
    if (rules.perHost !== undefined) {
        const parsed = parseCapsMap(rules.perHost);
        if (parsed === null)
            return null;
        perHost = parsed;
    }
    let perResourceId = {};
    if (rules.perResourceId !== undefined) {
        const parsed = parseCapsMap(rules.perResourceId);
        if (parsed === null)
            return null;
        perResourceId = parsed;
    }
    return {
        ...(maxPerTxUsd.value !== undefined ? { maxPerTxUsd: maxPerTxUsd.value } : {}),
        ...(maxPerDayUsd.value !== undefined ? { maxPerDayUsd: maxPerDayUsd.value } : {}),
        ...(maxCountPerHour.value !== undefined ? { maxCountPerHour: maxCountPerHour.value } : {}),
        ...(minDeliveryRate.value !== undefined ? { minDeliveryRate: minDeliveryRate.value } : {}),
        requireAllow: rules.requireAllow === true,
        expiresAtMs,
        denyPayTo: Array.isArray(rules.denyPayTo) ? rules.denyPayTo.filter((item) => typeof item === "string") : [],
        perPayee,
        perHost,
        perResourceId,
    };
}
/** Micro-dollars, with the same ulp tolerance SpendGuard uses so exact decimals stay exact. */
function toMicros(usd, direction) {
    const x = usd * MICROS_PER_USD;
    const rounded = Math.round(x);
    if (Math.abs(x - rounded) <= Math.abs(x) * 4 * Number.EPSILON)
        return rounded;
    return direction === "up" ? Math.ceil(x) : Math.floor(x);
}
/** True when `amountUsd` is past `limitUsd`. An amount that is not a real non-negative number is past every cap. */
function exceeds(amountUsd, limitUsd) {
    if (!Number.isFinite(amountUsd) || amountUsd < 0)
        return true;
    return toMicros(amountUsd, "up") > toMicros(limitUsd, "down");
}
function samePayee(a, b) {
    return a.toLowerCase() === b.toLowerCase();
}
function inWindow(row, nowMs, windowMs) {
    return typeof row.at === "number" && Number.isFinite(row.at) && row.at >= nowMs - windowMs;
}
function rowsFor(history, nowMs, windowMs, match) {
    return history.filter((row) => {
        if (!inWindow(row, nowMs, windowMs))
            return false;
        if (match?.payTo !== undefined) {
            return typeof row.payTo === "string" && samePayee(row.payTo, match.payTo);
        }
        if (match?.host !== undefined) {
            return typeof row.host === "string" && row.host.toLowerCase() === match.host.toLowerCase();
        }
        if (match?.resourceId !== undefined) {
            return typeof row.resourceId === "string" && row.resourceId === match.resourceId;
        }
        return true;
    });
}
/** The running total plus this payment, in micro-dollars. A row with an unusable amount fails closed. */
function totalWouldExceed(rows, amountUsd, limitUsd) {
    if (!Number.isFinite(amountUsd) || amountUsd < 0)
        return true;
    let total = toMicros(amountUsd, "up");
    for (const row of rows) {
        if (typeof row.amountUsd !== "number" || !Number.isFinite(row.amountUsd) || row.amountUsd < 0)
            return true;
        total += toMicros(row.amountUsd, "up");
    }
    return total > toMicros(limitUsd, "down");
}
function capsForKey(map, key, caseInsensitive) {
    const needle = caseInsensitive ? key.toLowerCase() : key;
    for (const [entry, caps] of Object.entries(map)) {
        const hay = caseInsensitive ? entry.toLowerCase() : entry;
        if (hay === needle)
            return caps;
    }
    return undefined;
}
/**
 * May this payment proceed? `history` is what has already been paid (this
 * payment is not in it). `nowMs` is the clock the windows are measured from.
 */
export function evaluateSpendRules(rules, intent, history, nowMs) {
    const normalized = normalizeRules(rules);
    if (!normalized || !Array.isArray(history) || typeof nowMs !== "number" || !Number.isFinite(nowMs)) {
        return refuse("invalid_rules");
    }
    if (normalized.expiresAtMs !== null && nowMs >= normalized.expiresAtMs)
        return refuse("rules_expired");
    const payTo = typeof intent?.payTo === "string" ? intent.payTo : "";
    if (payTo !== "" && normalized.denyPayTo.some((denied) => samePayee(denied, payTo)))
        return refuse("deny_pay_to");
    if (normalized.maxPerTxUsd !== undefined && exceeds(intent?.amountUsd, normalized.maxPerTxUsd)) {
        return refuse("max_per_tx");
    }
    if (normalized.requireAllow && intent?.recommendation !== "ALLOW")
        return refuse("require_allow");
    if (normalized.minDeliveryRate !== undefined) {
        const rate = intent?.deliveryRate;
        if (typeof rate !== "number" || !Number.isFinite(rate) || rate < normalized.minDeliveryRate) {
            return refuse("min_delivery_rate");
        }
    }
    const payeeCap = payTo !== "" ? capsForKey(normalized.perPayee, payTo, true) : undefined;
    if (payeeCap?.maxPerDayUsd !== undefined) {
        const rows = rowsFor(history, nowMs, DAY_MS, { payTo });
        if (totalWouldExceed(rows, intent?.amountUsd, payeeCap.maxPerDayUsd))
            return refuse("payee_max_per_day");
    }
    if (payeeCap?.maxCountPerHour !== undefined) {
        const rows = rowsFor(history, nowMs, HOUR_MS, { payTo });
        if (rows.length + 1 > payeeCap.maxCountPerHour)
            return refuse("payee_max_count_per_hour");
    }
    const host = typeof intent?.host === "string" ? intent.host : "";
    const hostCap = host !== "" ? capsForKey(normalized.perHost, host, true) : undefined;
    if (hostCap?.maxPerDayUsd !== undefined) {
        const rows = rowsFor(history, nowMs, DAY_MS, { host });
        if (totalWouldExceed(rows, intent?.amountUsd, hostCap.maxPerDayUsd))
            return refuse("host_max_per_day");
    }
    if (hostCap?.maxCountPerHour !== undefined) {
        const rows = rowsFor(history, nowMs, HOUR_MS, { host });
        if (rows.length + 1 > hostCap.maxCountPerHour)
            return refuse("host_max_count_per_hour");
    }
    const resourceId = typeof intent?.resourceId === "string" ? intent.resourceId : "";
    const resourceCap = resourceId !== "" ? capsForKey(normalized.perResourceId, resourceId, false) : undefined;
    if (resourceCap?.maxPerDayUsd !== undefined) {
        const rows = rowsFor(history, nowMs, DAY_MS, { resourceId });
        if (totalWouldExceed(rows, intent?.amountUsd, resourceCap.maxPerDayUsd))
            return refuse("resource_max_per_day");
    }
    if (resourceCap?.maxCountPerHour !== undefined) {
        const rows = rowsFor(history, nowMs, HOUR_MS, { resourceId });
        if (rows.length + 1 > resourceCap.maxCountPerHour)
            return refuse("resource_max_count_per_hour");
    }
    if (normalized.maxPerDayUsd !== undefined) {
        const rows = rowsFor(history, nowMs, DAY_MS);
        if (totalWouldExceed(rows, intent?.amountUsd, normalized.maxPerDayUsd))
            return refuse("max_per_day");
    }
    if (normalized.maxCountPerHour !== undefined) {
        const rows = rowsFor(history, nowMs, HOUR_MS);
        if (rows.length + 1 > normalized.maxCountPerHour)
            return refuse("max_count_per_hour");
    }
    return { allow: true, refusedBy: null };
}
