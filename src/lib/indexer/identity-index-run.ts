import { indexAgentWallets, type AgentWalletIndexResult } from "./agent-wallet-indexer";
import { indexOwnerAgents, type OwnerIndexResult } from "./owner-indexer";

/**
 * `/api/cron/index-owners` の中身（2026-10-31）。所有者索引と WalletSet 索引を、同じ時計・同じ
 * 持ち時間で **並べて** 回す。
 *
 * 以前は所有者 → WalletSet の順に直列だった。所有者の側が持ち時間を食い切ると WalletSet は
 * 1 区切りも進まず、resolver は遅い方の checkpoint しか信じない（agent-resolver.ts の
 * planTailFromCheckpoints）ので、索引は全体として 1 ブロックも前へ出ない。並べれば、どちらも
 * 最初の区切りは必ず試し、それぞれが自分の進んだ所まで checkpoint を残す。
 *
 * 片方が throw しても、もう片方が進んだ分は書かれている。応答は 500 にするが、進んだ側の結果も載せる。
 */
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
} & Omit<Partial<OwnerIndexResult>, "blocksAdvanced" | "caughtUp">;

const BUDGET_STOPS = new Set(["time_budget", "hard_stop"]);

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

export async function runIdentityIndexes(input: {
  maxBlocks: bigint;
  segmentBlocks?: bigint;
  timeBudgetMs?: number;
  hardStopMs?: number;
  now?: () => number;
}): Promise<{ status: number; body: IdentityIndexRunBody; failures: unknown[] }> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const shared = {
    maxBlocks: input.maxBlocks,
    segmentBlocks: input.segmentBlocks,
    timeBudgetMs: input.timeBudgetMs,
    hardStopMs: input.hardStopMs,
    startedAt,
    deps: { now },
  };

  const [owner, wallet] = await Promise.allSettled([indexOwnerAgents(shared), indexAgentWallets(shared)]);

  const ownerResult = owner.status === "fulfilled" ? owner.value : null;
  const walletResult = wallet.status === "fulfilled" ? wallet.value : null;
  const errors = [
    owner.status === "rejected" ? `owner: ${message(owner.reason)}` : null,
    wallet.status === "rejected" ? `wallet: ${message(wallet.reason)}` : null,
  ].filter((e): e is string => e !== null);

  const body: IdentityIndexRunBody = {
    ok: errors.length === 0,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
    ...(ownerResult ?? {}),
    caughtUp: Boolean(ownerResult?.caughtUp && walletResult?.caughtUp),
    ownerCaughtUp: ownerResult?.caughtUp ?? false,
    stoppedByBudget: [ownerResult?.stoppedBy, walletResult?.stoppedBy].some((s) => s !== undefined && BUDGET_STOPS.has(s)),
    blocksAdvanced: { owner: ownerResult?.blocksAdvanced ?? 0, wallet: walletResult?.blocksAdvanced ?? 0 },
    walletIndex: walletResult ?? { error: message(wallet.status === "rejected" ? wallet.reason : "unknown") },
  };

  return {
    status: errors.length === 0 ? 200 : 500,
    body,
    failures: [owner, wallet].flatMap((r) => (r.status === "rejected" ? [r.reason] : [])),
  };
}
