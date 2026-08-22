import { erc20Abi, type Address } from "viem";
import { isSkipChainReadsEnabled } from "@/lib/config/env";
import { fetchErc20TransferWindow, fetchNativeTransferWindow } from "@/lib/chain/transfer-window";
import { getPublicClient, isValidAddress } from "@/lib/chain/client";
import { BASE_USDC_ADDRESS, SCORE_THRESHOLDS } from "@/lib/chain/config";
import { fetchWalletMetrics } from "@/lib/chain/wallet-metrics";
import {
  getNegativeReporterCorroboration,
  getOutcomesForWallet,
  type WalletOutcomeRow,
} from "@/lib/db/outcome-writer";
import {
  applyOutcomeAdjustment,
  EMPTY_OUTCOME_TRUST,
  NEGATIVE_OUTCOME_TYPES,
  type OutcomeTrust,
} from "./outcome-adjustment";
import { getPayeeStats, type PayeeStats } from "@/lib/db/x402-payments";
import {
  getObservedDeliveryStats,
  type ObservedDeliveryStats,
} from "@/lib/db/observed-purchases";
import { withDeadline } from "@/lib/util/deadline";
import { LruCache } from "@/lib/util/lru-cache";
import { logServerError } from "@/lib/util/log";
import { normalizeWalletScore, scoreL1Receiving } from "./helpers";
import { hasUnavailableInput, toRecommendation } from "./verdict";
import type { Recommendation } from "./types";

const FETCH_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 5_000;

/**
 * Per-leg time budgets, all three env-tunable so production can be re-sized
 * from production's own numbers without a deploy.
 *
 * Sized from measurements taken 2026-08-13 against base.blockscout.com for
 * 0xd8dA…6045 (37,157 transactions on Base), the hardest wallet this engine
 * claims to handle:
 *
 *   v2 /transactions      (2 pages)   18,036ms
 *   v2 /token-transfers   (2 pages)   51,979ms
 *   v1 txlist  offset=100 (1 request)  1,518-4,654ms
 *   v1 tokentx offset=100 (1 request) 10,297ms
 *
 * THOSE FIGURES ARE FROM A LAPTOP, AND THAT MATTERS. The first version of this
 * cut v2 off at 3,500ms on the strength of them — "a quiet wallet answers in
 * well under a second, so nothing legitimate is near this line". Deployed, it
 * took /payee/0x0330070F… from 41/WARN in ~7s to "Not verifiable" in 3.9s:
 * from Vercel's egress the very same read costs 4-7s. The budget was measured
 * in the wrong building. Numbers below are sized from PRODUCTION latency, and
 * the fallback is hedged (blockscout.ts) so that no single one of them can
 * decide a verdict on its own any more.
 *
 * V2_BUDGET is generous because v2 is the preferred source and is never cut
 * short in favour of the fallback — the hedge runs them side by side instead.
 * V1_BUDGET has to clear 10,297ms or the fallback is started and then killed
 * before it can answer, which is worse than having no fallback: the scarce v1
 * request is spent AND the verdict is refused anyway.
 * LEG_BUDGET is the outer ceiling over the hedge (6,000ms) plus the slower
 * arm plus one turn of the v1 pacing gate (2,500ms).
 */
const V2_BUDGET_MS = 14_000;
const V1_BUDGET_MS = 11_000;
const HEDGE_AFTER_MS = 6_000;
const LEG_BUDGET_MS = 20_000;

function envBudget(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Same dust guard as the outcome-detector's rug_pull_outflow check (commit
 * d20fbf0): a drain ratio alone is noise for a long-dormant wallet sitting
 * on a few wei — 0.005 ETH (~$10-20) is comfortably above gas-residue dust
 * on Base while still being a low bar for a wallet that was actually
 * entrusted with payment funds worth draining.
 */
const DRAIN_MIN_VALUE_WEI = 5_000_000_000_000_000n; // 0.005 ETH
/**
 * USDC equivalent of the native dust floor above: $10, in USDC's 6-decimal
 * smallest unit. Same rationale — a "drain" of less than this is gas-residue
 * noise, not an exit scam worth flagging.
 */
const DRAIN_MIN_VALUE_USDC = 10_000_000n; // 10 USDC
const DRAIN_HIGH_RATIO = 0.8;

