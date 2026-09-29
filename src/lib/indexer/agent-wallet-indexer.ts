import { parseAbiItem, zeroAddress, type Address } from "viem";
import { getLogsChunked } from "@/lib/chain/chunked-logs";
import { getIndexerPublicClient, isValidAddress } from "@/lib/chain/client";
import { ERC8004_ADDRESSES, IDENTITY_REGISTRY_FROM_BLOCK } from "@/lib/chain/config";
import { upsertAgentWallet } from "@/lib/db/agent-wallet-index";
import {
  AGENT_WALLET_INDEX_CHECKPOINT,
  getIndexerCheckpoint,
  setIndexerCheckpoint,
} from "@/lib/db/owner-index";
import { mapWithConcurrency } from "@/lib/util/concurrency";
import { logServerInfoSafe } from "@/lib/util/log-safe";

/**
 * WalletSet 索引（2026-08-13）。
 *
 * owner_agents（Registered / Transfer）が所有者側を持つのに対し、こちらは
 * エージェントの運用ウォレット側を持つ。二つ揃って初めて
 * `resolveAgentIdByWallet` が RPC 走査なしで答えられる。
 *
 * 独立したチェックポイント scope を使う理由: owner 側の scope はすでに tip に
 * 到達しているので、同じ scope に相乗りすると WalletSet の履歴は永久に
 * 埋まらない。ここは FROM_BLOCK から前進する必要がある（デプロイ直後は
 * `scripts/catch-up-owner-index.sh` で追いつかせる）。
 */

const walletSetEvent = parseAbiItem(
  "event WalletSet(uint256 indexed agentId, address indexed wallet)",
);

/** owner-indexer と同じ理由の並列度——Neon HTTP の往復が支配的なので。 */
const WALLET_WRITE_CONCURRENCY = 15;

const DEFAULT_MAX_BLOCKS = 150_000n;

export type AgentWalletIndexResult = {
  fromBlock: string;
  toBlock: string;
  walletSetEvents: number;
  upserted: number;
  caughtUp: boolean;
};

type WalletSetLog = {
  args: { agentId?: bigint; wallet?: Address };
  blockNumber?: bigint | null;
  logIndex?: number | null;
};

/**
 * ログ群を agentId ごとに1件へ畳み込む。**最後の WalletSet が勝つ。**
 *
 * 貼り替え（同じ agentId に新しいウォレット）が同じ走査窓に2件入ることがあり、
 * 順序を取り違えると古い束縛が索引に残る。古い束縛は「他人のウォレットに
 * エージェントの実績が付く」という向きの誤りなので、ここは取りこぼしより重い。
 */
export function latestWalletPerAgent(
  logs: readonly WalletSetLog[],
): { agentId: bigint; wallet: Address }[] {
  const latest = new Map<string, { agentId: bigint; wallet: Address; block: bigint; index: number }>();

  for (const log of logs) {
    const agentId = log.args.agentId;
    const wallet = log.args.wallet;
    if (agentId === undefined) continue;
    if (!wallet || !isValidAddress(wallet) || wallet.toLowerCase() === zeroAddress) continue;

    const block = log.blockNumber ?? 0n;
    const index = log.logIndex ?? 0;
    const key = agentId.toString();
    const current = latest.get(key);
    if (current && (current.block > block || (current.block === block && current.index >= index))) {
      continue;
    }
    latest.set(key, { agentId, wallet, block, index });
  }

  return [...latest.values()].map(({ agentId, wallet }) => ({ agentId, wallet }));
}

export async function indexAgentWallets(options?: {
  maxBlocks?: bigint;
}): Promise<AgentWalletIndexResult> {
  const client = getIndexerPublicClient();
  const chainTip = await client.getBlockNumber();
  const fromBlock =
    (await getIndexerCheckpoint(AGENT_WALLET_INDEX_CHECKPOINT)) ?? IDENTITY_REGISTRY_FROM_BLOCK;

  const maxBlocks = options?.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const toBlock = fromBlock + maxBlocks > chainTip ? chainTip : fromBlock + maxBlocks;

  if (fromBlock > toBlock) {
    await setIndexerCheckpoint(AGENT_WALLET_INDEX_CHECKPOINT, chainTip, chainTip);
    return {
      fromBlock: fromBlock.toString(),
      toBlock: chainTip.toString(),
      walletSetEvents: 0,
      upserted: 0,
      caughtUp: true,
    };
  }

  const t0 = Date.now();
  const logs = (await getLogsChunked(client, {
    address: ERC8004_ADDRESSES.identityRegistry,
    event: walletSetEvent,
    fromBlock,
    toBlock,
  })) as unknown as WalletSetLog[];
  logServerInfoSafe("wallet-indexer", `walletSetLogs=${logs.length} in ${Date.now() - t0}ms`);

  const pairs = latestWalletPerAgent(logs);
  await mapWithConcurrency(pairs, WALLET_WRITE_CONCURRENCY, async ({ agentId, wallet }) => {
    await upsertAgentWallet(agentId, wallet);
  });

  const nextBlock = toBlock + 1n;
  const caughtUp = nextBlock > chainTip;
  await setIndexerCheckpoint(
    AGENT_WALLET_INDEX_CHECKPOINT,
    caughtUp ? chainTip : nextBlock,
    chainTip,
  );

  return {
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    walletSetEvents: logs.length,
    upserted: pairs.length,
    caughtUp,
  };
}
