// ============================================================
// ERC-8004 Identity Registry の Base 以外の索引（2026-11-10・要件 3.10）。
//
// 対象は Ethereum（eip155:1）と BNB Chain（eip155:56）。state API の erc8004.byChain で、
// この 2 つが not_indexed のまま残らないようにするための索引である。購入レーンではない
// （この鎖で買うことも、署名することも、送ることも無い）。新しいコントラクトも配備しない。
//
// 何を読むか。登録簿（ERC8004_ADDRESSES.identityRegistry。CREATE2 で全 EVM 本番が同じ番地）の
//   - ERC-721 Transfer: agent の持ち主。mint は 0 アドレスからの Transfer、burn は 0 アドレスへの Transfer。
//   - WalletSet: agentWallet（Base の agent-wallet-indexer と同じイベント）。
// 床（デプロイより前のブロック）から全部のログを読むので、持ち主は最後の Transfer の `to` で
// 決まる（ERC-721 の所有はイベントだけで決まる）。Base の owner-indexer のような ownerOf の照合は
// 要らない。床がデプロイより後だと mint を取りこぼすので、床は控えめ（早め）に置く。
//
// どこで読むか。cron の /api/cron/index-owners（runIdentityIndexes）の中だけ。リクエストの経路は
// DB だけを読む（erc8004-match.ts）。鎖ごとの RPC の環境変数が無ければ、読まず・書かず・
// checkpoint も動かさず skipped を返す（公開 RPC へ黙って倒れない。index-evm.ts の決済索引と同じ）。
//
// 床（要確認）。Ethereum は chains.ts の registryFromBlock（20,000,000）。BNB Chain は 50,000,000。
// どちらも ERC-8004 の仕様が出る前のブロックとして置いた見積もりで、デプロイのブロックは
// この作業では RPC を引いていないので測っていない。測ったら ERC8004_ETHEREUM_FROM_BLOCK /
// ERC8004_BNB_FROM_BLOCK で上書きする（効くのは checkpoint が無い最初の回だけ）。
// ============================================================
import { createPublicClient, http, parseAbiItem, zeroAddress, type Address, type Chain } from "viem";
import { bsc, mainnet } from "viem/chains";
import type { base } from "viem/chains";
import { getLogsChunked } from "@/lib/chain/chunked-logs";
import { isValidAddress } from "@/lib/chain/client";
import { CHAINS } from "@/lib/chain/chains";
import { ERC8004_ADDRESSES } from "@/lib/chain/config";
import { getIndexerCheckpoint, setIndexerCheckpoint } from "@/lib/db/owner-index";
import {
  applyErc8004ChainAgentChanges,
  erc8004ChainCheckpointScope,
  type Erc8004ChainAgentChanges,
  type Erc8004ExtraChain,
} from "@/lib/db/erc8004-chain-index";
import { logServerInfoSafe, logServerWarnSafe } from "@/lib/util/log-safe";
import { runSegmentedScan, scanStopReason, type SegmentedScanOptions } from "./segmented-scan";

const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)");
const walletSetEvent = parseAbiItem("event WalletSet(uint256 indexed agentId, address indexed wallet)");

export type Erc8004ChainTarget = {
  caip2: Erc8004ExtraChain;
  chainId: number;
  /** 読み先の環境変数。無ければ skipped。 */
  rpcEnv: string;
  /** 床の上書き（checkpoint が無い最初の回だけ効く）。 */
  fromBlockEnv: string;
  defaultFromBlock: bigint;
  /** tip から引くブロック数（組み替えで消える Transfer を索引に残さない）。 */
  confirmations: bigint;
  viemChain: Chain;
};

