// Unit tests for the SpendGuard decision logic (node:test, no framework
// dependency — run with `npm test` after `npm run build`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { SpendGuard, VouchApiError } from "../dist/index.js";

const PAYEE = "0x1111111111111111111111111111111111111111";

function payeeScore(overrides = {}) {
  return {
    payee: PAYEE,
    score: 80,
    recommendation: "ALLOW",
    dataDepth: "moderate",
    degraded: false,
    signalsUnavailable: [],
    signals: {
      receiving: { paymentCount: 5, uniqueDays: 3, distinctPayers: 2, score: 68 },
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
    ...overrides,
  };
}

const scoreFetcher = (overrides) => async () => payeeScore(overrides);
const failingFetcher = async () => {
  throw new Error("scoring_unavailable");
};
const mustNotFetch = async () => {
  throw new Error("unexpected_trust_lookup");
};

test("allows a payment within all limits", async () => {
  const guard = new SpendGuard(
    { maxPerTxUsd: 10, dailyBudgetUsd: 50, minPayeeScore: 40 },
    scoreFetcher(),
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 5 });
  assert.equal(decision.allow, true);
  assert.deepEqual(decision.reasons, []);
  assert.equal(decision.spentTodayUsd, 5);
  assert.equal(decision.remainingDailyBudgetUsd, 45);
  assert.equal(decision.payeeScore.score, 80);
});

test("denies above the per-tx cap without burning a trust lookup", async () => {
  const guard = new SpendGuard(
    { maxPerTxUsd: 10, minPayeeScore: 40 },
    mustNotFetch,
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 11 });
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["max_per_tx_exceeded"]);
  assert.equal(decision.payeeScore, null);
  assert.equal(decision.spentTodayUsd, 0); // denied payments reserve nothing
});

test("denies once the daily budget would be exceeded, then releases", async () => {
  const guard = new SpendGuard({ dailyBudgetUsd: 10, trustPolicy: "custom" }, mustNotFetch);

  const first = await guard.evaluate({ payee: PAYEE, amountUsd: 6 });
  assert.equal(first.allow, true);

  const second = await guard.evaluate({ payee: PAYEE, amountUsd: 6 });
  assert.equal(second.allow, false);
  assert.deepEqual(second.reasons, ["daily_budget_exceeded"]);
  assert.equal(second.remainingDailyBudgetUsd, 4);

  guard.release(6); // first payment did not execute
  const third = await guard.evaluate({ payee: PAYEE, amountUsd: 6 });
  assert.equal(third.allow, true);
});

test("exact budget consumption is allowed (boundary)", async () => {
  const guard = new SpendGuard({ dailyBudgetUsd: 10, trustPolicy: "custom" }, mustNotFetch);
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 10 });
  assert.equal(decision.allow, true);
  assert.equal(decision.remainingDailyBudgetUsd, 0);
});

test("denies on payee score below minPayeeScore", async () => {
  const guard = new SpendGuard({ minPayeeScore: 40 }, scoreFetcher({ score: 25 }));
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_score_below_min"]);
  assert.equal(decision.payeeScore.score, 25);
});

