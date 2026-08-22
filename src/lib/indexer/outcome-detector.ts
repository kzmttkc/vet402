import type { Address } from "viem";
import { fetchWalletBalance, fetchWalletTransactions } from "@/lib/chain/blockscout";
import { fetchRecentFeedbackStats, fetchReputationSummary } from "@/lib/chain/erc8004";
import { getDb } from "@/lib/db/client";
import {
  collectWatchedTrustEvents,
  recordAutoOutcome,
  type AutoOutcomeType,
  type TrustEventRow,
} from "@/lib/db/outcome-writer";
import { ownerAgents } from "@/lib/db/schema";
import { desc, eq } from "drizzle-orm";
import type { TrustSignals } from "@/lib/scoring/types";

export type OutcomeDetectResult = {
  scanned: number;
  recorded: number;
  errors: number;
};

const DEFAULT_BATCH = 50;
const DELAY_MS = 200;
const WATCH_WINDOW_DAYS = 7;

// Activity classification thresholds. These are phase-1 heuristics, not
// tuned statistics — they exist to get real result labels flowing so score
// accuracy can be measured later, not to be a definitive fraud detector.
const DORMANT_THRESHOLD_MINUTES = 24 * 60; // no tx at all since the event for a full day
const RUG_PULL_QUIET_MINUTES = 12 * 60; // quiet period after an outgoing transfer
// A single small outgoing transfer followed by a quiet spell is not, on its
// own, "rug pull"-shaped — plenty of healthy wallets pay out once and go
// idle. We require the outflow to look like an actual drain: either a
// pattern of repeated withdrawals, or a single/few withdrawals that took
// most of the wallet's tracked value with them.
const RUG_PULL_MIN_OUTFLOW_COUNT = 2; // 2+ separate outgoing transfers since the event
const RUG_PULL_HIGH_DRAIN_RATIO = 0.8; // outgoing / (outgoing + what's left now) >= 80%
// drainRatio is a ratio with no absolute-value floor, so a long-dormant
// wallet sitting on a few wei of dust can hit ratio >= 0.8 by sending out a
// trivial amount (e.g. 5 wei balance, 100 wei outflow => ratio ~= 0.95) —
// that's not a rug pull, it's noise. Chain targeted is Base (see
// src/lib/chain/config.ts BASE_CHAIN_ID), native token ETH, 18 decimals.
// 0.005 ETH (~$10-20 at typical ETH prices) is comfortably above dust/gas
// residue — which on Base is routinely sub-cent, many orders of magnitude
// below this — while still being a low bar for an agent wallet that was
// actually entrusted with funds worth draining. This is a fixed wei
// threshold, not a live USD conversion (no external price API called).
const RUG_PULL_MIN_DRAIN_VALUE_WEI = 5_000_000_000_000_000n; // 0.005 ETH
const HEALTHY_MIN_TX_COUNT = 5;
const HEALTHY_MIN_DISTINCT_DAYS = 2;
const HEALTHY_MIN_WINDOW_MINUTES = 24 * 60; // don't call it "healthy" before a day has passed
const FEEDBACK_AVG_DROP_EPSILON = 0.01;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minutesBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 60_000));
}

type ActivityVerdict = {
  outcomeType: "rug_pull_outflow" | "wallet_dormant" | "sustained_healthy_activity";
  evidence: Record<string, unknown>;
};

/**
 * Classifies wallet activity since a trust event using the most recent 100
 * transactions (Blockscout, sorted desc). Returns null when there isn't yet
 * enough signal to call a verdict — the event stays "watched" and gets
 * re-checked on a later run.
 *
 * rug_pull_outflow is provisional, not terminal (see
 * TERMINAL_ACTIVITY_OUTCOME_TYPES in outcome-writer.ts): a wallet that goes
 * quiet after a drain-shaped outflow can still earn sustained_healthy_activity
 * on a later scan if it resumes normal activity, which overrides the
 * rug-pull read for that trust_event.
 */