export const ERC8004_CHAIN_TARGETS: readonly Erc8004ChainTarget[] = [
  {
    caip2: "eip155:1",
    chainId: 1,
    rpcEnv: "ETHEREUM_RPC_URL",
    fromBlockEnv: "ERC8004_ETHEREUM_FROM_BLOCK",
    defaultFromBlock: CHAINS[1]!.registryFromBlock,
    // 2 epoch（約 12.8 分）。
    confirmations: 64n,
    viemChain: mainnet,
  },
  {
    caip2: "eip155:56",
    chainId: 56,
    rpcEnv: "BNB_RPC_URL",
    fromBlockEnv: "ERC8004_BNB_FROM_BLOCK",
    defaultFromBlock: 50_000_000n,
    // 決済索引（index-evm.ts）の BNB と同じ 64。
    confirmations: 64n,
    viemChain: bsc,
  },
];

/** 区切りは checkpoint の粒度だけを決める（RPC の 1 要求の幅は getLogsChunked が決める）。 */
const DEFAULT_SEGMENT_BLOCKS = 100_000n;
const DEFAULT_MAX_BLOCKS = 1_000_000n;

type TransferLog = {
  eventName?: string;
  args: { from?: Address; to?: Address; tokenId?: bigint };
  blockNumber?: bigint | null;
  logIndex?: number | null;
};
type WalletSetLog = {
  eventName?: string;
  args: { agentId?: bigint; wallet?: Address };
  blockNumber?: bigint | null;
  logIndex?: number | null;
};

function chainOrder(a: { blockNumber?: bigint | null; logIndex?: number | null }, b: { blockNumber?: bigint | null; logIndex?: number | null }) {
  const ab = a.blockNumber ?? 0n;
  const bb = b.blockNumber ?? 0n;
  if (ab !== bb) return ab < bb ? -1 : 1;
  return (a.logIndex ?? 0) - (b.logIndex ?? 0);
}

/**
 * 1 区切りのログを、agentId ごとの最後の形に畳む。並びはチェーンの順（ブロック・logIndex）。
 *  - owner: 最後の Transfer の `to`（小文字）。`to` が 0 アドレスなら燃やされた（行を消す）。
 *  - wallet: 最後の WalletSet。0 アドレスは束縛なし（null）。燃やされた agent の wallet は書かない。
 * 比べるのはアドレスだけで、名前も登録ファイルも読まない。
 */
export function foldErc8004ChainLogs(
  transfers: readonly TransferLog[],
  walletSets: readonly WalletSetLog[],
): { changes: Erc8004ChainAgentChanges; transferEvents: number; walletSetEvents: number } {
  const owner = new Map<string, { agentId: bigint; owner: string | "burned" }>();
  for (const log of [...transfers].sort(chainOrder)) {
    const { tokenId, to } = log.args;
    if (tokenId === undefined) continue;
    const burned = !to || !isValidAddress(to) || to.toLowerCase() === zeroAddress;
    owner.set(tokenId.toString(), { agentId: tokenId, owner: burned ? "burned" : to.toLowerCase() });
  }

  const wallet = new Map<string, { agentId: bigint; wallet: string | null }>();
  for (const log of [...walletSets].sort(chainOrder)) {
    const { agentId, wallet: w } = log.args;
    if (agentId === undefined) continue;
    const unset = !w || !isValidAddress(w) || w.toLowerCase() === zeroAddress;
    wallet.set(agentId.toString(), { agentId, wallet: unset ? null : w.toLowerCase() });
  }

  const changes: Erc8004ChainAgentChanges = { owners: [], wallets: [], burned: [] };
  for (const o of owner.values()) {
    if (o.owner === "burned") changes.burned.push(o.agentId);
    else changes.owners.push({ agentId: o.agentId, owner: o.owner });
  }
  for (const [key, w] of wallet) {
    if (owner.get(key)?.owner === "burned") continue;
    changes.wallets.push(w);
  }
  return { changes, transferEvents: transfers.length, walletSetEvents: walletSets.length };
}

type ChainClient = Parameters<typeof getLogsChunked>[0];

