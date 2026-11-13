// D4 (ABSORB wave 1): human approval on spend-guard, before any signature.
// The delivery rate on the prompt is the payee score receiving ledger.
// SpendRules read a null delivery rate, so that prompt cannot open a floor.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SpendGuard } from "../dist/index.js";

const PAYEE = "0x1111111111111111111111111111111111111111";
const PHRASE = "amber-ridge";

const scoreFetcher =
  (receiving = {}) =>
  async () => ({
    payee: PAYEE,
    score: 80,
    recommendation: "ALLOW",
    dataDepth: "moderate",
    degraded: false,
    signalsUnavailable: [],
    signals: {
      receiving: {
        paymentCount: 5,
        uniqueDays: 3,
        distinctPayers: 2,
        score: 68,
        l1DeliveryCount: 9,
        l1Settled: 10,
        l1PaidNeverSettled: 1,
        ...receiving,
      },
      walletHealth: { ageDays: 120, txCount: 300, isBurner: false, score: 85 },
      drainPattern: {
        detected: false,
        drainRatio: 0.1,
        outgoingCount: 3,
        incomingCount: 8,
        score: 85,
      },
      outcomeHistory: { types: [], adjustment: 0 },
      flags: [],
    },
    scoredAt: new Date().toISOString(),
    cacheExpiresAt: new Date(Date.now() + 300000).toISOString(),
    disclaimer: "test",
  });

const mustNotFetch = async () => {
  throw new Error("unexpected_trust_lookup");
};

async function promptFor(receiving) {
  let seen = null;
  const guard = new SpendGuard(
    {
      trustPolicy: "custom",
      onApproval: async (prompt) => {
        seen = prompt;
        return true;
      },
    },
    scoreFetcher(receiving),
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 2.5, approvalPhrase: PHRASE });
  assert.equal(decision.allow, true);
  assert.equal(seen !== null, true);
  return seen;
}

test("onApproval prompt shows phrase, amount, payee, and the receiving delivery rate", async () => {
  const seen = await promptFor({});
  assert.deepEqual(seen, {
    phrase: PHRASE,
    amountUsd: 2.5,
    payee: PAYEE,
    deliveryRate: 9 / 11,
  });
});

test("approval prompt counts paid attempts that never settled", async () => {
  const seen = await promptFor({ l1DeliveryCount: 10, l1Settled: 10, l1PaidNeverSettled: 140 });
  assert.ok(Math.abs(seen.deliveryRate - 10 / 150) < 1e-12);
  assert.notEqual(seen.deliveryRate, 1);
});

test("approval prompt does not divide deliveries by settled alone", async () => {
  const seen = await promptFor({ l1DeliveryCount: 48, l1Settled: 1, l1PaidNeverSettled: 0 });
  assert.notEqual(seen.deliveryRate, 48);
  assert.equal(seen.deliveryRate, 1);
});

test("approval prompt leaves the rate null when nothing conclusive was counted", async () => {
  const seen = await promptFor({ l1DeliveryCount: 10, l1Settled: 0, l1PaidNeverSettled: 0 });
  assert.equal(seen.deliveryRate, null);
});

test("approval prompt is zero when every conclusive attempt missed delivery", async () => {
  const seen = await promptFor({ l1DeliveryCount: 0, l1Settled: 0, l1PaidNeverSettled: 140 });
  assert.equal(seen.deliveryRate, 0);
});

test("approval prompt keeps pending verification out of the denominator", async () => {
  const seen = await promptFor({
    l1DeliveryCount: 9,
    l1Settled: 10,
    l1PaidNeverSettled: 0,
    l1PendingVerification: 140,
  });
  assert.equal(seen.deliveryRate, 0.9);
  assert.notEqual(seen.deliveryRate, 9 / 150);
});

test("approval prompt is null when the delivery count is negative", async () => {
  const seen = await promptFor({ l1DeliveryCount: -1, l1Settled: 10, l1PaidNeverSettled: 0 });
  assert.equal(seen.deliveryRate, null);
});

