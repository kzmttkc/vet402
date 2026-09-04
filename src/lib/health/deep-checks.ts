import { sql } from "drizzle-orm";
import { agentResolveTailMaxBlocks } from "@/lib/chain/agent-resolve-window";
import { chainById, DEFAULT_CHAIN_ID } from "@/lib/chain/chains";
import { tailMaxBlocks } from "@/lib/chain/feedback-window";
import { getProductionEnvErrors } from "@/lib/config/env";
import { getDb } from "@/lib/db/client";
import { getFeedbackIndexerStatus } from "@/lib/db/feedback-index";
import {
  AGENT_WALLET_INDEX_CHECKPOINT,
  getIndexerCheckpoint,
  getOwnerIndexerLagThreshold,
  getOwnerIndexerStatus,
} from "@/lib/db/owner-index";
import { isSpendingHalted } from "@/lib/observatory/kill-switch";
import { runScoringProbe } from "./scoring-probe";

export type DeepHealthStatus = "ok" | "degraded";

export type DeepHealthResult = {
  status: DeepHealthStatus;
  /** True only when env / DB / RPC critical checks fail — drives HTTP 503. */
  criticalFailure: boolean;
  checks: Record<string, string>;
  /** Opaque flag for clients; details stay in server logs. */
  env?: { ok: false };
  indexer?: {
    scope: string;
    lastBlock: string | null;
    chainTipAtRun: string | null;
    liveTip: string | null;
    blocksBehind: string | null;
    lagThreshold: string;
    caughtUp: boolean;
    indexedAgentRows: number;
  };
};