export type Erc8004ChainIndexDeps = {
  now: () => number;
  env: Record<string, string | undefined>;
  makeClient: (target: Erc8004ChainTarget, rpcUrl: string) => ChainClient;
  getCheckpoint: (scope: string) => Promise<bigint | null>;
  setCheckpoint: (scope: string, lastBlock: bigint, chainTip: bigint) => Promise<void>;
  applyChanges: (chainId: number, changes: Erc8004ChainAgentChanges, options?: { shouldStop?: () => boolean }) => Promise<void>;
};

function defaultMakeClient(target: Erc8004ChainTarget, rpcUrl: string): ChainClient {
  return createPublicClient({
    // 型は Base のクライアントに合わせる（chain/bnb.ts と同じ理由。使うのは chain 非依存の read 面だけ）。
    chain: target.viemChain as unknown as typeof base,
    transport: http(rpcUrl, { timeout: 20_000, retryCount: 3 }),
  }) as unknown as ChainClient;
}

export type Erc8004ChainIndexResult =
  | { chain: Erc8004ExtraChain; status: "skipped"; reason: string }
  | { chain: Erc8004ExtraChain; status: "error"; error: string }
  | {
      chain: Erc8004ExtraChain;
      status: "ok";
      fromBlock: string;
      /** 最後に読み終えて書き終えたブロック（= この回の後の checkpoint）。 */
      toBlock: string;
      transferEvents: number;
      walletSetEvents: number;
      ownersWritten: number;
      walletsWritten: number;
      burned: number;
      caughtUp: boolean;
      blocksAdvanced: number;
      segments: number;
      partial: boolean;
      stoppedBy?: string;
    };

function floorOf(target: Erc8004ChainTarget, env: Record<string, string | undefined>): bigint {
  const raw = env[target.fromBlockEnv]?.trim();
  return raw && /^\d+$/.test(raw) ? BigInt(raw) : target.defaultFromBlock;
}