test("denies on BLOCK recommendation when blockOnRecommendation is set (custom)", async () => {
  const guard = new SpendGuard(
    { trustPolicy: "custom", blockOnRecommendation: true },
    scoreFetcher({ score: 70, recommendation: "BLOCK" }),
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_recommendation_block"]);
});

// ---- fail-closed default (0.2.0): ALLOW-only unless explicitly opted out --

test("default policy denies a WARN recommendation", async () => {
  const guard = new SpendGuard({}, scoreFetcher({ score: 55, recommendation: "WARN" }));
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_recommendation_not_allow"]);
});

test("default policy denies a BLOCK recommendation", async () => {
  const guard = new SpendGuard({}, scoreFetcher({ score: 70, recommendation: "BLOCK" }));
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_recommendation_not_allow"]);
});

test("default policy denies a degraded score", async () => {
  const guard = new SpendGuard(
    {},
    scoreFetcher({ score: 10, recommendation: "BLOCK", degraded: true }),
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_score_degraded"]);
});

test("default policy denies a partial measurement (signalsUnavailable non-empty)", async () => {
  const guard = new SpendGuard(
    {},
    scoreFetcher({
      score: 55,
      recommendation: "WARN",
      degraded: false,
      signalsUnavailable: ["drain_erc20"],
    }),
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_partial_measurement"]);
});

test("explicit opt-out lets a WARN through (block-only) and a lookup be skipped (custom)", async () => {
  const blockOnly = new SpendGuard(
    { trustPolicy: "block-only" },
    scoreFetcher({ score: 55, recommendation: "WARN" }),
  );
  const warned = await blockOnly.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.equal(warned.allow, true);
  assert.deepEqual(warned.reasons, []);

  // "custom" with no trust rule set: pre-0.2.0 behaviour, no lookup at all.
  const custom = new SpendGuard({ trustPolicy: "custom", maxPerTxUsd: 10 }, mustNotFetch);
  const local = await custom.evaluate({ payee: PAYEE, amountUsd: 5 });
  assert.equal(local.allow, true);
  assert.equal(local.payeeScore, null);
});

test("block-only still denies BLOCK and degraded", async () => {
  const guard = new SpendGuard(
    { trustPolicy: "block-only" },
    scoreFetcher({ score: 20, recommendation: "BLOCK" }),
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_recommendation_block"]);

  const degradedGuard = new SpendGuard(
    { trustPolicy: "block-only" },
    scoreFetcher({ score: 10, recommendation: "BLOCK", degraded: true }),
  );
  const denied = await degradedGuard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.equal(denied.allow, false);
  assert.deepEqual(denied.reasons, ["payee_score_degraded"]);
});

test("fails closed when the trust lookup errors", async () => {
  const guard = new SpendGuard({ minPayeeScore: 40 }, failingFetcher);
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_trust_unavailable"]);
});

// 2026-08-13 (hackathon persona R2): "no API key" and "Vouch is down" both
// came back as payee_trust_unavailable, so an integrator who had simply not
// exported VOUCH_API_KEY went hunting for our outage. The raw API was already
// answering `missing_api_key` (401) — the guard was swallowing it. These pin
// the split by HTTP status first, by error code/message as the fallback.
test("a missing API key denies as unauthenticated, not unavailable", async () => {
  const guard = new SpendGuard({}, async () => {
    throw new VouchApiError("missing_api_key", 401);
  });
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_trust_unauthenticated"]);
});

test("an invalid API key denies as unauthenticated", async () => {
  const guard = new SpendGuard({}, async () => {
    throw new VouchApiError("invalid_api_key", 401);
  });
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.deepEqual(decision.reasons, ["payee_trust_unauthenticated"]);
});

test("a 403 denies as unauthenticated", async () => {
  const guard = new SpendGuard({}, async () => {
    throw new VouchApiError("forbidden", 403);
  });
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.deepEqual(decision.reasons, ["payee_trust_unauthenticated"]);
});

test("an upstream 5xx stays payee_trust_unavailable", async () => {
  const guard = new SpendGuard({}, async () => {
    throw new VouchApiError("scoring_unavailable", 503);
  });
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.deepEqual(decision.reasons, ["payee_trust_unavailable"]);
});

test("a rate limit stays payee_trust_unavailable (retryable, not a key problem)", async () => {
  const guard = new SpendGuard({}, async () => {
    throw new VouchApiError("rate_limit_exceeded", 429);
  });
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.deepEqual(decision.reasons, ["payee_trust_unavailable"]);
});

test("a bare network error (no status) stays payee_trust_unavailable", async () => {
  const guard = new SpendGuard({}, async () => {
    throw new TypeError("fetch failed");
  });
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.deepEqual(decision.reasons, ["payee_trust_unavailable"]);
});

test("an injected fetcher without a status is classified by message", async () => {
  const guard = new SpendGuard({}, async () => {
    throw new Error("missing_api_key");
  });
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 1 });
  assert.deepEqual(decision.reasons, ["payee_trust_unauthenticated"]);
});

test("an unauthenticated lookup returns the optimistic budget reservation", async () => {
  const guard = new SpendGuard({ dailyBudgetUsd: 50 }, async () => {
    throw new VouchApiError("missing_api_key", 401);
  });
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 20 });
  assert.equal(decision.allow, false);
  assert.equal(guard.state().spentTodayUsd, 0);
});

test("default policy requires the lookup even with no explicit trust rule", async () => {
  const guard = new SpendGuard({ maxPerTxUsd: 10 }, failingFetcher);
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 5 });
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["payee_trust_unavailable"]);
});

