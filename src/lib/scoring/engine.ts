import { type Address } from "viem";
import { readCanonicalAgentWallet } from "@/lib/chain/agent-wallet";
import { resolveAgentIdByWallet } from "@/lib/chain/agent-resolver";
import { CACHE_TTL_MS } from "@/lib/chain/config";
import { lookupManualListPolicy, type ManualListPolicy } from "@/lib/db/customer-lists";
import {
  fetchAgentIdentity,
  fetchRecentFeedbackStats,
  fetchReputationSummary,
} from "@/lib/chain/erc8004";
import { fetchWalletMetrics, invalidateWalletMetricsCache } from "@/lib/chain/wallet-metrics";
import { isValidAddress } from "@/lib/chain/client";
import { LruCache } from "@/lib/util/lru-cache";
import { getCacheEpoch } from "./cache-epoch";
import {
  applyManualList,
  applySybilPenalty,
  buildScoreBreakdown,
  capForVerifiableEvidence,
  computeWeightedScore,
  dampenReputationForSybil,
  normalizeWalletScore,
  scoreEconomicActivity,
  scoreIdentity,
  scoreReputation,
  walletsMatch,
} from "./helpers";
import { detectReputationSybilFlags, detectSybilFlags } from "./sybil";
import {
  assessSybilRisk,
  hasUnavailableInput,
  reasonCodes,
  resolveRecommendation,
} from "./verdict";
import type { AgentIdentity } from "@/lib/chain/erc8004";
import { getX402PaymentStats } from "@/lib/db/x402-payments";
import { getObservedPurchaseStats } from "@/lib/db/observed-purchases";
import { getDataCoverage } from "@/lib/health/data-coverage";
import type { ScoreRequestContext, TrustScoreResult, TrustSignals } from "./types";
import { createDeadline, withDeadline } from "@/lib/util/deadline";

const CACHE_MAX_ENTRIES = 10_000;

/**
 * Wall-clock budget for one score, and the per-signal allowances inside it.
 *
 * WHY (2026-08-12 outage). Every optional signal below is wrapped in
 * try/catch so an unavailable upstream degrades to an `*_unavailable` flag —
 * "fail-closed, not fail-wrong", exactly as the API docs promise. But
 * try/catch only fires on a REJECTION. A merely SLOW dependency was invisible
 * to it: the 7-day feedback scan took ~30s, so the designed degradation never
 * ran and the caller's 8s race fired instead — /api/demo/score and /agent/[id]
 * both returned "unavailable" by timeout rather than by fallback.
 *
 * SCORE_BUDGET_MS sits under both callers' 8s races so the engine degrades
 * itself, honestly and with reasons attached, before anyone times it out.
 * Per-signal allowances draw from that shared budget, so a SEQUENCE of slow
 * steps still cannot exceed the total.
 *
 * These bound the WAIT, never the STRICTNESS: a signal that misses its budget
 * becomes `*_unavailable`, which the sybil layer penalizes. Nothing here can
 * make a verdict more permissive.
 */
const SCORE_BUDGET_MS = 6_000;
const IDENTITY_BUDGET_MS = 3_000;
const SIGNAL_BUDGET_MS = 3_500;
const SYBIL_BUDGET_MS = 2_000;

/**
 * A degraded signal is an operational fact worth seeing in logs — the
 * 2026-08-12 outage was invisible for days precisely because the engine
 * swallowed the reason and the health endpoint still said "ok".
 */
function logSignalDegraded(signal: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`[vouch] score_signal_degraded: ${signal}: ${message.slice(0, 200)}`);
}

/** Chain-derived score payload — policy layer is always applied fresh on read. */
type CachedChainPayload = {
  agentId: bigint;
  wallet: string | null;
  prePolicyScore: number;
  // N-21: the four component scores exactly as fed into computeWeightedScore,
  // cached alongside the score so /score can explain a cache hit without
  // re-deriving them. The reputation value is the post-dampen one that was
  // actually weighted (see scoreAgentById), not the raw scoreReputation output.
  components: { identity: number; reputation: number; wallet: number; x402: number };
  chainSignals: Omit<TrustSignals, "manual">;
  epoch: number;
  expiresAt: number;
};

const memoryCache = new LruCache<string, CachedChainPayload>(CACHE_MAX_ENTRIES);