/**
 * Ceiling for a verdict computed with at least one input we could not read.
 *
 * WHY A CEILING AND NOT A PENALTY (2026-08-13). Measured on
 * /payee/0xd8dA…6045: one wallet, one afternoon, nothing changing on chain —
 * 70/ALLOW on first load, 37/BLOCK on reload, 49/WARN on the leaderboard. The
 * whole spread was decided by WHICH upstream read happened to fail, because
 * every missing signal was silently replaced by a plausible middle value
 * (scoreDrain returns a neutral 50 for a check that never ran) and the result
 * was then banded like a measurement. The drain-check-only failure landed on
 * exactly 70 = SCORE_THRESHOLDS.allow, so a wallet whose exit-scam check was
 * never performed cleared the product's most permissive verdict — the
 * fail-OPEN direction, on the buyer-side engine the SDK's SpendGuard consults
 * before releasing funds.
 *
 * A fixed subtraction would not have closed it (84 − 20 is still a passable
 * number). A ceiling states the only thing that is actually true when a read
 * is missing: we cannot certify this wallet above the block line. It sits one
 * point under SCORE_THRESHOLDS.warn rather than at 0, because 0 is what
 * applyManualList uses for an operator blacklist and a degraded read is not an
 * accusation.
 */
const DEGRADED_SCORE_CEILING = SCORE_THRESHOLDS.warn - 1;

/**
 * Ceiling for a verdict where SOME inputs were measured and some were not.
 *
 * The middle case the engine used to collapse into "unavailable" (2026-08-13,
 * operator ruling). A wallet whose USDC outflow we read completely but whose
 * ETH outflow we could not still has a real measurement behind it, and
 * throwing that away is discarding evidence, not being careful. But a partial
 * reading must never clear the ALLOW gate, so it is capped one point under
 * SCORE_THRESHOLDS.allow: the best a partially-read wallet can be told is
 * WARN, while a surviving leg that looks BAD still produces its own BLOCK on
 * the merits. The legs that were not read are named in `signalsUnavailable`.
 */
const PARTIAL_SCORE_CEILING = SCORE_THRESHOLDS.allow - 1;

/**
 * Ceiling for a payee with no real RECEIVING track record (dataDepth "thin").
 *
 * vet402 2026-08-13 (score-manipulation ruling, hole 3). The buyer-side twin of
 * the seller-side evidence gate. A payee that has never been paid — or was only
 * paid by a single funding cluster, or in unsigned dust that scores zero
 * eligible receipts — still reached 84/ALLOW on wallet health alone: at "thin"
 * depth walletHealth carries 0.45 and drain 0.40, and a clean old wallet with
 * no outflow maxes both while the receiving axis sits at a neutral 50. So a
 * scammer whose receiving wallet is simply an old, clean address bought ALLOW
 * without ever having been a real counterparty to anyone.
 *
 * The ruling: ALLOW for a payee requires verifiable receiving evidence — real,
 * owner-signed USDC settlements from INDEPENDENTLY funded payers (exactly what
 * lifts a payee out of "thin" via determineDataDepth + independentPayerCount,
 * which already collapses a single-funder sybil cluster to one). Absent that, a
 * payee is capped one point under ALLOW: the best a payee with no track record
 * can be told is WARN. It is a Math.min ceiling, never a floor — a thin payee
 * whose wallet or drain signal looks bad still earns its own lower score.
 */
const PAYEE_THIN_SCORE_CEILING = SCORE_THRESHOLDS.allow - 1;

export type DataDepth = "thin" | "moderate" | "rich";

export type PayeeSignals = {
  receiving: {
    paymentCount: number;
    uniqueDays: number;
    distinctPayers: number;
    score: number;
    /** vet402 2026-08-14 — L1 delivery-verified receipts behind the score (the
     *  premium receiving signal). 0 until the observatory writes its first row. */
    l1DeliveryCount?: number;
    l1DistinctBuyers?: number;
  };
  walletHealth: {
    ageDays: number;
    txCount: number;
    isBurner: boolean;
    score: number;
  };
  drainPattern: {
    detected: boolean;
    drainRatio: number | null;
    outgoingCount: number;
    incomingCount: number;
    score: number;
    /** Asset legs that could not be read, e.g. ["native_drain"]. Empty when
     *  both assets were assessed. */
    unmeasured: string[];
  };
  outcomeHistory: {
    types: string[];
    adjustment: number;
  };
  flags: string[];
};

export type PayeeScoreResult = {
  payee: string;
  score: number;
  recommendation: Recommendation;
  dataDepth: DataDepth;
  /**
   * True when at least one input could not be read, so this is a fail-closed
   * refusal rather than a measurement. `dataDepth` answers "how much history
   * does this wallet have?"; this answers "did we manage to look?" — a
   * data-poor wallet we read completely is not the same as a wallet we could
   * not read at all, and the two used to be indistinguishable to callers.
   */
  degraded: boolean;
  /**
   * Every input that could not be read on this request, named — e.g.
   * ["native_drain"], ["wallet_metrics"], ["outcome_history"]. Empty means the
   * whole assessment was measured.
   *
   * The disclosure half of the partial-measurement rule (2026-08-13): when
   * this is non-empty but `degraded` is false, the score IS backed by real
   * measurements, just not all of them, and it has been capped below ALLOW
   * for exactly that reason. Callers that must not act on an incomplete view
   * can refuse on this field alone, without inferring it from the score.
   */
  signalsUnavailable: string[];
  signals: PayeeSignals;
  scoredAt: string;
  cacheExpiresAt: string;
  disclaimer: string;
};

