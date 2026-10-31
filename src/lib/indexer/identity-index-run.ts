import { acquireLeaseFailClosed } from "@/lib/cron/lease-fail-closed";
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
 *
 * 同時に走るのは 1 本だけ（2026-10-31 レビュー M-2）。cron と catch-up スクリプトが重なると、遅れて
 * 走る側が古い区切りの WalletSet を書き戻し（upsert は後に書いた方が勝つ）、checkpoint は GREATEST で
 * 先の方に残るので、その巻き戻りは二度と直らない。l1-purchase・index-settlements と同じ job_leases の
 * 1 文の lease（acquireLeaseFailClosed）を取り、取れなければ何も読まず書かずに lease_held を返す。
 * lease の期限 330 秒は maxDuration（300 秒）より長い。殺された回の lease は期限で切れる。
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
} & Omit<Partial<OwnerIndexResult>, "blocksAdvanced" | "caughtUp">;

const BUDGET_STOPS = new Set(["time_budget", "hard_stop", "write_deadline"]);

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
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
    // 自分の holder の行だけ消す（期限切れの後に他の回が取り直していたら触らない）。
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
  const shared = {
    maxBlocks: input.maxBlocks,
    segmentBlocks: input.segmentBlocks,
    timeBudgetMs: input.timeBudgetMs,
    hardStopMs: input.hardStopMs,
    writeDeadlineMs: input.writeDeadlineMs,
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