export async function indexErc8004Chain(
  target: Erc8004ChainTarget,
  options?: { maxBlocks?: bigint; deps?: Partial<Erc8004ChainIndexDeps> } & Omit<SegmentedScanOptions, "now">,
): Promise<Erc8004ChainIndexResult> {
  const env = options?.deps?.env ?? process.env;
  const rpcUrl = env[target.rpcEnv]?.trim();
  if (!rpcUrl) return { chain: target.caip2, status: "skipped", reason: `${target.rpcEnv}_unset` };

  const now = options?.deps?.now ?? Date.now;
  const getCheckpoint = options?.deps?.getCheckpoint ?? getIndexerCheckpoint;
  const setCheckpoint = options?.deps?.setCheckpoint ?? setIndexerCheckpoint;
  const applyChanges = options?.deps?.applyChanges ?? applyErc8004ChainAgentChanges;
  const client = (options?.deps?.makeClient ?? defaultMakeClient)(target, rpcUrl);
  const scope = erc8004ChainCheckpointScope(target.caip2);
  const startedAt = options?.startedAt ?? now();

  const tip = await client.getBlockNumber();
  const safeTip = tip > target.confirmations ? tip - target.confirmations : 0n;
  const existing = await getCheckpoint(scope);
  // checkpoint は「最後に読み終えたブロック」。そのブロックから読み直す（owner-indexer と同じ。
  // 1 ブロックの読み直しは同じ形を書くだけ）。
  const fromBlock = existing ?? floorOf(target, env);
  const maxBlocks = options?.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const toBlock = fromBlock + maxBlocks > safeTip ? safeTip : fromBlock + maxBlocks;

  if (fromBlock > toBlock) {
    return {
      chain: target.caip2,
      status: "ok",
      fromBlock: fromBlock.toString(),
      toBlock: (existing ?? fromBlock).toString(),
      transferEvents: 0,
      walletSetEvents: 0,
      ownersWritten: 0,
      walletsWritten: 0,
      burned: 0,
      caughtUp: true,
      blocksAdvanced: 0,
      segments: 0,
      partial: false,
    };
  }

  const totals = { transferEvents: 0, walletSetEvents: 0, ownersWritten: 0, walletsWritten: 0, burned: 0 };
  type Payload = ReturnType<typeof foldErc8004ChainLogs>;

  const scan = await runSegmentedScan<Payload>({
    fromBlock,
    toBlock,
    options: { ...options, segmentBlocks: options?.segmentBlocks ?? DEFAULT_SEGMENT_BLOCKS, now, startedAt },
    read: async (from, maxTo, clock) => {
      const logs = (await clock.within(
        (remainingMs) =>
          getLogsChunked(
            client,
            {
              address: ERC8004_ADDRESSES.identityRegistry,
              events: [transferEvent, walletSetEvent],
              fromBlock: from,
              toBlock: maxTo,
            } as Parameters<typeof getLogsChunked>[1],
            undefined,
            undefined,
            { deadlineMs: remainingMs },
          ),
        `erc8004-chain-indexer.${target.caip2}`,
      )) as unknown as (TransferLog | WalletSetLog)[];
      const transfers = logs.filter((l): l is TransferLog => l.eventName === "Transfer");
      const walletSets = logs.filter((l): l is WalletSetLog => l.eventName === "WalletSet");
      return { lastBlock: maxTo, payload: foldErc8004ChainLogs(transfers, walletSets) };
    },
    write: async ({ payload }, control) => {
      const { changes } = payload;
      if (changes.owners.length + changes.wallets.length + changes.burned.length > 0) {
        await applyChanges(target.chainId, changes, { shouldStop: control.shouldStop });
      }
      totals.transferEvents += payload.transferEvents;
      totals.walletSetEvents += payload.walletSetEvents;
      totals.ownersWritten += changes.owners.length;
      totals.walletsWritten += changes.wallets.length;
      totals.burned += changes.burned.length;
    },
    checkpoint: (lastBlock) => setCheckpoint(scope, lastBlock, tip),
  });

  const partial = scan.stoppedBy !== undefined;
  logServerInfoSafe(
    "erc8004-chain-indexer",
    `${target.caip2} blocks=${fromBlock}-${scan.scannedTo} segments=${scan.segments}` +
      ` transfers=${totals.transferEvents} walletSet=${totals.walletSetEvents}`,
  );
  if (partial) {
    logServerWarnSafe("erc8004-chain-indexer.partial", `${target.caip2} stopped at ${scan.scannedTo} of ${toBlock}: ${scan.stoppedBy}`);
  }

  const before = existing ?? fromBlock;
  return {
    chain: target.caip2,
    status: "ok",
    fromBlock: fromBlock.toString(),
    toBlock: scan.scannedTo.toString(),
    ...totals,
    caughtUp: scan.scannedTo >= safeTip,
    blocksAdvanced: scan.scannedTo > before ? Number(scan.scannedTo - before) : 0,
    segments: scan.segments,
    partial,
    ...(scan.stoppedBy !== undefined ? { stoppedBy: scan.stoppedBy } : {}),
  };
}

/**
 * 2 つの鎖を並べて回す。片方が投げても、もう片方の進んだ分は残る。投げた理由は URL と秘密を
 * 伏せた 1 行にして返す（scanStopReason）。この結果は Base の caughtUp・ok を動かさない。
 */
export async function indexErc8004Chains(
  options?: { maxBlocks?: bigint; deps?: Partial<Erc8004ChainIndexDeps> } & Omit<SegmentedScanOptions, "now">,
): Promise<Erc8004ChainIndexResult[]> {
  const settled = await Promise.allSettled(ERC8004_CHAIN_TARGETS.map((t) => indexErc8004Chain(t, options)));
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { chain: ERC8004_CHAIN_TARGETS[i]!.caip2, status: "error" as const, error: scanStopReason(r.reason) },
  );
}