const cache = new LruCache<string, { result: PayeeScoreResult; expiresAt: number }>(
  CACHE_MAX_ENTRIES,
);

export function invalidatePayeeScoreCache(payee?: string): void {
  if (!payee) {
    cache.clear();
    return;
  }
  cache.delete(payee.toLowerCase());
}

/**
 * 2026-08-22 audit: this used to be a hand-rolled Promise.race whose timer was
 * never cleared. On the fast path — the promise settling well inside its
 * budget — the pending setTimeout kept the event loop alive for the REST of
 * the budget, and LEG_BUDGET_MS is 20,000ms, so a serverless invocation could
 * be held open up to 20s after its work was done (and a test run likewise).
 *
 * @/lib/util/deadline does the same job with the same semantics — resolve if
 * it settles in time, reject with DeadlineExceededError if not, pass an
 * underlying rejection through untouched — and always clears the timer. One
 * definition of "too slow" across the scoring engines is worth more than a
 * local error string; every caller here already treats ANY rejection as an
 * unavailable leg, so the change of error identity is not observable in a
 * verdict.
 */
async function withTimeout<T>(promise: Promise<T>, budgetMs = FETCH_TIMEOUT_MS): Promise<T> {
  return withDeadline(promise, budgetMs, "payee_engine");
}

/** Machine-readable names for the asset legs, reported in signalsUnavailable. */
const NATIVE_LEG = "native_drain";
const USDC_LEG = "usdc_drain";

type DrainSignal = {
  detected: boolean;
  drainRatio: number | null;
  outgoingCount: number;
  incomingCount: number;
  /**
   * Asset legs we could not read, e.g. ["native_drain"]. A leg that failed is
   * named rather than averaged away: the wallet was assessed on the legs that
   * DID answer, and the caller is told which view is missing.
   */
  unmeasured: string[];
  /** True only when NO leg could be read — nothing was measured at all. */
  unavailable: boolean;
};

type AssetDrainAssessment = {
  detected: boolean;
  drainRatio: number | null;
  outgoingCount: number;
  incomingCount: number;
};

/**
 * Drain assessment for one asset (native ETH or USDC): drain ratio =
 * outgoing total / (outgoing total + remaining balance), detection gated on
 * the asset's own dust floor. The ratio is only reported when the wallet
 * actually *received* this asset — a pure-USDC payee inevitably spends its
 * small gas ETH down to near zero, and without this gate that gas burn would
 * read as a ~1.0 native "drain" and penalize a perfectly healthy payee.
 */
function assessAssetDrain(
  transfers: { from: string; to: string; value: string }[],
  balance: bigint | null,
  addressLower: string,
  minValue: bigint,
): AssetDrainAssessment {
  const incoming = transfers.filter(
    (tx) => tx.to.toLowerCase() === addressLower && BigInt(tx.value) > 0n,
  );
  const outgoing = transfers.filter(
    (tx) => tx.from.toLowerCase() === addressLower && BigInt(tx.value) > 0n,
  );

  const outgoingTotal = outgoing.reduce((sum, tx) => sum + BigInt(tx.value), 0n);
  const currentBalance = balance ?? 0n;
  const denominator = outgoingTotal + currentBalance;

  const rawRatio =
    denominator > 0n ? Number((outgoingTotal * 10_000n) / denominator) / 10_000 : null;
  const drainRatio = incoming.length > 0 ? rawRatio : null;

  const detected =
    incoming.length > 0 &&
    outgoingTotal >= minValue &&
    drainRatio !== null &&
    drainRatio >= DRAIN_HIGH_RATIO;

  return {
    detected,
    drainRatio,
    outgoingCount: outgoing.length,
    incomingCount: incoming.length,
  };
}

/**
 * Current balances, read from the chain rather than from the indexer.
 *
 * These deliberately do NOT swallow their errors into a null: a balance we
 * could not read is the denominator of the drain ratio, and treating it as
 * zero would turn "we don't know what's left" into "nothing is left", i.e.
 * invent a drain. The caller catches and flags drain_check_unavailable.
 */
async function fetchNativeBalance(address: Address): Promise<bigint> {
  return getPublicClient().getBalance({ address });
}

async function fetchErc20Balance(address: Address, token: Address): Promise<bigint> {
  return getPublicClient().readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
}

