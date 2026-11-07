import { countAgentsByOwner } from "@/lib/chain/agent-resolver";
import { getOwnerIndexerStatus } from "@/lib/db/owner-index";
import { OWNER_INDEX_STALE_SECONDS } from "@/lib/chain/config";
import { chainClock } from "@/lib/chain/chains";
import type { AgentIdentity, RecentFeedbackStats } from "@/lib/chain/erc8004";
import { getFunderClusterSize, isFundingCluster } from "@/lib/db/funder-index";
import type { WalletMetrics } from "@/lib/chain/wallet-metrics";

export type SybilContext = {
  identity: AgentIdentity;
  walletMetrics: WalletMetrics;
  feedbackStats: RecentFeedbackStats;
  totalFeedbackCount: number;
};

export type ReputationSybilContext = {
  identity: AgentIdentity;
  feedbackStats: RecentFeedbackStats;
  totalFeedbackCount: number;
};

export async function detectSybilFlags(ctx: SybilContext): Promise<string[]> {
  const flags = await detectReputationSybilFlags({
    identity: ctx.identity,
    feedbackStats: ctx.feedbackStats,
    totalFeedbackCount: ctx.totalFeedbackCount,
  });

  if (ctx.walletMetrics.ageDays < 7 && ctx.walletMetrics.txCount < 5) {
    flags.push("new_burner_wallet");
  }

  if (ctx.walletMetrics.funder) {
    const clusterSize = await getFunderClusterSize(ctx.walletMetrics.funder);
    if (isFundingCluster(clusterSize)) {
      flags.push("funding_cluster");
    }
  }

  return [...new Set(flags)];
}

/** Sybil checks that do not require wallet metrics (registered agents without bound wallet). */
export async function detectReputationSybilFlags(
  ctx: ReputationSybilContext,
): Promise<string[]> {
  const flags: string[] = [];

  if (ctx.identity.registered && !ctx.identity.agentWallet) {
    flags.push("no_bound_wallet");
  }

  if (ctx.identity.owner) {
    try {
      const ownerAgentCount = await countAgentsByOwner(ctx.identity.owner);
      if (ownerAgentCount >= 3) {
        flags.push("multi_agent_owner");
      }
    } catch {
      // Cannot verify ownership (RPC outage + index not caught up) — fail closed.
      flags.push("owner_count_unavailable");
    }

    // 2026-08-05 R&D (C-11): the owner-count above reads the LOCAL index. When
    // that index lags the chain by more than the staleness threshold, a fresh
    // sybil cluster registered inside the lag window is invisible to it — and
    // before this flag existed, the score would present stale data with a
    // fresh face. Soft flag: honest disclosure + a small discount, not a
    // hard block (the data exists, only its newest edge is uncertain). The
    // status read itself failing is NOT flagged here — that path is already
    // covered by owner_count_unavailable semantics when the count read fails.
    try {
      const status = await getOwnerIndexerStatus();
      const behind = status?.blocksBehind;
      const tipForLag = status?.liveTip ?? status?.chainTipAtRun;
      if (
        behind !== null &&
        behind !== undefined &&
        tipForLag !== null &&
        tipForLag !== undefined &&
        chainClock().secondsBetween(tipForLag - behind, tipForLag) > OWNER_INDEX_STALE_SECONDS
      ) {
        flags.push("owner_index_stale");
      }
    } catch {
      /* freshness unknown — do not invent a flag either way */
    }
  }

  const { recentCount, uniqueClients } = ctx.feedbackStats;
  // Velocity anomaly: high recent volume with low unique clients only.
  // Do not flag healthy high-volume agents with many distinct reviewers.
  if (recentCount >= 5 && uniqueClients <= 2) {
    flags.push("review_velocity_anomaly");
  } else if (recentCount >= 10 && uniqueClients <= 3) {
    flags.push("review_velocity_anomaly");
  }

  return [...new Set(flags)];
}

// assessSybilRisk moved to ./verdict (pure, importable without a database).
// Re-exported so existing call sites keep working.
export { assessSybilRisk } from "./verdict";
export type { SybilRisk } from "./verdict";