test("resets the budget counter when the UTC day rolls over", async () => {
  let now = new Date("2026-07-15T23:50:00Z");
  const guard = new SpendGuard(
    { dailyBudgetUsd: 10, trustPolicy: "custom" },
    mustNotFetch,
    () => now,
  );

  const first = await guard.evaluate({ payee: PAYEE, amountUsd: 8 });
  assert.equal(first.allow, true);

  const sameDay = await guard.evaluate({ payee: PAYEE, amountUsd: 8 });
  assert.equal(sameDay.allow, false);

  now = new Date("2026-07-16T00:10:00Z");
  const nextDay = await guard.evaluate({ payee: PAYEE, amountUsd: 8 });
  assert.equal(nextDay.allow, true);
  assert.equal(guard.state().day, "2026-07-16");
  assert.equal(guard.state().spentTodayUsd, 8);
});

test("collects multiple deny reasons from local rules", async () => {
  const guard = new SpendGuard(
    { maxPerTxUsd: 5, dailyBudgetUsd: 8 },
    mustNotFetch,
  );
  const decision = await guard.evaluate({ payee: PAYEE, amountUsd: 9 });
  assert.equal(decision.allow, false);
  assert.deepEqual(decision.reasons, ["max_per_tx_exceeded", "daily_budget_exceeded"]);
});

test("rejects invalid inputs and policies", async () => {
  const guard = new SpendGuard({}, mustNotFetch);
  await assert.rejects(() => guard.evaluate({ payee: "not-an-address", amountUsd: 1 }), {
    message: "invalid_payee_address",
  });
  await assert.rejects(() => guard.evaluate({ payee: PAYEE, amountUsd: 0 }), {
    message: "invalid_amount_usd",
  });
  await assert.rejects(() => guard.evaluate({ payee: PAYEE, amountUsd: NaN }), {
    message: "invalid_amount_usd",
  });
  assert.throws(() => new SpendGuard({ maxPerTxUsd: -1 }, mustNotFetch), {
    message: "invalid_policy_maxPerTxUsd",
  });
  assert.throws(() => new SpendGuard({ minPayeeScore: 101 }, mustNotFetch), {
    message: "invalid_policy_minPayeeScore",
  });
  assert.throws(() => new SpendGuard({ trustPolicy: "lenient" }, mustNotFetch), {
    message: "invalid_policy_trustPolicy",
  });
});

test("concurrent evaluates cannot jointly overshoot the daily budget (TOCTOU)", async () => {
  // Both trust lookups are held in flight simultaneously; without the
  // optimistic reservation, both calls would read spentTodayUsd=0 while
  // awaiting and both would slip past the $10 budget.
  let releaseLookups;
  const gate = new Promise((resolve) => {
    releaseLookups = resolve;
  });
  const guard = new SpendGuard({ dailyBudgetUsd: 10, minPayeeScore: 40 }, async () => {
    await gate;
    return payeeScore();
  });

  const inFlight = Promise.all([
    guard.evaluate({ payee: PAYEE, amountUsd: 6 }),
    guard.evaluate({ payee: PAYEE, amountUsd: 6 }),
  ]);
  releaseLookups();
  const [first, second] = await inFlight;

  const allowed = [first, second].filter((d) => d.allow);
  const denied = [first, second].filter((d) => !d.allow);
  assert.equal(allowed.length, 1);
  assert.equal(denied.length, 1);
  assert.deepEqual(denied[0].reasons, ["daily_budget_exceeded"]);
  assert.equal(guard.state().spentTodayUsd, 6);
});

test("trust-rule deny returns the optimistic reservation", async () => {
  const guard = new SpendGuard(
    { dailyBudgetUsd: 10, minPayeeScore: 40 },
    scoreFetcher({ score: 25 }),
  );
  const denied = await guard.evaluate({ payee: PAYEE, amountUsd: 6 });
  assert.equal(denied.allow, false);
  assert.deepEqual(denied.reasons, ["payee_score_below_min"]);
  assert.equal(guard.state().spentTodayUsd, 0); // reservation given back

  // The full budget is still available for a trustworthy payee afterwards.
  const guard2 = new SpendGuard(
    { dailyBudgetUsd: 10, minPayeeScore: 40 },
    scoreFetcher(),
  );
  const first = await guard2.evaluate({ payee: PAYEE, amountUsd: 6 });
  const second = await guard2.evaluate({ payee: PAYEE, amountUsd: 4 });
  assert.equal(first.allow, true);
  assert.equal(second.allow, true);
});

test("release clamps at zero and never goes negative", async () => {
  const guard = new SpendGuard({ dailyBudgetUsd: 10, trustPolicy: "custom" }, mustNotFetch);
  await guard.evaluate({ payee: PAYEE, amountUsd: 3 });
  guard.release(100);
  assert.equal(guard.state().spentTodayUsd, 0);
});