/**
 * Exit-scam shape check on the payee's own wallet: received funds, then
 * pulled out (near-)everything. Adapted from
 * src/lib/indexer/outcome-detector.ts's classifyWalletActivity, but scored
 * as an all-time snapshot rather than a post-verdict watch window, so it
 * deliberately drops that function's "2+ withdrawals" trigger (routine
 * treasury sweeps to cold storage would false-positive on a long-lived
 * payee) and keeps only the high-drain-ratio + absolute-value floor trigger.
 *
 * Assessed per asset over native ETH *and* Base USDC (the x402 settlement
 * currency — a payee that is only ever paid in USDC has zero native inflows,
 * so a native-only check would sit permanently neutral on exactly the
 * wallets this API scores). Detection fires if either asset shows the drain
 * shape; the reported ratio is the worst (highest) among assets the wallet
 * has actually received.
 *
 * THE LEGS ARE READ INDEPENDENTLY (2026-08-13, operator ruling). They used to
 * share one try/catch and one Promise.all, so a failure on either asset threw
 * the other asset's completed measurement away. Measured that day:
 * base.blockscout.com's v2 `/addresses/{a}/transactions` returned HTTP 500 on
 * 10 of 10 requests while `/token-transfers` on the same host answered — the
 * native leg was dead and the USDC leg, the one that actually matters for an
 * x402 payee, was fully readable. Discarding it produced a "we know nothing"
 * verdict out of data we did in fact have.
 *
 * Discarding a real measurement is not failing closed, it is failing blind.
 * The fail-closed half lives one level up, in scorePayeeWallet: a partially
 * measured wallet is capped below ALLOW no matter how good the surviving leg
 * looks, and the missing leg is named in `unmeasured` so it can be disclosed
 * rather than quietly averaged away.
 */
function windowOptions() {
  return {
    limit: 100,
    v2BudgetMs: envBudget("PAYEE_V2_BUDGET_MS", V2_BUDGET_MS),
    v1BudgetMs: envBudget("PAYEE_V1_BUDGET_MS", V1_BUDGET_MS),
    hedgeAfterMs: envBudget("PAYEE_HEDGE_AFTER_MS", HEDGE_AFTER_MS),
  };
}

async function assessNativeLeg(
  address: Address,
  addressLower: string,
): Promise<AssetDrainAssessment> {
  const legBudget = envBudget("PAYEE_LEG_BUDGET_MS", LEG_BUDGET_MS);
  const [window, balance] = await Promise.all([
    withTimeout(fetchNativeTransferWindow(address, windowOptions()), legBudget),
    withTimeout(fetchNativeBalance(address)),
  ]);
  return assessAssetDrain(window.transfers, balance, addressLower, DRAIN_MIN_VALUE_WEI);
}

async function assessUsdcLeg(
  address: Address,
  addressLower: string,
): Promise<AssetDrainAssessment> {
  const legBudget = envBudget("PAYEE_LEG_BUDGET_MS", LEG_BUDGET_MS);
  const [window, balance] = await Promise.all([
    withTimeout(fetchErc20TransferWindow(address, BASE_USDC_ADDRESS, windowOptions()), legBudget),
    withTimeout(fetchErc20Balance(address, BASE_USDC_ADDRESS)),
  ]);
  return assessAssetDrain(window.transfers, balance, addressLower, DRAIN_MIN_VALUE_USDC);
}

async function detectDrainPattern(address: Address): Promise<DrainSignal> {
  const nothing: DrainSignal = {
    detected: false,
    drainRatio: null,
    outgoingCount: 0,
    incomingCount: 0,
    unmeasured: [NATIVE_LEG, USDC_LEG],
    unavailable: true,
  };

  if (isSkipChainReadsEnabled()) return nothing;

  const addressLower = address.toLowerCase();
  // 2026-08-13: these reads were all Blockscout v1 and fired together. The v1
  // limiter answers three back-to-back requests and then refuses for 95+
  // seconds, renewing the lockout on every request made while limited (see the
  // header of lib/chain/blockscout.ts) — so this check could not succeed even
  // on its own, and it starved fetchWalletMetrics' v1 walk of the same budget.
  // History now comes from Alchemy first and Blockscout v2/v1 only as the
  // fallback (lib/chain/transfer-window.ts), and the balances from the RPC.
  // Zero v1 requests here on the healthy path.
  //
  // THE LEGS STAY INDEPENDENT even though Alchemy could serve both assets in a
  // single request. On 2026-08-13 Blockscout answered the USDC leg while the
  // native leg returned HTTP 500 on 10 of 10 requests, and keeping the leg
  // that DID answer is what turned a "we know nothing" refusal back into a
  // real, disclosed, capped verdict. One shared request would make every
  // provider hiccup a double failure again.
  const settled = await Promise.allSettled([
    assessNativeLeg(address, addressLower),
    assessUsdcLeg(address, addressLower),
  ]);

  const measured: AssetDrainAssessment[] = [];
  const unmeasured: string[] = [];
  for (const [index, name] of [NATIVE_LEG, USDC_LEG].entries()) {
    const leg = settled[index]!;
    if (leg.status === "fulfilled") {
      measured.push(leg.value);
    } else {
      unmeasured.push(name);
      logServerError(`payee_drain_${name}`, leg.reason);
    }
  }

  if (measured.length === 0) return { ...nothing, unmeasured };

  const ratios = measured
    .map((leg) => leg.drainRatio)
    .filter((ratio): ratio is number => ratio !== null);

  return {
    detected: measured.some((leg) => leg.detected),
    drainRatio: ratios.length > 0 ? Math.max(...ratios) : null,
    outgoingCount: measured.reduce((sum, leg) => sum + leg.outgoingCount, 0),
    incomingCount: measured.reduce((sum, leg) => sum + leg.incomingCount, 0),
    unmeasured,
    unavailable: false,
  };
}