export function invalidateScoreCache(wallet?: string, agentId?: string): void {
  if (!wallet && !agentId) {
    memoryCache.clear();
    return;
  }

  const walletLower = wallet?.toLowerCase();
  const agentPrefix = agentId ? `agent:${agentId}:` : null;

  for (const key of memoryCache.keys()) {
    const keyLower = key.toLowerCase();
    const walletMatch = walletLower
      ? keyLower.includes(`:${walletLower}:`) ||
        keyLower.endsWith(`:${walletLower}`) ||
        keyLower.startsWith(`wallet:${walletLower}:`)
      : false;
    const agentMatch = agentPrefix ? key.startsWith(agentPrefix) : false;
    if (walletMatch || agentMatch) {
      memoryCache.delete(key);
    }
  }

  if (wallet) {
    invalidateWalletMetricsCache(wallet);
  }
}

function buildAgentCacheKey(
  agentId: bigint,
  canonicalWallet: string | null,
  ctx: ScoreRequestContext,
): string {
  const walletSegment = canonicalWallet?.toLowerCase() ?? "";
  const verifyWalletSegment = ctx.verifyWallet?.toLowerCase() ?? "";
  // chainId is part of the identity of a score: the same agent id on two
  // chains is two different registrations, and a cache hit across chains
  // would present one chain's history as the other's.
  return `agent:${ctx.chainId ?? 8453}:${agentId.toString()}:${walletSegment}:${verifyWalletSegment}:${ctx.apiKeyId ?? ""}`;
}