// ============================================================
// H-2 (2026-08-13 R4) — score freshness. SpendGuard never checked scoredAt /
// cacheExpiresAt, so an integrator whose injected fetcher returned a cached
// (stale) score could keep clearing large payments against a verdict the
// world had already moved past. Fail-closed on staleness, default on.
// ============================================================

const FIXED_NOW = new Date("2026-08-13T12:00:00Z");
// A fetcher that stamps the score's scoredAt/cacheExpiresAt at a chosen age.
const agedFetcher = (ageMs, ttlMs = 300000, overrides = {}) => async () =>
  payeeScore({
    scoredAt: new Date(FIXED_NOW.getTime() - ageMs).toISOString(),
    cacheExpiresAt: new Date(FIXED_NOW.getTime() - ageMs + ttlMs).toISOString(),
    ...overrides,
  });

test("H-2: a fresh score within the default max age is allowed", async () => {
  const guard = new SpendGuard({ maxPerTxUsd: 10 }, agedFetcher(60_000), () => FIXED_NOW);
  const d = await guard.evaluate({ payee: PAYEE, amountUsd: 5 });
  assert.equal(d.allow, true);
  assert.deepEqual(d.reasons, []);
});

test("H-2: a score older than the default max age is denied as stale", async () => {
  // 10 minutes old, default bound is 5 minutes.
  const guard = new SpendGuard({ maxPerTxUsd: 10 }, agedFetcher(600_000), () => FIXED_NOW);
  const d = await guard.evaluate({ payee: PAYEE, amountUsd: 5 });
  assert.equal(d.allow, false);
  assert.deepEqual(d.reasons, ["payee_score_stale"]);
  assert.equal(guard.state().spentTodayUsd, 0); // optimistic reservation returned
});

test("H-2: an explicit stricter maxScoreAgeMs denies a score the default would pass", async () => {
  const guard = new SpendGuard(
    { maxPerTxUsd: 10, maxScoreAgeMs: 30_000 },
    agedFetcher(60_000),
    () => FIXED_NOW,
  );
  const d = await guard.evaluate({ payee: PAYEE, amountUsd: 5 });
  assert.equal(d.allow, false);
  assert.deepEqual(d.reasons, ["payee_score_stale"]);
});

test("H-2: a score past its own cacheExpiresAt is stale even under a lax maxScoreAgeMs", async () => {
  // Age 6min, TTL 5min → already expired by its own contract; maxScoreAgeMs
  // set generously to 1h must not override the score's declared expiry.
  const guard = new SpendGuard(
    { maxPerTxUsd: 10, maxScoreAgeMs: 3_600_000 },
    agedFetcher(360_000, 300_000),
    () => FIXED_NOW,
  );
  const d = await guard.evaluate({ payee: PAYEE, amountUsd: 5 });
  assert.equal(d.allow, false);
  assert.deepEqual(d.reasons, ["payee_score_stale"]);
});

test("H-2: block-only also denies a stale score", async () => {
  const guard = new SpendGuard(
    { maxPerTxUsd: 10, trustPolicy: "block-only" },
    agedFetcher(600_000),
    () => FIXED_NOW,
  );
  const d = await guard.evaluate({ payee: PAYEE, amountUsd: 5 });
  assert.equal(d.allow, false);
  assert.deepEqual(d.reasons, ["payee_score_stale"]);
});

test("H-2: custom policy keeps pre-0.2.0 behaviour — freshness not enforced", async () => {
  // custom + a stale score, but the explicit rule (minPayeeScore) still passes.
  const guard = new SpendGuard(
    { maxPerTxUsd: 10, trustPolicy: "custom", minPayeeScore: 40 },
    agedFetcher(3_600_000),
    () => FIXED_NOW,
  );
  const d = await guard.evaluate({ payee: PAYEE, amountUsd: 5 });
  assert.equal(d.allow, true);
  assert.deepEqual(d.reasons, []);
});

test("H-2: an unparseable scoredAt is treated as stale (fail-closed)", async () => {
  const guard = new SpendGuard(
    { maxPerTxUsd: 10 },
    async () => payeeScore({ scoredAt: "not-a-date" }),
    () => FIXED_NOW,
  );
  const d = await guard.evaluate({ payee: PAYEE, amountUsd: 5 });
  assert.equal(d.allow, false);
  assert.deepEqual(d.reasons, ["payee_score_stale"]);
});