/**
 * The payer-diversity bonus keys on distinct FUNDING SOURCES, not raw payer
 * wallets (vet402 2026-08-13, ruling 4). Ten payers funded by one address are
 * one sybil cluster, and paying the full ten-payer bonus for them let a payee
 * inflate its receiving diversity from a single funder — the mirror of the
 * payer-side funding_cluster check, which the seller side never had. When the
 * funder index is empty/lagging, distinctFunders == distinctPayers, so this is
 * identical to the old behavior until the index actually proves a cluster.
 */
function scoreReceiving(stats: PayeeStats): number {
  if (stats.paymentCount <= 0) return 50;

  let score = 50;
  if (stats.paymentCount >= 20) score += 20;
  else if (stats.paymentCount >= 10) score += 14;
  else if (stats.paymentCount >= 5) score += 9;
  else if (stats.paymentCount >= 2) score += 5;
  else score += 2;

  if (stats.uniqueDays >= 14) score += 12;
  else if (stats.uniqueDays >= 7) score += 8;
  else if (stats.uniqueDays >= 3) score += 4;

  const independentPayers = independentPayerCount(stats);
  if (independentPayers >= 10) score += 18;
  else if (independentPayers >= 5) score += 12;
  else if (independentPayers >= 2) score += 6;

  return clamp(score);
}

/**
 * The number of payers that could not be traced to a shared funder — the
 * funder-collapsed count, floored so a stale index never fabricates a penalty.
 * Kept as a named helper so scoreReceiving and determineDataDepth agree on
 * exactly what "an independent payer" means.
 */
function independentPayerCount(stats: PayeeStats): number {
  return Math.min(stats.distinctPayers, stats.distinctFunders);
}

/** True when a funding cluster deflated the payer count — surfaced as a flag. */
function payerFundingClusterDetected(stats: PayeeStats): boolean {
  return stats.distinctFunders < stats.distinctPayers;
}

function scoreDrain(signal: DrainSignal): number {
  if (signal.unavailable) return 50;
  if (signal.incomingCount === 0) return 60;
  if (signal.detected) return 5;
  if (signal.drainRatio === null) return 60;
  if (signal.drainRatio >= 0.5) return 45;
  return 85;
}

function determineDataDepth(stats: PayeeStats): DataDepth {
  // Depth keys on INDEPENDENT payers (funder-collapsed) for the same reason
  // the diversity bonus does: a sybil cluster must not buy "rich" history.
  const independentPayers = independentPayerCount(stats);
  if (stats.paymentCount >= 10 && stats.uniqueDays >= 7 && independentPayers >= 3) {
    return "rich";
  }
  if (stats.paymentCount >= 3 && independentPayers >= 2) {
    return "moderate";
  }
  return "thin";
}

/**
 * vet402 2026-08-14 — depth from L1 deliveries. The premium receiving twin of
 * determineDataDepth: vet402-confirmed deliveries to INDEPENDENT (funder-
 * collapsed) buyers. Thresholds mirror the x402 depth but on the strictly
 * stronger delivery-verified fact, so a payee vet402 has watched actually
 * deliver to real, independent buyers is not stuck at "thin" just because its
 * counterparties never used the x402 facilitator endpoint.
 */
function l1DeliveryDepth(l1: ObservedDeliveryStats): DataDepth {
  if (l1.deliveryCount >= 10 && l1.uniqueDays >= 7 && l1.distinctBuyers >= 3) return "rich";
  if (l1.deliveryCount >= 3 && l1.distinctBuyers >= 2) return "moderate";
  return "thin";
}

const DEPTH_RANK: Record<DataDepth, number> = { thin: 0, moderate: 1, rich: 2 };

/** The stronger of the x402 and L1 receiving depths. */
function combineDepth(a: DataDepth, b: DataDepth): DataDepth {
  return DEPTH_RANK[a] >= DEPTH_RANK[b] ? a : b;
}

