// ============================================================
// ERC-8004 の Base 以外の索引（2026-11-10・要件 3.10）の書き込み口と checkpoint の scope。
//
// 対象は Ethereum（chain_id 1）と BNB Chain（chain_id 56）。書くのは索引のジョブ
// （src/lib/indexer/erc8004-chain-indexer.ts）だけ。読むのは state API の erc8004
// （src/lib/observatory/erc8004-match.ts・DB だけ）。owner_agents（Base）は触らない。
//
// 1 区切りの変更は agentId ごとの最後の形に畳んである（foldErc8004ChainLogs）。書く順は
// owner の upsert → agentWallet の upsert → 燃やされた agent の削除。途中で止まっても
// checkpoint は進まないので、次の回が同じ区切りを読み直して同じ形に書く（冪等）。
// ============================================================
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./client";
import { erc8004ChainAgents } from "./schema";
import { DeadlineExceededError } from "@/lib/util/deadline";

/** state API の erc8004.byChain で Base の隣に出す 2 つの鎖。並びは公開の順。 */
export const ERC8004_EXTRA_CHAINS = ["eip155:1", "eip155:56"] as const;
export type Erc8004ExtraChain = (typeof ERC8004_EXTRA_CHAINS)[number];

/** indexer_checkpoints の scope。Base の `identity_registry` と並ぶ、鎖ごとの到達点。 */
export function erc8004ChainCheckpointScope(caip2: Erc8004ExtraChain): string {
  return `identity_registry:${caip2}`;
}

export type Erc8004ChainAgentChanges = {
  /** 小文字の owner。最後の Transfer の `to`。 */
  owners: { agentId: bigint; owner: string }[];
  /** 最後の WalletSet。null は束縛なし（0 アドレス）。 */
  wallets: { agentId: bigint; wallet: string | null }[];
  /** 0 アドレスへ移った（燃やされた）agent。行を消す。 */
  burned: bigint[];
};

const BATCH = 500;

export async function applyErc8004ChainAgentChanges(
  chainId: number,
  changes: Erc8004ChainAgentChanges,
  options?: { shouldStop?: () => boolean },
): Promise<void> {
  const db = getDb();
  if (!db) return;
  const guard = () => {
    // 期限を過ぎたら次の文を始めない（segmented-scan.ts の書き込みの期限）。
    if (options?.shouldStop?.()) throw new DeadlineExceededError("erc8004-chain-index", 0);
  };

  for (let i = 0; i < changes.owners.length; i += BATCH) {
    guard();
    const now = new Date();
    await db
      .insert(erc8004ChainAgents)
      .values(
        changes.owners.slice(i, i + BATCH).map((o) => ({ chainId, agentId: o.agentId, owner: o.owner.toLowerCase(), updatedAt: now })),
      )
      .onConflictDoUpdate({
        target: [erc8004ChainAgents.chainId, erc8004ChainAgents.agentId],
        set: { owner: sql`excluded.owner`, updatedAt: now },
      });
  }

  for (let i = 0; i < changes.wallets.length; i += BATCH) {
    guard();
    const now = new Date();
    await db
      .insert(erc8004ChainAgents)
      .values(
        changes.wallets
          .slice(i, i + BATCH)
          .map((w) => ({ chainId, agentId: w.agentId, wallet: w.wallet === null ? null : w.wallet.toLowerCase(), updatedAt: now })),
      )
      .onConflictDoUpdate({
        target: [erc8004ChainAgents.chainId, erc8004ChainAgents.agentId],
        set: { wallet: sql`excluded.wallet`, updatedAt: now },
      });
  }

  for (let i = 0; i < changes.burned.length; i += BATCH) {
    guard();
    await db
      .delete(erc8004ChainAgents)
      .where(and(eq(erc8004ChainAgents.chainId, chainId), inArray(erc8004ChainAgents.agentId, changes.burned.slice(i, i + BATCH))));
  }
}
