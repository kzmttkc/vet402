// ============================================================
// P1 使う決まりの合格の表（2026-11-08・Claude が先に固定。実装はこの表を緑にする）。
// evaluateSpendRules は純粋関数: 決まり・払おうとしている 1 件・手元の支払いの記録・今の時刻から、
// 払ってよいかと、止めた決まりの名前を返す。vet402 にお金も鍵も渡さない（記録は手元のもの）。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";

const { evaluateSpendRules, SPEND_RULE_REFUSALS } = await import("../dist/index.js");

const NOW = Date.parse("2026-11-08T12:00:00.000Z");
const PAY_TO = "0x" + "11".repeat(20);
const OTHER = "0x" + "22".repeat(20);

const intent = (p = {}) => ({ payTo: PAY_TO, host: "api.example.org", resourceId: "r-1", amountUsd: 0.05, recommendation: "ALLOW", deliveryRate: 0.98, ...p });
const paid = (p = {}) => ({ payTo: PAY_TO, host: "api.example.org", resourceId: "r-1", amountUsd: 0.05, at: NOW - 60_000, ...p });

const RULES = {
  maxPerTxUsd: 0.1,
  maxPerDayUsd: 1,
  perPayee: { [PAY_TO]: { maxPerDayUsd: 0.2, maxCountPerHour: 3 } },
  maxCountPerHour: 20,
  denyPayTo: [OTHER],
  requireAllow: true,
  minDeliveryRate: 0.9,
  expiresAt: "2026-12-01T00:00:00.000Z",
};

test("P1 pass: inside every limit, ALLOW, delivery rate above the floor", () => {
  const d = evaluateSpendRules(RULES, intent(), [paid()], NOW);
  assert.equal(d.allow, true);
  assert.equal(d.refusedBy, null);
});

const REFUSE = [
  ["above the per-payment limit", "max_per_tx", RULES, intent({ amountUsd: 0.11 }), []],
  ["the day's total would pass the daily limit", "max_per_day", { ...RULES, perPayee: {} }, intent({ amountUsd: 0.1 }), Array.from({ length: 10 }, (_, i) => paid({ payTo: "0x" + String(i).padStart(40, "3"), amountUsd: 0.095, at: NOW - 3_600_000 * (i % 10) }))],
  ["this payee's day would pass its limit", "payee_max_per_day", RULES, intent({ amountUsd: 0.06 }), [paid({ amountUsd: 0.08 }), paid({ amountUsd: 0.07, at: NOW - 7_200_000 })]],
  ["this payee's hourly count is used up", "payee_max_count_per_hour", RULES, intent(), [paid(), paid({ at: NOW - 120_000 }), paid({ at: NOW - 1_800_000 })]],
  ["the overall hourly count is used up", "max_count_per_hour", { ...RULES, maxCountPerHour: 2, perPayee: {} }, intent(), [paid({ payTo: OTHER.replace("22", "44") }), paid({ payTo: OTHER.replace("22", "55") })]],
  ["a denied payee", "deny_pay_to", RULES, intent({ payTo: OTHER }), []],
  ["a WARN when ALLOW is required", "require_allow", RULES, intent({ recommendation: "WARN" }), []],
  ["vet402 did not answer (fail-closed)", "require_allow", RULES, intent({ recommendation: null, deliveryRate: null }), []],
  ["delivery rate under the floor", "min_delivery_rate", RULES, intent({ deliveryRate: 0.5 }), []],
  ["no delivery rate when a floor is set", "min_delivery_rate", { ...RULES, requireAllow: false }, intent({ deliveryRate: null }), []],
  ["the rules have expired", "rules_expired", { ...RULES, expiresAt: "2026-11-01T00:00:00.000Z" }, intent(), []],
  ["this host's day would pass its limit", "host_max_per_day", { maxPerTxUsd: 1, perHost: { "api.example.org": { maxPerDayUsd: 0.2 } } }, intent(), [paid({ amountUsd: 0.16 })]],
  ["this host's hourly count is used up", "host_max_count_per_hour", { maxPerTxUsd: 1, perHost: { "api.example.org": { maxCountPerHour: 2 } } }, intent(), [paid(), paid({ at: NOW - 120_000 })]],
  ["this resource's day would pass its limit", "resource_max_per_day", { maxPerTxUsd: 1, perResourceId: { "r-1": { maxPerDayUsd: 0.15 } } }, intent(), [paid({ amountUsd: 0.11 })]],
  ["this resource's hourly count is used up", "resource_max_count_per_hour", { maxPerTxUsd: 1, perResourceId: { "r-1": { maxCountPerHour: 1 } } }, intent(), [paid()]],
];

for (const [name, reason, rules, it, history] of REFUSE) {
  test(`P1 refuse: ${name} → ${reason}`, () => {
    const d = evaluateSpendRules(rules, it, history, NOW);
    assert.equal(d.allow, false);
    assert.equal(d.refusedBy, reason);
    assert.ok(SPEND_RULE_REFUSALS.includes(reason));
  });
}

test("P1: payments older than the window do not count", () => {
  const old = [paid({ amountUsd: 0.19, at: NOW - 25 * 3_600_000 })];
  assert.equal(evaluateSpendRules(RULES, intent({ amountUsd: 0.05 }), old, NOW).allow, true, "yesterday's payment is outside the 24 h day");
  const hourOld = [paid({ at: NOW - 61 * 60_000 }), paid({ at: NOW - 62 * 60_000 }), paid({ at: NOW - 63 * 60_000 })];
  assert.equal(evaluateSpendRules(RULES, intent(), hourOld, NOW).allow, true, "payments over an hour ago do not use the hourly count");
});

test("P1: payTo is compared without case, and a rule not written is not applied", () => {
  assert.equal(evaluateSpendRules(RULES, intent({ payTo: OTHER.toUpperCase().replace("0X", "0x") }), [], NOW).refusedBy, "deny_pay_to");
  assert.equal(evaluateSpendRules({}, intent({ amountUsd: 999, recommendation: "WARN", deliveryRate: null }), [], NOW).allow, true);
});

test("P1: a malformed rule refuses instead of being ignored", () => {
  for (const bad of [{ maxPerTxUsd: -1 }, { maxPerTxUsd: "0.1" }, { minDeliveryRate: 1.5 }, { expiresAt: "not a date" }]) {
    const d = evaluateSpendRules(bad, intent(), [], NOW);
    assert.equal(d.allow, false, JSON.stringify(bad));
    assert.equal(d.refusedBy, "invalid_rules");
  }
});
