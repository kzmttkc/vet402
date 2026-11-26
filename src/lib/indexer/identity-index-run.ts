import { acquireLeaseFailClosed } from "@/lib/cron/lease-fail-closed";
import { type AgentWalletIndexResult } from "./agent-wallet-indexer";
import { indexOwnerAgents, type OwnerIndexResult } from "./owner-indexer";
import { indexErc8004StateChains, type Erc8004StateIndexResult, DEFAULT_STATE_TIME_BUDGET_MS } from "./erc8004-state-indexer";
import type { Erc8004ChainIndexResult } from "./erc8004-chain-indexer";
import { indexErc8004SolanaChains, type Erc8004SolanaIndexResult } from "./erc8004-solana-indexer";

/**
 * `/api/cron/index-owners` の中身（2026-10-31）。所有者索引と WalletSet 索引を、同じ時計・同じ
 * 持ち時間で **並べて** 回す。
 *
 * 2026-11-17: Ethereum・BNB・Base wallet は eth_getLogs の代わりに状態読み（erc8004-state-indexer.ts）。
 * Base の owner はログ索引のまま。
 */
export const IDENTITY_INDEX_LEASE = "index-owners";
export const IDENTITY_INDEX_LEASE_TTL_SECONDS = 330;

export type IdentityIndexSkippedBody = { ok: true; skipped: "lease_held" } | { ok: false; error: "lease_unverified" };

export type IdentityIndexRunBody = {
  ok: boolean;
  error?: string;
  /** 2 つとも tip に届いたときだけ true（catch-up スクリプトはこの 1 つでループを止める）。 */
  caughtUp: boolean;
  ownerCaughtUp: boolean;
  /** どちらかが持ち時間（または壁時計の上限）で止まった回。 */
  stoppedByBudget: boolean;
  /** この回に checkpoint が進んだブロック数。 */
  blocksAdvanced: { owner: number; wallet: number };
  walletIndex: AgentWalletIndexResult | { error: string };
  /** Ethereum・BNB・Base wallet の状態読み索引。鎖ごとに ok・error。 */
  chainIndexes: Erc8004ChainIndexResult[] | Erc8004StateIndexResult[];
  stateIndexes?: Erc8004StateIndexResult[];
  solanaIndexes?: Erc8004SolanaIndexResult[];
} & Omit<Partial<OwnerIndexResult>, "blocksAdvanced" | "caughtUp">;

const BUDGET_STOPS = new Set(["time_budget", "hard_stop", "write_deadline"]);

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function stateToWalletResult(r: Erc8004StateIndexResult): AgentWalletIndexResult | { error: string } {
  if (r.status !== "ok" || r.chain !== "eip155:8453") return { error: r.status === "error" ? r.error : "no_base_state" };
  return {
    fromBlock: r.fromId,
    toBlock: r.toId,
    walletSetEvents: 0,
    upserted: r.walletsWritten,
    caughtUp: r.caughtUp,
    blocksAdvanced: r.idsRead,
    segments: 1,
    partial: r.partial,
    ...(r.stoppedBy ? { stoppedBy: r.stoppedBy } : {}),
  };
}

export async function runIdentityIndexes(input: {
  maxBlocks: bigint;
  segmentBlocks?: bigint;
  timeBudgetMs?: number;
  hardStopMs?: number;
  writeDeadlineMs?: number;
  now?: () => number;
}): Promise<{ status: number; body: IdentityIndexRunBody | IdentityIndexSkippedBody; failures: unknown[] }> {
  const lease = await acquireLeaseFailClosed(IDENTITY_INDEX_LEASE, IDENTITY_INDEX_LEASE_TTL_SECONDS);
  if (!lease.acquired) {
    return lease.reason === "held"
      ? { status: 200, body: { ok: true, skipped: "lease_held" }, failures: [] }
      : { status: 503, body: { ok: false, error: "lease_unverified" }, failures: [] };
  }
  try {
    return await runHoldingLease(input);
  } finally {
    await lease.release();
  }
}

async function runHoldingLease(input: {
  maxBlocks: bigint;
  segmentBlocks?: bigint;
  timeBudgetMs?: number;
  hardStopMs?: number;
  writeDeadlineMs?: number;
  now?: () => number;
}): Promise<{ status: number; body: IdentityIndexRunBody; failures: unknown[] }> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const stateTimeBudget = Math.min(input.timeBudgetMs ?? DEFAULT_STATE_TIME_BUDGET_MS, DEFAULT_STATE_TIME_BUDGET_MS);
  const ownerShared = {
    maxBlocks: input.maxBlocks,
    segmentBlocks: input.segmentBlocks,
    timeBudgetMs: input.timeBudgetMs,
    hardStopMs: input.hardStopMs,
    writeDeadlineMs: input.writeDeadlineMs,
    startedAt,
    deps: { now },
  };
  const stateShared = {
    timeBudgetMs: stateTimeBudget,
    startedAt,
    deps: { now, env: process.env },
  };

  const [owner, states, solana] = await Promise.allSettled([
    indexOwnerAgents(ownerShared),
    indexErc8004StateChains(stateShared),
    indexErc8004SolanaChains({ timeBudgetMs: stateTimeBudget, startedAt, deps: { now } }),
  ]);

  const ownerResult = owner.status === "fulfilled" ? owner.value : null;
  const stateResults = states.status === "fulfilled" ? states.value : [];
  const solanaResults = solana.status === "fulfilled" ? solana.value : [];
  const baseState = stateResults.find((r) => r.chain === "eip155:8453");
  const walletResult = baseState ? stateToWalletResult(baseState) : { error: message(states.status === "rejected" ? states.reason : "state_index_missing") };

  const errors = [
    owner.status === "rejected" ? `owner: ${message(owner.reason)}` : null,
    states.status === "rejected" ? `state: ${message(states.reason)}` : null,
    solana.status === "rejected" ? `solana8004: ${message(solana.reason)}` : null,
  ].filter((e): e is string => e !== null);

  const body: IdentityIndexRunBody = {
    ok: errors.length === 0,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
    ...(ownerResult ?? {}),
    caughtUp: Boolean(ownerResult?.caughtUp && "caughtUp" in walletResult && walletResult.caughtUp),
    ownerCaughtUp: ownerResult?.caughtUp ?? false,
    stoppedByBudget: [
      ownerResult?.stoppedBy,
      "stoppedBy" in walletResult ? walletResult.stoppedBy : undefined,
      ...stateResults.map((s) => (s.status === "ok" ? s.stoppedBy : undefined)),
    ].some((s) => s !== undefined && BUDGET_STOPS.has(s)),
    blocksAdvanced: {
      owner: ownerResult?.blocksAdvanced ?? 0,
      wallet: "blocksAdvanced" in walletResult ? walletResult.blocksAdvanced : 0,
    },
    walletIndex: walletResult,
    chainIndexes: stateResults,
    stateIndexes: stateResults,
    solanaIndexes: solanaResults,
  };

  return {
    status: errors.length === 0 ? 200 : 500,
    body,
    failures: [owner, states, solana].flatMap((r) => (r.status === "rejected" ? [r.reason] : [])),
  };
}