async function classifyWalletActivity(
  wallet: Address,
  eventCreatedAt: Date,
  now: Date,
): Promise<ActivityVerdict | null> {
  const windowMinutes = minutesBetween(eventCreatedAt, now);
  const createdAtSec = Math.floor(eventCreatedAt.getTime() / 1000);

  const txs = await fetchWalletTransactions(wallet, { sort: "desc", offset: 100, page: 1 });
  const sinceTxs = txs.filter((tx) => Number(tx.timeStamp) >= createdAtSec);

  if (sinceTxs.length === 0) {
    if (windowMinutes >= DORMANT_THRESHOLD_MINUTES) {
      return {
        outcomeType: "wallet_dormant",
        evidence: { windowMinutes, txCountSinceEvent: 0 },
      };
    }
    return null;
  }

  // sinceTxs[0] is the most recent (desc order).
  const lastTxTimestampMs = Number(sinceTxs[0]!.timeStamp) * 1000;
  const quietMinutes = minutesBetween(new Date(lastTxTimestampMs), now);

  const walletLower = wallet.toLowerCase();
  const outgoing = sinceTxs.filter(
    (tx) => tx.from.toLowerCase() === walletLower && BigInt(tx.value) > BigInt(0),
  );

  if (outgoing.length > 0 && quietMinutes >= RUG_PULL_QUIET_MINUTES) {
    const outgoingValueTotal = outgoing.reduce(
      (sum, tx) => sum + BigInt(tx.value),
      BigInt(0),
    );

    // drainRatio approximates "what fraction of tracked value left the
    // wallet": outgoing / (outgoing + current balance). It's a live-balance
    // proxy, not a true historical balance at the time of the event, but
    // it's real on-chain data and the best available without per-block
    // balance queries. A failed balance lookup just drops this signal for
    // the current scan (repeatedWithdrawals can still trigger); it doesn't
    // throw, since a single flaky Blockscout call shouldn't block the rest
    // of detectForTrustEvent.
    let drainRatio: number | null = null;
    try {
      const currentBalance = await fetchWalletBalance(wallet);
      if (currentBalance !== null) {
        const denominator = outgoingValueTotal + currentBalance;
        drainRatio =
          denominator > BigInt(0)
            ? Number((outgoingValueTotal * BigInt(10_000)) / denominator) / 10_000
            : 1;
      }
    } catch (err) {
      console.error(`outcome-detector: balance lookup failed for ${wallet}`, err);
    }

    // 2026-08-23 監査: repeatedWithdrawals に**金額下限が無かった**。
    // `outgoing` は value > 0 しか要求しないので、ダストのETH送金2回＋12時間の
    // 静穏だけで rug_pull_outflow が自動記録され、outcome-adjustment が
    // Math.min(score, 15) で payee スコアを BLOCK に固定した。
    // 公開の /v1/wallets/{任意アドレス}/score を叩けば任意のウォレットを監視集合に
    // 入れられるので、**APIキー1つで正直な売り手を潰せた**。
    // 「2回引き出した」は金額を見なければ何の所見でもない。比率側と同じ下限を課す。
    const repeatedWithdrawals =
      outgoing.length >= RUG_PULL_MIN_OUTFLOW_COUNT &&
      outgoingValueTotal >= RUG_PULL_MIN_DRAIN_VALUE_WEI;
    const highDrainRatio =
      drainRatio !== null &&
      drainRatio >= RUG_PULL_HIGH_DRAIN_RATIO &&
      outgoingValueTotal >= RUG_PULL_MIN_DRAIN_VALUE_WEI;

    if (repeatedWithdrawals || highDrainRatio) {
      return {
        outcomeType: "rug_pull_outflow",
        evidence: {
          windowMinutes,
          quietMinutes,
          outgoingCount: outgoing.length,
          outgoingValueTotal: outgoingValueTotal.toString(),
          drainRatio,
          lastOutgoingTxHash: outgoing[0]!.hash,
        },
      };
    }
  }

  const distinctDays = new Set(
    sinceTxs.map((tx) => new Date(Number(tx.timeStamp) * 1000).toISOString().slice(0, 10)),
  ).size;

  if (
    sinceTxs.length >= HEALTHY_MIN_TX_COUNT &&
    distinctDays >= HEALTHY_MIN_DISTINCT_DAYS &&
    windowMinutes >= HEALTHY_MIN_WINDOW_MINUTES &&
    quietMinutes < RUG_PULL_QUIET_MINUTES
  ) {
    return {
      outcomeType: "sustained_healthy_activity",
      evidence: { windowMinutes, txCountSinceEvent: sinceTxs.length, distinctDays },
    };
  }

  return null;
}

/**
 * Ownership change since the trust event, per the owner-indexer's current
 * (owner, agentId) state. We don't retain historical Transfer rows, so this
 * compares the trust event's timestamp against the owner-index row's
 * updatedAt — which only advances when the owner-indexer actually processes
 * a Registered/Transfer event for that agent (src/lib/indexer/owner-indexer.ts).
 */
async function checkOwnershipChanged(
  agentId: bigint,
  eventCreatedAt: Date,
): Promise<{ relatedWallet: string; evidence: Record<string, unknown> } | null> {
  const db = getDb();
  if (!db) return null;

  const rows = await db
    .select({ owner: ownerAgents.owner, updatedAt: ownerAgents.updatedAt })
    .from(ownerAgents)
    .where(eq(ownerAgents.agentId, agentId))
    .orderBy(desc(ownerAgents.updatedAt))
    .limit(1);

  const row = rows[0];
  if (!row || !row.updatedAt) return null;
  if (row.updatedAt.getTime() <= eventCreatedAt.getTime()) return null;

  return {
    relatedWallet: row.owner,
    evidence: { newOwner: row.owner, changedAt: row.updatedAt.toISOString() },
  };
}