export async function scoreAgentById(
  agentId: bigint,
  ctx: ScoreRequestContext = {},
): Promise<TrustScoreResult> {
  const deadline = createDeadline(SCORE_BUDGET_MS);

  const identity = await withDeadline(
    fetchAgentIdentity(agentId, ctx.chainId),
    deadline.budgetFor(IDENTITY_BUDGET_MS),
    "agent_identity",
  );
  const verificationBlock = await verifyWalletBinding(agentId, identity, ctx.verifyWallet);
  if (verificationBlock) {
    return verificationBlock;
  }

  const walletAddress = resolveWalletAddress(ctx.verifyWallet, identity.agentWallet);
  const cacheKey = buildAgentCacheKey(agentId, walletAddress, ctx);
  const cached = memoryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    const currentEpoch = await getCacheEpoch(walletAddress);
    if (cached.epoch >= currentEpoch) {
      return applyPolicyLayer(cached, ctx);
    }
    memoryCache.delete(cacheKey);
  }

  // These four reads are independent of one another — only `identity` (above)
  // gates them. They used to run strictly one after another, so their latencies
  // ADDED UP inside a single request; the 7-day feedback scan alone spent ~30s
  // there. Running them together means the request waits for the slowest, not
  // for the sum, which is what makes a real per-signal budget affordable.
  // Each still degrades independently to its own `*_unavailable` flag.
  const signalBudget = deadline.budgetFor(SIGNAL_BUDGET_MS);

  const settled = await Promise.all([
    withDeadline(fetchReputationSummary(agentId, ctx.chainId), signalBudget, "reputation_summary")
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error })),

    withDeadline(
      fetchRecentFeedbackStats(agentId, 7, ctx.chainId),
      signalBudget,
      "feedback_stats",
    )
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error })),

    walletAddress
      ? withDeadline(
          fetchWalletMetrics(walletAddress as Address, ctx.chainId),
          signalBudget,
          "wallet_metrics",
        )
          .then((value) => ({ ok: true as const, value }))
          .catch((error: unknown) => ({ ok: false as const, error }))
      : Promise.resolve({ ok: true as const, value: null }),

    walletAddress
      ? withDeadline(getX402PaymentStats(walletAddress), signalBudget, "x402_stats")
          .then((value) => ({ ok: true as const, value }))
          .catch((error: unknown) => ({ ok: false as const, error }))
      : Promise.resolve({
          ok: true as const,
          value: {
            paymentCount: 0,
            uniqueDays: 0,
            lastPaymentAt: null,
            paymentsWithUnprovableIndependence: 0,
          },
        }),

    // vet402 2026-08-14 — L1 observed purchases, the PREMIUM economic-activity
    // signal. Degrades to "none" like the others; a read failure here can only
    // lower the axis to its x402/floor value, never raise it, so it is not
    // flagged as a fail-closed input — the strongest thing a missing L1 read can
    // do is withhold a promotion, which is the safe direction.
    walletAddress
      ? withDeadline(getObservedPurchaseStats(walletAddress), signalBudget, "l1_stats")
          .then((value) => ({ ok: true as const, value }))
          .catch((error: unknown) => ({ ok: false as const, error }))
      : Promise.resolve({
          ok: true as const,
          value: { purchaseCount: 0, uniqueDays: 0, distinctCounterparties: 0 },
        }),
  ] as const);

  const [reputationResult, feedbackResult, walletResult, x402Result, l1Result] = settled;

  const reputationUnavailable = !reputationResult.ok;
  const reputation = reputationResult.ok
    ? reputationResult.value
    : { count: 0, summaryValue: 0, summaryValueDecimals: 0 };
  if (!reputationResult.ok) logSignalDegraded("reputation_summary", reputationResult.error);

  const feedbackStatsUnavailable = !feedbackResult.ok;
  const feedbackStats = feedbackResult.ok
    ? feedbackResult.value
    : { recentCount: 0, uniqueClients: 0, windowDays: 7 };
  if (!feedbackResult.ok) logSignalDegraded("feedback_stats", feedbackResult.error);

  const walletMetricsUnavailable = !walletResult.ok;
  let walletMetrics: Awaited<ReturnType<typeof fetchWalletMetrics>> | null = walletResult.ok
    ? walletResult.value
    : null;
  if (!walletResult.ok) {
    logSignalDegraded("wallet_metrics", walletResult.error);
    walletMetrics = {
      address: walletAddress as Address,
      ageDays: 0,
      txCount: 0,
      funder: null,
      firstTxTimestamp: null,
    };
  }

  const walletScore = normalizeWalletScore({
    ageDays: walletMetrics?.ageDays ?? 0,
    txCount: walletMetrics?.txCount ?? 0,
  });

  const x402StatsUnavailable = !x402Result.ok;
  const x402Stats: Awaited<ReturnType<typeof getX402PaymentStats>> = x402Result.ok
    ? x402Result.value
    : { paymentCount: 0, uniqueDays: 0, lastPaymentAt: null, paymentsWithUnprovableIndependence: 0 };
  if (!x402Result.ok) logSignalDegraded("x402_stats", x402Result.error);

  const l1Stats: Awaited<ReturnType<typeof getObservedPurchaseStats>> = l1Result.ok
    ? l1Result.value
    : { purchaseCount: 0, uniqueDays: 0, distinctCounterparties: 0 };
  if (!l1Result.ok) logSignalDegraded("l1_stats", l1Result.error);

  // The highest-weighted axis: verifiable economic activity (L1 observed
  // purchases first, x402 settlements as the interim proxy). scoreEconomicActivity
  // takes the strongest available; absent both it returns the 30 floor that keeps
  // registration-only/self-attested/self-dealing-only capped at WARN.
  const x402Score = scoreEconomicActivity({ l1: l1Stats, x402: x402Stats });

  const identityScore = scoreIdentity(identity.registered, Boolean(identity.tokenUri));
  const onChainAvg =
    reputation.count > 0
      ? reputation.summaryValue / 10 ** reputation.summaryValueDecimals
      : 0;

  let reputationScore = scoreReputation(
    reputation.count,
    reputation.summaryValue,
    reputation.summaryValueDecimals,
  );

  // The sybil checks read the owner/funder indexes (DB). A hang here used to
  // be unbounded too; it now degrades to `sybil_checks_unavailable`, which
  // assessSybilRisk treats as high risk → BLOCK. "We could not check" must
  // never surface as "we checked and it was fine".
  let sybilFlags: string[];
  try {
    sybilFlags = await withDeadline(
      walletMetrics !== null
        ? detectSybilFlags({
            identity,
            walletMetrics,
            feedbackStats,
            totalFeedbackCount: reputation.count,
          })
        : detectReputationSybilFlags({
            identity,
            feedbackStats,
            totalFeedbackCount: reputation.count,
          }),
      deadline.budgetFor(SYBIL_BUDGET_MS),
      "sybil_checks",
    );
  } catch (error) {
    logSignalDegraded("sybil_checks", error);
    sybilFlags = ["sybil_checks_unavailable"];
  }

  if (feedbackStatsUnavailable) {
    sybilFlags.push("feedback_stats_unavailable");
  }
  if (reputationUnavailable) {
    sybilFlags.push("reputation_summary_unavailable");
  }
  if (walletMetricsUnavailable) {
    sybilFlags.push("wallet_metrics_unavailable");
  }
  if (x402StatsUnavailable) {
    sybilFlags.push("x402_unavailable");
  }

  const sybilRisk = assessSybilRisk(sybilFlags);
  reputationScore = dampenReputationForSybil(reputationScore, sybilFlags);

  // vet402 2026-08-13: self-attestation (ERC-8004 registration + an unbacked
  // reputation summary) must not clear ALLOW on its own. Cap the weighted+
  // penalized score at WARN unless there is verifiable on-chain evidence — a
  // signed USDC settlement, feedback from ≥3 distinct clients, or an
  // established wallet. Applied to the pre-policy score so the breakdown, the
  // cache and the recommendation all see the same capped number; a customer
  // whitelist can still lift WARN→ALLOW downstream as the operator's own call.
  const prePolicyScore = capForVerifiableEvidence(
    applySybilPenalty(
      computeWeightedScore(identityScore, reputationScore, walletScore.score, x402Score),
      sybilFlags,
    ),
    {
      x402PaymentCount: x402Stats.paymentCount,
      l1PurchaseCount: l1Stats.purchaseCount,
      uniqueFeedbackClients: feedbackStats.uniqueClients,
      walletTxCount: walletMetrics?.txCount ?? 0,
      walletAgeDays: walletMetrics?.ageDays ?? 0,
    },
  );

  const chainSignals: Omit<TrustSignals, "manual"> = {
    identity: {
      registered: identity.registered,
      hasMetadataUri: Boolean(identity.tokenUri),
    },
    reputation: {
      feedbackCount: reputation.count,
      avgScore: reputationScore,
      onChainAvgScore: Math.round(onChainAvg * 100) / 100,
    },
    wallet: {
      ageDays: walletMetrics?.ageDays ?? 0,
      txCount: walletMetrics?.txCount ?? 0,
      isBurner: walletScore.isBurner,
    },
    x402: {
      paymentCount: x402Stats.paymentCount,
      uniqueDays: x402Stats.uniqueDays,
      score: x402Score,
      l1PurchaseCount: l1Stats.purchaseCount,
      l1DistinctSellers: l1Stats.distinctCounterparties,
    },
    sybil: {
      risk: sybilRisk,
      flags: sybilFlags,
    },
  };

  const now = Date.now();
  const epoch = await getCacheEpoch(walletAddress);

  const payload: CachedChainPayload = {
    agentId,
    wallet: walletAddress,
    prePolicyScore,
    // reputationScore here is the dampened value that was actually weighted.
    components: {
      identity: identityScore,
      reputation: reputationScore,
      wallet: walletScore.score,
      x402: x402Score,
    },
    chainSignals,
    epoch,
    expiresAt: now + CACHE_TTL_MS,
  };

  if (!hasUnavailableInput(sybilFlags)) {
    memoryCache.set(cacheKey, payload);
  }
  return applyPolicyLayer(payload, ctx);
}

