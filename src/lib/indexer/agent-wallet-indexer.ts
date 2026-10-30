import { parseAbiItem, zeroAddress, type Address } from "viem";
import { getLogsChunked } from "@/lib/chain/chunked-logs";
import { getIndexerPublicClient, isValidAddress } from "@/lib/chain/client";
import { ERC8004_ADDRESSES, IDENTITY_REGISTRY_FROM_BLOCK } from "@/lib/chain/config";
import { upsertAgentWallets } from "@/lib/db/agent-wallet-index";
import {
  AGENT_WALLET_INDEX_CHECKPOINT,
  getIndexerCheckpoint,
  setIndexerCheckpoint,
} from "@/lib/db/owner-index";
import { logServerInfoSafe, logServerWarnSafe } from "@/lib/util/log-safe";
import { runSegmentedScan, type SegmentedScanOptions } from "./segmented-scan";

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

const DEFAULT_MAX_BLOCKS = 150_000n;

export type AgentWalletIndexResult = {
  fromBlock: string;
  /** 最後に読み終えて書き終えたブロック（= この回の後の checkpoint）。 */
  toBlock: string;
  walletSetEvents: number;
  upserted: number;
  caughtUp: boolean;
  /** この回に checkpoint が進んだブロック数。 */
  blocksAdvanced: number;
  segments: number;
  /** 予算・上限・読み先の失敗で、tip（または maxBlocks の端）の手前で止まった回。 */
  partial: boolean;
  /** partial のときだけ: `time_budget`・`hard_stop`・`rpc:<読み先の言い分>`。 */
  stoppedBy?: string;
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

/** テストの差し替え口。本番は Date.now。 */
export type AgentWalletIndexDeps = { now: () => number };

/**
 * 2026-10-31: 区切りごとに「読む → 書く → checkpoint」へ（segmented-scan.ts）。以前は
 * 1 回の範囲を読み切ってから書き、checkpoint は最後に 1 回だった（owner-indexer と同じ穴）。
 * WalletSet は少ない（10/8〜10/31 の 98 万ブロックで 0 件・10/31 実測）ので、1 区切りは
 * ほぼ読み取りの時間（20,000 ブロックで約 2 秒）。
 */
export async function indexAgentWallets(
  options?: { maxBlocks?: bigint; deps?: Partial<AgentWalletIndexDeps> } & Omit<SegmentedScanOptions, "now">,
): Promise<AgentWalletIndexResult> {
  const client = getIndexerPublicClient();
  const now = options?.deps?.now ?? Date.now;
  const startedAt = options?.startedAt ?? now();
  const chainTip = await client.getBlockNumber();
  const existing = await getIndexerCheckpoint(AGENT_WALLET_INDEX_CHECKPOINT);
  // checkpoint は「最後に読み終えたブロック」。そのブロックから読み直す（owner-indexer と同じ）。
  const fromBlock = existing ?? IDENTITY_REGISTRY_FROM_BLOCK;

  const maxBlocks = options?.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const toBlock = fromBlock + maxBlocks > chainTip ? chainTip : fromBlock + maxBlocks;

  if (fromBlock > toBlock) {
    await setIndexerCheckpoint(AGENT_WALLET_INDEX_CHECKPOINT, chainTip, chainTip);
    return {
      fromBlock: fromBlock.toString(),
      toBlock: (existing ?? chainTip).toString(),
      walletSetEvents: 0,
      upserted: 0,
      caughtUp: true,
      blocksAdvanced: 0,
      segments: 0,
      partial: false,
    };
  }

  let walletSetEvents = 0;
  let upserted = 0;
  const t0 = now();

  const scan = await runSegmentedScan<{ pairs: { agentId: bigint; wallet: Address }[]; events: number }>({
    fromBlock,
    toBlock,
    options: { ...options, now, startedAt },
    read: async (from, maxTo, clock) => {
      const logs = (await clock.within(
        (remainingMs) =>
          getLogsChunked(
            client,
            { address: ERC8004_ADDRESSES.identityRegistry, event: walletSetEvent, fromBlock: from, toBlock: maxTo },
            undefined,
            undefined,
            { deadlineMs: remainingMs },
          ),
        "wallet-indexer.walletSet",
      )) as unknown as WalletSetLog[];
      // 区切りの中は最後の WalletSet が勝つ。区切りをまたぐ貼り替えは、後の区切りが後で書くので後が勝つ。
      return { lastBlock: maxTo, payload: { pairs: latestWalletPerAgent(logs), events: logs.length } };
    },
    write: async ({ payload }, control) => {
      await upsertAgentWallets(payload.pairs, { shouldStop: control.shouldStop });
      walletSetEvents += payload.events;
      upserted += payload.pairs.length;
    },
    checkpoint: (lastBlock) => setIndexerCheckpoint(AGENT_WALLET_INDEX_CHECKPOINT, lastBlock, chainTip),
  });

  const caughtUp = scan.scannedTo >= chainTip;
  const partial = scan.stoppedBy !== undefined;
  logServerInfoSafe(
    "wallet-indexer",
    `blocks=${fromBlock}-${scan.scannedTo} segments=${scan.segments} walletSetLogs=${walletSetEvents} in ${now() - t0}ms`,
  );
  if (partial) {
    logServerWarnSafe("wallet-indexer.partial", `stopped at ${scan.scannedTo} of ${toBlock} (tip ${chainTip}): ${scan.stoppedBy}`);
  }

  const before = existing ?? fromBlock;
  return {
    fromBlock: fromBlock.toString(),
    toBlock: scan.scannedTo.toString(),
    walletSetEvents,
    upserted,
    caughtUp,
    blocksAdvanced: scan.scannedTo > before ? Number(scan.scannedTo - before) : 0,
    segments: scan.segments,
    partial,
    ...(scan.stoppedBy !== undefined ? { stoppedBy: scan.stoppedBy } : {}),
  };
}