test("denies with human_approval_denied when onApproval refuses", async () => {
  const guard = new SpendGuard(
    { trustPolicy: "custom", onApproval: async () => false },
    mustNotFetch,
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1, approvalPhrase: PHRASE });
  assert.equal(decision.allow, false);
  assert.equal(decision.spendRulesRefusedBy, null);
  assert.deepEqual(decision.reasons, ["human_approval_denied"]);
});

test("signIfAllowed does not call sign without approval", async () => {
  let signed = 0;
  const guard = new SpendGuard(
    { trustPolicy: "custom", onApproval: async () => false },
    mustNotFetch,
  );
  const out = await guard.signIfAllowed(
    { payee: PAYEE, amountUsd: 1, approvalPhrase: PHRASE },
    () => {
      signed += 1;
      return "0x" + "aa".repeat(32);
    },
  );
  assert.equal(out.signature, null);
  assert.equal(signed, 0);
  assert.equal(out.decision.spendRulesRefusedBy, null);
  assert.deepEqual(out.decision.reasons, ["human_approval_denied"]);
});

test("signIfAllowed signs only after approval", async () => {
  let signed = 0;
  const guard = new SpendGuard(
    { trustPolicy: "custom", onApproval: async () => true },
    mustNotFetch,
  );
  const out = await guard.signIfAllowed(
    { payee: PAYEE, amountUsd: 1, approvalPhrase: PHRASE },
    () => {
      signed += 1;
      return "0x" + "bb".repeat(32);
    },
  );
  assert.equal(signed, 1);
  assert.equal(out.signature, "0x" + "bb".repeat(32));
  assert.equal(out.decision.allow, true);
});

test("an existing per-transaction cap still refuses before approval", async () => {
  let called = false;
  const guard = new SpendGuard(
    {
      maxPerTxUsd: 1,
      trustPolicy: "custom",
      onApproval: async () => {
        called = true;
        return true;
      },
    },
    mustNotFetch,
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 2, approvalPhrase: PHRASE });
  assert.equal(called, false);
  assert.equal(decision.spendRulesRefusedBy, null);
  assert.deepEqual(decision.reasons, ["max_per_tx_exceeded"]);
});

test("SpendRules max_per_tx and human_approval_denied stay distinct on one decision", async () => {
  const rulesGuard = new SpendGuard(
    { trustPolicy: "custom", spendRules: { maxPerTxUsd: 1 }, onApproval: async () => true },
    mustNotFetch,
  );
  const rulesDecision = await rulesGuard.evaluate({ payee: PAYEE, amountUsd: 2, approvalPhrase: PHRASE });
  assert.equal(rulesDecision.allow, false);
  assert.equal(rulesDecision.spendRulesRefusedBy, "max_per_tx");
  assert.equal(rulesDecision.reasons.includes("human_approval_denied"), false);

  const approvalGuard = new SpendGuard(
    { trustPolicy: "custom", spendRules: { maxPerTxUsd: 10 }, onApproval: async () => false },
    mustNotFetch,
  );
  const approvalDecision = await approvalGuard.evaluate({
    payee: PAYEE,
    amountUsd: 2,
    approvalPhrase: PHRASE,
  });
  assert.equal(approvalDecision.allow, false);
  assert.equal(approvalDecision.spendRulesRefusedBy, null);
  assert.deepEqual(approvalDecision.reasons, ["human_approval_denied"]);
});

test("signIfAllowed does not sign when SpendRules already refused", async () => {
  let signed = 0;
  let called = false;
  const guard = new SpendGuard(
    {
      trustPolicy: "custom",
      spendRules: { maxPerTxUsd: 1 },
      onApproval: async () => {
        called = true;
        return true;
      },
    },
    mustNotFetch,
  );
  const out = await guard.signIfAllowed(
    { payee: PAYEE, amountUsd: 2, approvalPhrase: PHRASE },
    () => {
      signed += 1;
      return "0x" + "cc".repeat(32);
    },
  );
  assert.equal(called, false);
  assert.equal(signed, 0);
  assert.equal(out.signature, null);
  assert.equal(out.decision.spendRulesRefusedBy, "max_per_tx");
});