export async function scoreWallet(
  address: string,
  ctx: ScoreRequestContext = {},
): Promise<TrustScoreResult> {
  if (!isValidAddress(address)) {
    throw new Error("invalid_wallet_address");
  }

  const wallet = address as Address;

  // 2026-08-22 audit: everything below used to run with NO shared budget and
  // with detectSybilFlags outside any try/catch — while scoreAgentById (line
  // ~140) has had both since the 2026-08-12 outage (see the SCORE_BUDGET_MS
  // block at the top of this file for why). The asymmetry mattered more than
  // it looks: middleware's default scoreSource is "wallet", so THIS is the
  // path most callers take, and with the DB down the agent path answered
  // "BLOCK, sybil_checks_unavailable" while this one threw a 500. Same
  // dependency, same failure, two different contracts. Now one.
  //
  // Kept sequential rather than Promise.all'd like the agent path: the sybil
  // check needs walletMetrics, and budgetFor() already takes the smaller of a
  // step's allowance and what is left overall, so the SEQUENCE cannot exceed
  // the total either way.
  const deadline = createDeadline(SCORE_BUDGET_MS);

  const resolvedAgentId = await withDeadline(
    resolveAgentIdByWallet(wallet),
    deadline.budgetFor(IDENTITY_BUDGET_MS),
    "agent_resolve",
  );

  if (resolvedAgentId !== null) {
    // The agent path opens its own budget — deliberately, so a delegated score
    // is not squeezed by whatever this lookup already spent.
    return scoreAgentById(resolvedAgentId, { ...ctx, verifyWallet: address });
  }

  const cacheKey = `wallet:${address.toLowerCase()}:${ctx.apiKeyId ?? ""}`;
  const cached = memoryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    const currentEpoch = await getCacheEpoch(address);
    if (cached.epoch >= currentEpoch) {
      return applyPolicyLayer(cached, ctx);
    }
    memoryCache.delete(cacheKey);
  }

  let walletMetrics: Awaited<ReturnType<typeof fetchWalletMetrics>>;
  let walletMetricsUnavailable = false;
  try {
    walletMetrics = await withDeadline(
      fetchWalletMetrics(wallet),
      deadline.budgetFor(SIGNAL_BUDGET_MS),
      "wallet_metrics",
    );
  } catch (error) {
    logSignalDegraded("wallet_metrics", error);
    walletMetricsUnavailable = true;
    walletMetrics = {
      address: wallet,
      ageDays: 0,
      txCount: 0,
      funder: null,
      firstTxTimestamp: null,
    };
  }

  const walletScore = normalizeWalletScore({
    ageDays: walletMetrics.ageDays,
    txCount: walletMetrics.txCount,
  });

  let x402Stats: Awaited<ReturnType<typeof getX402PaymentStats>> = {
    paymentCount: 0,
    uniqueDays: 0,
    lastPaymentAt: null,
    paymentsWithUnprovableIndependence: 0,
  };
  let x402StatsUnavailable = false;
  try {
    x402Stats = await withDeadline(
      getX402PaymentStats(address),
      deadline.budgetFor(SIGNAL_BUDGET_MS),
      "x402_stats",
    );
  } catch (error) {
    logSignalDegraded("x402_stats", error);
    x402StatsUnavailable = true;
  }

  // vet402 2026-08-14 — L1 observed purchases (premium economic-activity signal).
  // Same bare-wallet path: a read failure can only withhold a promotion.
  let l1Stats: Awaited<ReturnType<typeof getObservedPurchaseStats>> = {
    purchaseCount: 0,
    uniqueDays: 0,
    distinctCounterparties: 0,
  };
  try {
    l1Stats = await withDeadline(
      getObservedPurchaseStats(address),
      deadline.budgetFor(SIGNAL_BUDGET_MS),
      "l1_stats",
    );
  } catch (error) {
    logSignalDegraded("l1_stats", error);
  }
  const x402Score = scoreEconomicActivity({ l1: l1Stats, x402: x402Stats });

  // Same contract as the agent path: the sybil checks read the owner/funder
  // indexes (DB), so "we could not check" degrades to
  // `sybil_checks_unavailable` — which assessSybilRisk reads as high risk →
  // BLOCK. It must never surface as "we checked and it was fine".
  let sybilFlags: string[];
  try {
    sybilFlags = await withDeadline(
      detectSybilFlags({
        identity: {
          agentId: BigInt(0),
          owner: null,
          agentWallet: wallet,
          tokenUri: null,
          registered: false,
        },
        walletMetrics,
        feedbackStats: { recentCount: 0, uniqueClients: 0, windowDays: 7 },
        totalFeedbackCount: 0,
      }),
      deadline.budgetFor(SYBIL_BUDGET_MS),
      "sybil_checks",
    );
  } catch (error) {
    logSignalDegraded("sybil_checks", error);
    sybilFlags = ["sybil_checks_unavailable"];
  }
  if (walletMetricsUnavailable) {
    sybilFlags.push("wallet_metrics_unavailable");
  }
  if (x402StatsUnavailable) {
    sybilFlags.push("x402_unavailable");
  }

  const sybilRisk = assessSybilRisk(sybilFlags);
  // Bare wallet (no ERC-8004 registration): identity and reputation default to
  // a neutral 30 — the same literals fed to computeWeightedScore below, echoed
  // into the breakdown so the API explains why an unregistered wallet caps out.
  const walletIdentityScore = 30;
  const walletReputationScore = 30;
  // vet402 2026-08-13: same ALLOW-evidence gate as the agent path. A bare
  // wallet has no ERC-8004 feedback, so its only routes above WARN are a signed
  // USDC settlement or an established (≥20 tx, ≥30 day) wallet history — both
  // on-chain and observed, never self-attested.
  const prePolicyScore = capForVerifiableEvidence(
    applySybilPenalty(
      computeWeightedScore(walletIdentityScore, walletReputationScore, walletScore.score, x402Score),
      sybilFlags,
    ),
    {
      x402PaymentCount: x402Stats.paymentCount,
      l1PurchaseCount: l1Stats.purchaseCount,
      uniqueFeedbackClients: 0,
      walletTxCount: walletMetrics.txCount,
      walletAgeDays: walletMetrics.ageDays,
    },
  );

  const chainSignals: Omit<TrustSignals, "manual"> = {
    identity: { registered: false, hasMetadataUri: false },
    reputation: { feedbackCount: 0, avgScore: 0, onChainAvgScore: 0 },
    wallet: {
      ageDays: walletMetrics.ageDays,
      txCount: walletMetrics.txCount,
      isBurner: walletScore.isBurner,
    },
    x402: {
      paymentCount: x402Stats.paymentCount,
      uniqueDays: x402Stats.uniqueDays,
      score: x402Score,
      l1PurchaseCount: l1Stats.purchaseCount,
      l1DistinctSellers: l1Stats.distinctCounterparties,
    },
    sybil: {
      risk: sybilRisk,
      flags: sybilFlags,
    },
  };

  const now = Date.now();
  const epoch = await getCacheEpoch(address);

  const payload: CachedChainPayload = {
    agentId: BigInt(0),
    wallet: address,
    prePolicyScore,
    components: {
      identity: walletIdentityScore,
      reputation: walletReputationScore,
      wallet: walletScore.score,
      x402: x402Score,
    },
    chainSignals,
    epoch,
    expiresAt: now + CACHE_TTL_MS,
  };

  // hasUnavailableInput (verdict.ts) is the single definition of "degraded",
  // and line ~392 in the agent path already uses it. This was a local
  // re-implementation of the same predicate — two copies of the rule that
  // decides whether a verdict may be cached is one copy too many.
  if (!hasUnavailableInput(sybilFlags)) {
    memoryCache.set(cacheKey, payload);
  }
  return applyPolicyLayer(payload, ctx);
}