test("H-2: maxScoreAgeMs must be a positive number", () => {
  assert.throws(() => new SpendGuard({ maxScoreAgeMs: 0 }, mustNotFetch), {
    message: "invalid_policy_maxScoreAgeMs",
  });
  assert.throws(() => new SpendGuard({ maxScoreAgeMs: -1 }, mustNotFetch), {
    message: "invalid_policy_maxScoreAgeMs",
  });
});

// 2026-10-16: the day's total is counted in integer micro-dollars. With dollar floats,
// 99 payments of 0.01 summed to 0.99000000000000007 and a 1.00 budget refused the 100th.
test("a 1.00 daily budget allows exactly 100 payments of 0.01 and refuses the 101st", async () => {
  const guard = new SpendGuard(
    { dailyBudgetUsd: 1, trustPolicy: "custom" },
    async () => { throw new Error("no lookup expected"); },
    () => new Date("2026-10-16T00:00:00Z"),
  );
  const payee = "0x" + "1".repeat(40);
  for (let i = 1; i <= 100; i++) {
    const d = await guard.evaluate({ payee, amountUsd: 0.01 });
    assert.equal(d.allow, true, `payment ${i} should be allowed`);
  }
  const over = await guard.evaluate({ payee, amountUsd: 0.01 });
  assert.equal(over.allow, false);
  assert.deepEqual(over.reasons, ["daily_budget_exceeded"]);
  assert.equal(guard.state().spentTodayUsd, 1);
});

test("micro-dollar counting: 0.1 + 0.2 fits a 0.3 budget, a dust payment still counts, release gives back exactly", async () => {
  const payee = "0x" + "2".repeat(40);
  const g = new SpendGuard(
    { dailyBudgetUsd: 0.3, maxPerTxUsd: 0.2, trustPolicy: "custom" },
    async () => { throw new Error("no lookup expected"); },
    () => new Date("2026-10-16T00:00:00Z"),
  );
  assert.equal((await g.evaluate({ payee, amountUsd: 0.1 })).allow, true);
  assert.equal((await g.evaluate({ payee, amountUsd: 0.2 })).allow, true);
  const dust = await g.evaluate({ payee, amountUsd: 0.0000001 });
  assert.equal(dust.allow, false, "a positive amount below one micro-dollar still counts as one");
  assert.deepEqual(dust.reasons, ["daily_budget_exceeded"]);
  g.release(0.2);
  assert.equal(g.state().spentTodayUsd, 0.1);
  const d = await g.evaluate({ payee, amountUsd: 0.2 });
  assert.equal(d.allow, true);
  assert.equal(d.remainingDailyBudgetUsd, 0);
  assert.equal((await g.evaluate({ payee, amountUsd: 0.200001 })).reasons.includes("max_per_tx_exceeded"), true);
});

test("values finer than a micro-dollar only make the guard stricter (amounts round up, limits round down)", async () => {
  const payee = "0x" + "3".repeat(40);
  const mk = (policy) => new SpendGuard({ ...policy, trustPolicy: "custom" }, async () => { throw new Error("no lookup expected"); }, () => new Date("2026-10-16T00:00:00Z"));
  assert.equal((await mk({ maxPerTxUsd: 0.01 }).evaluate({ payee, amountUsd: 0.0100004 })).allow, false);
  assert.equal((await mk({ dailyBudgetUsd: 1 }).evaluate({ payee, amountUsd: 1.0000004 })).allow, false);
  assert.equal((await mk({ maxPerTxUsd: 0.0000006 }).evaluate({ payee, amountUsd: 0.0000014 })).allow, false);
  const g = mk({ dailyBudgetUsd: 0.0001 });
  let n = 0;
  while ((await g.evaluate({ payee, amountUsd: 0.0000014 })).allow) n++;
  assert.equal(n, 50, "1.4e-6 counts as 2 micro-dollars, so 50 fit in 100");
});

test("large exact amounts are not refused by float noise (66367.290827 at a limit of the same value)", async () => {
  const payee = "0x" + "4".repeat(40);
  const v = 66367.290827;
  const g = new SpendGuard({ maxPerTxUsd: v, dailyBudgetUsd: v, trustPolicy: "custom" }, async () => { throw new Error("no lookup expected"); }, () => new Date("2026-10-16T00:00:00Z"));
  const d = await g.evaluate({ payee, amountUsd: v });
  assert.equal(d.allow, true, JSON.stringify(d.reasons));
});