/**
 * New negative feedback since the trust event: fetchRecentFeedbackStats
 * confirms *something* landed in the window, and a drop in the cumulative
 * on-chain average (vs. what was captured in trust_events.signals at score
 * time) is the signal that what landed skewed negative.
 */
async function checkReputationNegativeFeedback(
  agentId: bigint,
  eventCreatedAt: Date,
  now: Date,
): Promise<{ evidence: Record<string, unknown>; currentAvg: number } | null> {
  const windowMinutes = minutesBetween(eventCreatedAt, now);
  const windowDays = Math.min(30, Math.max(1, Math.ceil(windowMinutes / (24 * 60))));

  // Cron context, no request budget — and the windows asked for here reach 30
  // days, which the feedback index only covers once it has been running that
  // long. Falling back to a full chain scan is affordable here in a way it
  // never was on the scoring path.
  const recent = await fetchRecentFeedbackStats(agentId, windowDays, undefined, {
    allowFullScan: true,
  });
  if (recent.recentCount === 0) return null;

  const reputation = await fetchReputationSummary(agentId);
  const currentAvg =
    reputation.count > 0 ? reputation.summaryValue / 10 ** reputation.summaryValueDecimals : 0;

  return { evidence: { recentCount: recent.recentCount, currentAvg }, currentAvg };
}

function extractStoredOnChainAvg(signals: unknown): number | null {
  const parsed = signals as TrustSignals | null;
  const value = parsed?.reputation?.onChainAvgScore;
  return typeof value === "number" ? value : null;
}

async function detectForTrustEvent(row: TrustEventRow, now: Date): Promise<number> {
  let recorded = 0;
  const windowMinutes = minutesBetween(row.createdAt, now);

  // Terminal activity classification (mutually exclusive; stops future scans
  // once one lands — see TERMINAL_ACTIVITY_OUTCOME_TYPES).
  if (row.wallet) {
    try {
      const verdict = await classifyWalletActivity(row.wallet as Address, row.createdAt, now);
      if (verdict) {
        const ok = await recordAutoOutcome({
          trustEventId: row.id,
          outcomeType: verdict.outcomeType,
          relatedWallet: row.wallet,
          windowMinutes,
          evidence: verdict.evidence,
        });
        if (ok) recorded++;
      }
    } catch (err) {
      console.error(`outcome-detector: activity classification failed for ${row.id}`, err);
    }
  }

  // Ownership change (independent side-signal).
  if (row.agentId !== null && row.agentId !== BigInt(0)) {
    try {
      const ownership = await checkOwnershipChanged(row.agentId, row.createdAt);
      if (ownership) {
        const outcomeType: AutoOutcomeType = "ownership_changed";
        const ok = await recordAutoOutcome({
          trustEventId: row.id,
          outcomeType,
          relatedWallet: ownership.relatedWallet,
          windowMinutes,
          evidence: ownership.evidence,
        });
        if (ok) recorded++;
      }
    } catch (err) {
      console.error(`outcome-detector: ownership check failed for ${row.id}`, err);
    }

    // Reputation drop (independent side-signal).
    try {
      const storedAvg = extractStoredOnChainAvg(row.signals);
      if (storedAvg !== null) {
        const negative = await checkReputationNegativeFeedback(row.agentId, row.createdAt, now);
        if (negative && negative.currentAvg < storedAvg - FEEDBACK_AVG_DROP_EPSILON) {
          const outcomeType: AutoOutcomeType = "reputation_negative_feedback";
          const ok = await recordAutoOutcome({
            trustEventId: row.id,
            outcomeType,
            relatedWallet: row.wallet,
            windowMinutes,
            evidence: { ...negative.evidence, storedAvg },
          });
          if (ok) recorded++;
        }
      }
    } catch (err) {
      console.error(`outcome-detector: reputation check failed for ${row.id}`, err);
    }
  }

  return recorded;
}

export async function detectOutcomes(options?: {
  limit?: number;
  delayMs?: number;
}): Promise<OutcomeDetectResult> {
  const limit = options?.limit ?? DEFAULT_BATCH;
  const delayMs = options?.delayMs ?? DELAY_MS;

  const events = await collectWatchedTrustEvents(WATCH_WINDOW_DAYS, limit);
  const result: OutcomeDetectResult = { scanned: events.length, recorded: 0, errors: 0 };
  const now = new Date();

  for (const row of events) {
    try {
      result.recorded += await detectForTrustEvent(row, now);
    } catch (err) {
      result.errors++;
      console.error(`outcome-detector: unexpected failure for trust_event ${row.id}`, err);
    }
    await sleep(delayMs);
  }

  return result;
}