async function applyPolicyLayer(
  payload: CachedChainPayload,
  ctx: ScoreRequestContext,
): Promise<TrustScoreResult> {
  const policy = await lookupManualListPolicy(ctx.apiKeyId, payload.wallet);
  const sybilRisk = payload.chainSignals.sybil.risk;

  const manual = applyManualList(payload.prePolicyScore, policy.effective, sybilRisk);
  const trustScore = manual.score;

  const recommendation = resolveRecommendation(
    trustScore,
    policy.effective,
    sybilRisk,
    manual.recommendation,
  );

  const manualOverride = policy.isGlobal ? false : (manual.manualOverride ?? false);

  const signals: TrustSignals = {
    ...payload.chainSignals,
    manual: { list: policy.visible },
  };

  const now = Date.now();
  const result = buildResult({
    agentId: payload.agentId,
    wallet: payload.wallet,
    trustScore,
    recommendation,
    manualOverride,
    policy,
    signals,
    // N-21: chain-derived explanation. Built from the cached component scores +
    // prePolicyScore so it is identical on cache hits and misses; the manual
    // policy layer (which produced trustScore above) is intentionally excluded
    // and surfaced via manualOverride instead.
    breakdown: buildScoreBreakdown(payload.components, payload.prePolicyScore),
    scoredAt: new Date(now).toISOString(),
    cacheExpiresAt: new Date(payload.expiresAt).toISOString(),
  });
  result.dataCoverage = await getDataCoverage(payload.wallet);
  return result;
}