test("displayed delivery rate does not open a SpendRules minDeliveryRate floor", async () => {
  let called = false;
  const guard = new SpendGuard(
    {
      trustPolicy: "custom",
      minPayeeScore: 1,
      spendRules: { minDeliveryRate: 0.9 },
      onApproval: async () => {
        called = true;
        return true;
      },
    },
    scoreFetcher({ l1DeliveryCount: 19, l1Settled: 20, l1PaidNeverSettled: 0 }),
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1, approvalPhrase: PHRASE });
  assert.equal(called, false);
  assert.equal(decision.allow, false);
  assert.equal(decision.spendRulesRefusedBy, "min_delivery_rate");
  assert.equal(decision.reasons.includes("human_approval_denied"), false);
});

test("a display lookup does not satisfy SpendRules requireAllow", async () => {
  let called = false;
  const guard = new SpendGuard(
    {
      trustPolicy: "custom",
      spendRules: { requireAllow: true },
      onApproval: async () => {
        called = true;
        return true;
      },
    },
    scoreFetcher(),
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1, approvalPhrase: PHRASE });
  assert.equal(called, false);
  assert.equal(decision.allow, false);
  assert.equal(decision.spendRulesRefusedBy, "require_allow");
});

test("spend history is the records passed on this call and is not kept on the guard", async () => {
  const guard = new SpendGuard(
    {
      trustPolicy: "custom",
      spendRules: { maxPerDayUsd: 3 },
      onApproval: async () => true,
    },
    mustNotFetch,
  );
  const row = {
    payTo: PAYEE,
    host: "seller.example",
    resourceId: "r",
    amountUsd: 2,
    at: Date.now(),
  };
  const blocked = await guard.evaluate({
    payee: PAYEE,
    amountUsd: 2,
    approvalPhrase: PHRASE,
    spendHistory: [row],
  });
  assert.equal(blocked.allow, false);
  assert.equal(blocked.spendRulesRefusedBy, "max_per_day");

  const open = await guard.evaluate({
    payee: PAYEE,
    amountUsd: 2,
    approvalPhrase: PHRASE,
    spendHistory: [],
  });
  assert.equal(open.allow, true);
  assert.equal(open.spendRulesRefusedBy, null);
});

test("releases the daily reservation when SpendRules refuses", async () => {
  const guard = new SpendGuard(
    {
      dailyBudgetUsd: 5,
      trustPolicy: "custom",
      spendRules: { maxPerTxUsd: 1 },
      onApproval: async () => true,
    },
    mustNotFetch,
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 2, approvalPhrase: PHRASE });
  assert.equal(decision.allow, false);
  assert.equal(decision.spendRulesRefusedBy, "max_per_tx");
  assert.equal(guard.state().spentTodayUsd, 0);
});

test("releases daily budget when onApproval throws", async () => {
  const guard = new SpendGuard(
    {
      dailyBudgetUsd: 5,
      trustPolicy: "custom",
      onApproval: async () => {
        throw new Error("dialog_closed");
      },
    },
    mustNotFetch,
  );
  await assert.rejects(
    () => guard.evaluate({ payee: PAYEE, amountUsd: 2, approvalPhrase: PHRASE }),
    /dialog_closed/,
  );
  assert.equal(guard.state().spentTodayUsd, 0);
});

test("releases daily budget when sign throws after approval", async () => {
  const guard = new SpendGuard(
    { dailyBudgetUsd: 5, trustPolicy: "custom", onApproval: async () => true },
    mustNotFetch,
  );
  await assert.rejects(
    () =>
      guard.signIfAllowed({ payee: PAYEE, amountUsd: 2, approvalPhrase: PHRASE }, () => {
        throw new Error("sign_failed");
      }),
    /sign_failed/,
  );
  assert.equal(guard.state().spentTodayUsd, 0);
});

test("approval_phrase_missing when onApproval is set but phrase is absent", async () => {
  let called = false;
  const guard = new SpendGuard(
    {
      trustPolicy: "custom",
      onApproval: async () => {
        called = true;
        return true;
      },
    },
    mustNotFetch,
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.equal(called, false);
  assert.equal(decision.spendRulesRefusedBy, null);
  assert.deepEqual(decision.reasons, ["approval_phrase_missing"]);
});