/**
 * Weights shift by data depth: a wallet with little/no receiving history
 * (thin) can't be judged much on that axis, so cold-start wallets lean on
 * wallet health and drain-pattern signals instead. A wallet with a deep,
 * multi-payer receiving history (rich) is judged mostly on that track
 * record. Each row sums to 1.
 */
const WEIGHTS_BY_DEPTH: Record<
  DataDepth,
  { receiving: number; walletHealth: number; drain: number }
> = {
  thin: { receiving: 0.15, walletHealth: 0.45, drain: 0.4 },
  moderate: { receiving: 0.35, walletHealth: 0.35, drain: 0.3 },
  rich: { receiving: 0.5, walletHealth: 0.25, drain: 0.25 },
};

// Outcome-history scoring (which negatives may cap the public score, and which
// are retained-but-uncorroborated) lives in ./outcome-adjustment.ts so the
// decision is pure and unit-testable. NEGATIVE_OUTCOME_TYPES is imported for
// the drain-signal flag labelling below.

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * GET /v1/payees/{address}/score — "should my agent trust this wallet enough to
 * pay it?" Complements scoreWallet/scoreAgentById (which answer "should I
 * accept payment from this agent?"). Read-only: no writes, no fund movement.
 */
export async function scorePayeeWallet(address: string): Promise<PayeeScoreResult> {
  if (!isValidAddress(address)) {
    throw new Error("invalid_payee_address");
  }

  const addr = address as Address;
  const addrLower = address.toLowerCase();

  const cached = cache.get(addrLower);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const flags: string[] = [];

  // CONCURRENT, NOT SEQUENTIAL (2026-08-13). These four reads share no data —
  // each one's failure is handled on its own below — but they used to run one
  // after another, so the request's wall clock was the SUM of four independent
  // budgets. On a busy wallet that is what pushed the page past the point where
  // any single read could still finish: the drain check did not start until
  // wallet-metrics had spent up to 11s, and then had to fit its own fallback
  // into whatever was left. Running them together makes the request cost the
  // SLOWEST read rather than all of them, which is what gives the v1 fallback
  // room to exist at all. Nothing about which failure means what changes here.
  const [statsResult, metricsResult, drainResult, outcomesResult, l1Result] =
    await Promise.allSettled([
      getPayeeStats(addrLower),
      fetchWalletMetrics(addr),
      detectDrainPattern(addr),
      getOutcomesForWallet(addrLower),
      getObservedDeliveryStats(addrLower),
    ]);

  // The payment-stats read has no fallback and never had one: it is the local
  // database, and a caller asking for a score cannot be answered without it.
  // Rethrown rather than flagged, exactly as when it was awaited directly.
  if (statsResult.status === "rejected") throw statsResult.reason;
  const stats = statsResult.value;

  let walletMetrics: Awaited<ReturnType<typeof fetchWalletMetrics>> | null = null;
  if (metricsResult.status === "fulfilled") {
    walletMetrics = metricsResult.value;
  } else {
    logServerError("payee_wallet_metrics", metricsResult.reason);
    flags.push("wallet_metrics_unavailable");
  }

  // detectDrainPattern reports its own failures in the signal (it never
  // rejects), so a rejection here is a defect, not an outage — treat it as the
  // most cautious thing it could have returned rather than letting it escape.
  const drainSignal: DrainSignal =
    drainResult.status === "fulfilled"
      ? drainResult.value
      : ((logServerError("payee_drain_check", drainResult.reason),
        {
          detected: false,
          drainRatio: null,
          outgoingCount: 0,
          incomingCount: 0,
          unmeasured: [NATIVE_LEG, USDC_LEG],
          unavailable: true,
        }) as DrainSignal);
  if (drainSignal.unavailable) {
    flags.push("drain_check_unavailable");
  }

  // Outcome history is what caps a wallet with recorded fraud at 15. A read we
  // could not complete must therefore land in the degraded class, not read as
  // "this wallet has no history" — see getOutcomesForWallet's own note.
  let outcomes: WalletOutcomeRow[] = [];
  let outcomeHistoryRead = true;
  if (outcomesResult.status === "fulfilled") {
    outcomes = outcomesResult.value;
  } else {
    logServerError("payee_outcome_history", outcomesResult.reason);
    outcomeHistoryRead = false;
    flags.push("outcome_history_unavailable");
  }

  // Every input we did not manage to read, named for the caller. Assembled
  // from what actually happened above rather than parsed back out of `flags`,
  // so the disclosure cannot drift from the reads it describes.
  const signalsUnavailable = [
    ...(walletMetrics ? [] : ["wallet_metrics"]),
    ...drainSignal.unmeasured,
    ...(outcomeHistoryRead ? [] : ["outcome_history"]),
    // 2026-08-23 監査: 資金源が索引に無い payer は、以前は「自分自身が資金源」
    // として独立に数えられていた（新規ウォレットは必ず未索引なので、2つ用意する
    // だけで「独立した2者」になった）。今は数えないが、**黙って落とすだけでは
    // 同じ規律違反**——測れなかったことを開示して、呼び手が
    // partiallyMeasured として扱えるようにする。
    ...(stats.payersWithUnknownFunder > 0 ? ["payer_funding_independence"] : []),
  ];

  const rawWalletScore = normalizeWalletScore({
    ageDays: walletMetrics?.ageDays ?? 0,
    txCount: walletMetrics?.txCount ?? 0,
  });
  // A failed metrics read leaves ageDays 0 / txCount 0 behind, which
  // normalizeWalletScore reads as `isBurner` — a specific, checkable claim
  // about a wallet nobody managed to look at. The weighting may treat missing
  // history conservatively (that is the fail-closed direction), but the
  // reported signal must not assert a fact we did not observe.
  const walletScore = walletMetrics
    ? rawWalletScore
    : { ...rawWalletScore, isBurner: false };

  // vet402 2026-08-14 — L1 deliveries are PREMIUM receiving evidence. A read
  // failure here can only WITHHOLD a promotion (empty → no lift), so it degrades
  // to empty rather than flagging unavailable: the safe direction is the same as
  // on the buyer side.
  const l1Delivery: ObservedDeliveryStats =
    l1Result.status === "fulfilled"
      ? l1Result.value
      : ((logServerError("payee_l1_deliveries", l1Result.reason),
        { deliveryCount: 0, uniqueDays: 0, distinctBuyers: 0 }) as ObservedDeliveryStats);

  // The receiving axis takes the stronger of the x402 settlement record and the
  // L1 delivery record; depth (which drives the weight distribution AND the
  // no-receiving-evidence cap) is the stronger of the two as well, so an
  // address vet402 has watched deliver to real independent buyers is judged on
  // that track record instead of being capped as a payee with none.
  const receivingScore = Math.max(scoreReceiving(stats), scoreL1Receiving(l1Delivery));
  const drainScore = scoreDrain(drainSignal);
  const dataDepth = combineDepth(determineDataDepth(stats), l1DeliveryDepth(l1Delivery));
  const weights = WEIGHTS_BY_DEPTH[dataDepth];

  const preOutcomeScore = clamp(
    receivingScore * weights.receiving +
      walletScore.score * weights.walletHealth +
      drainScore * weights.drain,
  );

  // A NEGATIVE partner report may cap this public score only if it is trusted:
  // the reporter actually paid this wallet, or enough independent accounts
  // agree (src/lib/scoring/outcome-adjustment.ts). Gathering those facts is a
  // dependent DB read, so it runs only when a partner negative is actually
  // present — the common path (no negatives, or auto-only) pays nothing. A
  // failed corroboration read is an unread input: flagged `*_unavailable` so
  // the fail-closed gate treats it as degraded, never as "promote" or "drop".
  const partnerNegatives = outcomes.filter(
    (o) => o.source.startsWith("partner:") && NEGATIVE_OUTCOME_TYPES.has(o.outcomeType),
  );
  let outcomeTrust: OutcomeTrust = EMPTY_OUTCOME_TRUST;
  if (partnerNegatives.length > 0) {
    const reporterKeyIds = partnerNegatives
      .map((o) => o.apiKeyId)
      .filter((id): id is string => id !== null);
    try {
      outcomeTrust = await getNegativeReporterCorroboration(addrLower, reporterKeyIds);
    } catch (error) {
      logServerError("payee_outcome_corroboration", error);
      flags.push("outcome_corroboration_unavailable");
    }
  }

  const {
    score: measuredScore,
    adjustment,
    types: outcomeTypes,
    trustedNegativeTypes,
    uncorroboratedNegativeTypes,
    positiveTypes,
  } = applyOutcomeAdjustment(preOutcomeScore, outcomes, outcomeTrust);

  for (const type of trustedNegativeTypes) flags.push(`negative_outcome:${type}`);
  // Retained but not corroborated: disclosed so the reason a lone report did
  // NOT move the score is legible, without being an `*_unavailable` degrade.
  for (const type of uncorroboratedNegativeTypes) flags.push(`uncorroborated_negative:${type}`);
  for (const type of positiveTypes) flags.push(`positive_outcome:${type}`);
  if (walletScore.isBurner) flags.push("new_burner_wallet");
  // vet402 2026-08-13: disclose when the payer-diversity bonus was collapsed
  // because several payers share a funder. A flag, not a hard penalty — the
  // deflated count already lowered the receiving score; this makes the reason
  // legible rather than a silent drop.
  if (payerFundingClusterDetected(stats)) flags.push("payer_funding_cluster");
  // vet402 2026-08-13 (hole 3): a payee with no real receiving track record
  // (thin depth) cannot be ALLOW on wallet health alone. This is already
  // disclosed by `dataDepth: "thin"` on the result, so it is NOT added to
  // `signals.flags` (which callers read as an anomaly/unavailable list); the
  // capped score plus the thin depth say it without polluting that list.
  const noReceivingEvidence = dataDepth === "thin";

  // ---- fail-closed gate ------------------------------------------------
  // The invariant verdict.ts documents for the seller-side engine, applied to
  // the buyer side, which never had it: an `*_unavailable` flag means "we
  // could not check", and that must never leave here dressed as "we checked
  // and it was fine". `hasUnavailableInput` is the shared definition on
  // purpose — a local `.endsWith("_unavailable")` re-implementation is exactly
  // how the two sides drifted apart in the first place.
  const degraded = hasUnavailableInput(flags);
  // The middle case: real measurements, but not all of them. Not degraded (we
  // did measure something), and not clean either — capped below ALLOW so a
  // partial view can never clear the gate, while a surviving leg that looks
  // bad still lands its own BLOCK on the merits.
  const partiallyMeasured = !degraded && signalsUnavailable.length > 0;
  // The thin-depth cap is independent of the measurement ceilings above and
  // applies even on a fully-read wallet: "we read everything, and what we read
  // is a payee with no receiving history" is exactly the case it exists for. It
  // never lifts a degraded/partial ceiling — Math.min takes the lowest.
  const measurementCeiling = degraded
    ? DEGRADED_SCORE_CEILING
    : partiallyMeasured
      ? PARTIAL_SCORE_CEILING
      : 100;
  const ceiling = Math.min(
    measurementCeiling,
    noReceivingEvidence ? PAYEE_THIN_SCORE_CEILING : 100,
  );
  const score = Math.min(measuredScore, ceiling);
  // Stated, not inferred from the ceiling: if DEGRADED_SCORE_CEILING were ever
  // moved above the block line, the refusal must not quietly turn into a WARN.
  const recommendation: Recommendation = degraded ? "BLOCK" : toRecommendation(score, false);

  const now = Date.now();
  const result: PayeeScoreResult = {
    payee: addrLower,
    score,
    recommendation,
    dataDepth,
    degraded,
    signalsUnavailable,
    signals: {
      receiving: {
        paymentCount: stats.paymentCount,
        uniqueDays: stats.uniqueDays,
        distinctPayers: stats.distinctPayers,
        score: receivingScore,
        l1DeliveryCount: l1Delivery.deliveryCount,
        l1DistinctBuyers: l1Delivery.distinctBuyers,
      },
      walletHealth: {
        ageDays: walletMetrics?.ageDays ?? 0,
        txCount: walletMetrics?.txCount ?? 0,
        isBurner: walletScore.isBurner,
        score: walletScore.score,
      },
      drainPattern: {
        detected: drainSignal.detected,
        drainRatio: drainSignal.drainRatio,
        outgoingCount: drainSignal.outgoingCount,
        incomingCount: drainSignal.incomingCount,
        score: drainScore,
        unmeasured: drainSignal.unmeasured,
      },
      outcomeHistory: {
        types: outcomeTypes,
        adjustment,
      },
      flags: [...new Set(flags)],
    },
    scoredAt: new Date(now).toISOString(),
    cacheExpiresAt: new Date(now + CACHE_TTL_MS).toISOString(),
    disclaimer:
      "Scores are informational only and do not constitute a guarantee, credit assessment, or investment advice. " +
      "This score reflects a wallet's history as a payment recipient (settlement track record, wallet health, and " +
      "outflow pattern) — it is not an identity or legal-standing check.",
  };

  // A verdict the engine is not confident enough to cache is one nobody
  // downstream may pin either (tests/verdict-consistency.test.ts). A partial
  // reading counts: it is capped below ALLOW because of an upstream outage,
  // and pinning it for five minutes would keep the cap in place long after
  // the missing leg came back.
  if (!degraded && !partiallyMeasured) {
    cache.set(addrLower, { result, expiresAt: now + CACHE_TTL_MS });
  }

  return result;
}

/**
 * verify-at-settle 高速面（C6）用の覗き窓。**計算しない**——インメモリ
 * キャッシュに信頼できる判定があればそれを、無ければ null を返すだけ。
 * fail-closed の意味論はここでは作らない（呼び手の SpendGuard が
 * 非ALLOWを支払わないと解釈する）。degraded/partial な判定はそもそも
 * キャッシュに入らない（上の cache.set の条件）ので、ここから出る判定は
 * 常にエンジンが自信を持って固定したものだけ。
 */
export function peekPayeeScoreCache(address: string): PayeeScoreResult | null {
  const hit = cache.get(address.toLowerCase());
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) return null;
  return hit.result;
}