async function verifyWalletBinding(
  agentId: bigint,
  identity: AgentIdentity,
  verifyWallet?: string,
): Promise<TrustScoreResult | null> {
  if (!verifyWallet) return null;

  if (!isValidAddress(verifyWallet)) {
    return buildBlockedResult(agentId, verifyWallet, "invalid_wallet_address", [
      "wallet_verification_failed",
    ]);
  }

  if (!identity.registered) {
    return buildBlockedResult(agentId, verifyWallet, "agent_not_registered", [
      "wallet_verification_failed",
    ]);
  }

  const canonicalWallet =
    identity.agentWallet ?? (await readCanonicalAgentWallet(agentId));

  if (!canonicalWallet) {
    return buildBlockedResult(agentId, verifyWallet, "wallet_verification_unavailable", [
      "wallet_verification_failed",
    ]);
  }

  if (!walletsMatch(canonicalWallet, verifyWallet)) {
    return buildBlockedResult(agentId, verifyWallet, "wallet_mismatch", ["wallet_mismatch"]);
  }

  return null;
}

async function buildBlockedResult(
  agentId: bigint,
  wallet: string,
  reason: string,
  flags: string[],
): Promise<TrustScoreResult> {
  const result: TrustScoreResult = {
    ...buildResult({
      agentId,
      wallet,
      trustScore: 0,
      recommendation: "BLOCK",
      manualOverride: false,
      policy: { effective: "none", visible: "none", isGlobal: false },
      signals: emptySignals({
        sybil: { risk: "high", flags },
      }),
    }),
    blockReason: reason,
  };
  result.dataCoverage = await getDataCoverage(wallet);
  return result;
}