export async function runDeepHealthChecks(): Promise<DeepHealthResult> {
  const checks: Record<string, string> = {};
  let criticalFailure = false;

  const envErrors = getProductionEnvErrors();
  if (envErrors.length > 0) {
    checks.env = "error";
    criticalFailure = true;
    for (const message of envErrors) {
      console.error(`[deep-health] env: ${message}`);
    }
  } else {
    checks.env = "ok";
  }

  try {
    const db = getDb();
    if (!db) {
      checks.database = "unconfigured";
      criticalFailure = true;
    } else {
      await db.execute(sql`SELECT 1`);
      checks.database = "ok";
    }
  } catch {
    checks.database = "error";
    criticalFailure = true;
  }

  let liveTip: bigint | undefined;
  try {
    const { getPublicClient } = await import("@/lib/chain/client");
    const client = getPublicClient();
    liveTip = await client.getBlockNumber();
    checks.rpc = "ok";
  } catch {
    checks.rpc = "error";
    criticalFailure = true;
  }

  // The check that actually matters. `rpc` above only proves the endpoint can
  // answer eth_getBlockNumber — it stayed green throughout the 2026-08-12
  // outage, while eth_getLogs failed and every score on the site timed out.
  // Probing the real scoreAgentById() path is the only way this endpoint can
  // tell the truth about the product's core capability.
  const scoring = await runScoringProbe();
  checks.scoring = scoring.status;
  checks.scoring_latency_ms = String(scoring.latencyMs);
  if (scoring.status === "error") {
    criticalFailure = true;
  } else if (scoring.unavailable.length > 0) {
    checks.scoring_unavailable = scoring.unavailable.join(",");
  }

  const indexerStatus = await getOwnerIndexerStatus(
    liveTip !== undefined ? { liveTip } : undefined,
  );
  const lagThreshold = getOwnerIndexerLagThreshold();
  let indexerPayload: DeepHealthResult["indexer"];

  if (!indexerStatus) {
    checks.owner_indexer = "unconfigured";
    // Missing checkpoint during cold start is informational, not a critical outage.
  } else {
    indexerPayload = {
      scope: indexerStatus.scope,
      lastBlock: indexerStatus.lastBlock?.toString() ?? null,
      chainTipAtRun: indexerStatus.chainTipAtRun?.toString() ?? null,
      liveTip: indexerStatus.liveTip?.toString() ?? null,
      blocksBehind: indexerStatus.blocksBehind?.toString() ?? null,
      lagThreshold: lagThreshold.toString(),
      caughtUp: indexerStatus.caughtUp,
      indexedAgentRows: indexerStatus.indexedAgentRows,
    };

    if (indexerStatus.blocksBehind !== null && indexerStatus.blocksBehind > lagThreshold) {
      checks.owner_indexer = "lagging";
    } else if (!indexerStatus.caughtUp) {
      checks.owner_indexer = "partial";
    } else {
      checks.owner_indexer = "ok";
    }
  }

  // The feedback index is now load-bearing for a verdict: when it stops
  // advancing, the unindexed tail eventually exceeds what the request path is
  // allowed to scan, `fetchRecentFeedbackStats` degrades, and every agent goes
  // back to BLOCK — the exact outage this indexer was built to end. That
  // failure is loud in the verdicts but silent in the infrastructure, so the
  // lag is reported here where a human is already looking.
  try {
    const feedbackStatus = await getFeedbackIndexerStatus(
      liveTip !== undefined ? { liveTip } : undefined,
    );
    if (!feedbackStatus) {
      checks.feedback_indexer = "unconfigured";
    } else {
      const behind = feedbackStatus.blocksBehind;
      checks.feedback_indexer_blocks_behind = behind?.toString() ?? "unknown";
      // Past this the tail is wider than the live scan will attempt, so the
      // signal is unavailable rather than merely stale.
      const maxTail = tailMaxBlocks(chainById(DEFAULT_CHAIN_ID)?.blocksPerDay ?? 43_200);
      checks.feedback_indexer =
        behind !== null && behind > maxTail ? "lagging" : "ok";
    }
  } catch {
    checks.feedback_indexer = "error";
  }

  // WalletSet 索引（2026-08-13）。wallet→agent の逆引きはここが本体で、遅れが
  // tail の上限を超えた瞬間に resolveAgentIdByWallet は unavailable を返す
  // ——つまり素のウォレット採点が全部落ちる。デプロイ直後は FROM_BLOCK からの
  // backfill 中なので "lagging" が正常であり、その進み具合をここで見る。
  try {
    const walletCheckpoint = await getIndexerCheckpoint(AGENT_WALLET_INDEX_CHECKPOINT);
    if (walletCheckpoint === null) {
      checks.agent_wallet_index = "unconfigured";
    } else {
      const behind = liveTip !== undefined ? liveTip - walletCheckpoint : null;
      checks.agent_wallet_index_blocks_behind = behind?.toString() ?? "unknown";
      const maxTail = agentResolveTailMaxBlocks(chainById(DEFAULT_CHAIN_ID)?.blocksPerDay ?? 43_200);
      checks.agent_wallet_index = behind !== null && behind > maxTail ? "lagging" : "ok";
    }
  } catch {
    checks.agent_wallet_index = "error";
  }

  // 決済索引（§7.2）の停滞。2026-09-04 監査 D: 9/2 20:43 UTC から 17 回連続で失敗していたのに
  // ルートも launchd も ok:true を返し、deep health も見ていなかったので 39 時間素通りした。
  // 1 日分（43,200 ブロック）を超えて遅れていたら degraded。
  try {
    const settlementsCheckpoint = await getIndexerCheckpoint("settlements:eip155:8453");
    if (settlementsCheckpoint === null) {
      checks.settlements_index = "unconfigured";
    } else {
      const behind = liveTip !== undefined ? liveTip - settlementsCheckpoint : null;
      checks.settlements_index_blocks_behind = behind?.toString() ?? "unknown";
      checks.settlements_index = behind !== null && behind > 43_200n ? "lagging" : "ok";
      if (behind !== null && behind > 43_200n) criticalFailure = true;
    }
  } catch {
    checks.settlements_index = "error";
  }

  // 実行時の支出停止スイッチの現在値（2026-09-05 監査 P0・kill-switch.ts）。
  // **degraded にはしない**——停止は障害ではなく運用者の意思決定で、正常な
  // 状態のひとつ。だが「なぜ L1 が 1 件も買っていないのか」を調べる人が
  // 最初に見る場所なので、ここに出す。理由の文言は載せない（このボディは
  // admin 越しでも本文が広く回覧されうる）。
  try {
    const halt = await isSpendingHalted();
    checks.spending_halt = halt.halted ? "halted" : "off";
  } catch {
    checks.spending_halt = "unknown";
  }

  return {
    // A cautious-but-working score is not "ok" — it means an upstream is down
    // and every verdict it produces is being forced conservative.
    status: criticalFailure || scoring.status !== "ok" ? "degraded" : "ok",
    criticalFailure,
    checks,
    ...(envErrors.length > 0 ? { env: { ok: false as const } } : {}),
    ...(indexerPayload ? { indexer: indexerPayload } : {}),
  };
}