function resolveWalletAddress(
  verifyWallet: string | undefined,
  agentWallet: Address | null,
): string | null {
  if (verifyWallet) return verifyWallet;
  if (agentWallet) return agentWallet;
  return null;
}

function buildResult(params: {
  agentId: bigint;
  wallet: string | null;
  trustScore: number;
  recommendation: TrustScoreResult["recommendation"];
  signals: TrustSignals;
  manualOverride: boolean;
  policy: ManualListPolicy;
  breakdown?: TrustScoreResult["breakdown"];
  scoredAt?: string;
  cacheExpiresAt?: string;
}): TrustScoreResult {
  const now = params.scoredAt ?? new Date().toISOString();
  const expires =
    params.cacheExpiresAt ?? new Date(Date.now() + CACHE_TTL_MS).toISOString();

  let disclaimer =
    "Scores are informational only and do not constitute a guarantee, credit assessment, or investment advice.";

  if (params.policy.isGlobal && params.policy.effective === "blacklist") {
    disclaimer =
      "Access restricted by operator policy. Scores are informational only.";
  } else if (params.signals.manual.list === "whitelist" && params.manualOverride) {
    disclaimer =
      "Score elevated by customer whitelist. Integrators should treat manualOverride=true as a policy decision, not a cryptographic guarantee.";
  } else if (
    params.signals.manual.list === "whitelist" &&
    params.signals.sybil.risk === "high"
  ) {
    disclaimer =
      "Customer whitelist was not applied because sybil risk is high. Scores are informational only.";
  }

  const result: TrustScoreResult = {
    agentId: params.agentId === BigInt(0) ? "0" : params.agentId.toString(),
    wallet: params.wallet,
    trustScore: params.trustScore,
    recommendation: params.recommendation,
    signals: params.signals,
    scoredAt: now,
    cacheExpiresAt: expires,
    reasons: reasonCodes(
      {
        identity: params.signals.identity,
        reputation: { feedbackCount: params.signals.reputation.feedbackCount },
        wallet: { ageDays: params.signals.wallet.ageDays, isBurner: params.signals.wallet.isBurner },
        x402: { paymentCount: params.signals.x402.paymentCount },
        sybil: params.signals.sybil,
        manual: { list: params.signals.manual.list as "none" | "whitelist" | "blacklist" },
      },
      params.trustScore,
      params.recommendation,
    ),
    disclaimer,
    manualOverride: params.manualOverride,
  };

  // Optional: present on normal chain-scored verdicts, absent on hard blocks.
  if (params.breakdown) {
    result.breakdown = params.breakdown;
  }

  if (params.policy.isGlobal && params.policy.effective === "blacklist") {
    result.blockReason = "operator_policy";
  }

  return result;
}

function emptySignals(
  partial: Partial<TrustSignals>,
): TrustSignals {
  return {
    identity: partial.identity ?? { registered: false, hasMetadataUri: false },
    reputation: partial.reputation ?? {
      feedbackCount: 0,
      avgScore: 0,
      onChainAvgScore: 0,
    },
    wallet: partial.wallet ?? { ageDays: 0, txCount: 0, isBurner: false },
    x402: partial.x402 ?? { paymentCount: 0, uniqueDays: 0, score: 50 },
    sybil: partial.sybil ?? { risk: "low", flags: [] },
    manual: partial.manual ?? { list: "none" },
  };
}
