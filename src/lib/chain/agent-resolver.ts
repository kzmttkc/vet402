import { parseAbiItem, type Address } from "viem";
import { getLogsChunked, getLogsChunkSize } from "@/lib/chain/chunked-logs";
import { isSkipChainReadsEnabled } from "@/lib/config/env";
import {
  agentResolveTailMaxBlocks,
  planAgentResolveScan,
  planTailSnapshotUse,
  type AgentResolvePlan,
} from "./agent-resolve-window";
import { readCanonicalAgentWallet } from "./agent-wallet";
import { chainById, DEFAULT_CHAIN_ID } from "./chains";
import { getLogScanClient, getPublicClient, isValidAddress } from "./client";
import { ERC8004_ADDRESSES } from "./config";
import { findIndexedAgentIdsByWallet } from "@/lib/db/agent-wallet-index";
import {
  AGENT_WALLET_INDEX_CHECKPOINT,
  getIndexerCheckpoint,
  getOwnerAgentCountFromIndex,
  OWNER_INDEX_CHECKPOINT,
} from "@/lib/db/owner-index";
import { walletsMatch } from "@/lib/scoring/helpers";
import { LruCache } from "@/lib/util/lru-cache";

const walletSetEvent = parseAbiItem(
  "event WalletSet(uint256 indexed agentId, address indexed wallet)",
);
const registeredEvent = parseAbiItem(
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
);

const resolverCache = new LruCache<string, { agentId: bigint | null; expiresAt: number }>(5000);
const RESOLVER_POSITIVE_TTL_MS = 60 * 60 * 1000;
const RESOLVER_NEGATIVE_TTL_MS = 5 * 60 * 1000;

type IdentityRegistryLog = {
  args: {
    agentId?: bigint;
    owner?: Address;
    wallet?: Address;
  };
};

function agentIdFromLog(log: IdentityRegistryLog): bigint | undefined {
  return log.args.agentId;
}

const identityOwnerAbi = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const identityBalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function isLikelyMissingTokenError(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error).toLowerCase();
  return (
    message.includes("reverted") ||
    message.includes("nonexistent") ||
    message.includes("invalid token") ||
    message.includes("owner query for nonexistent")
  );
}

/**
 * Wallet used to bind a candidate agentId during resolve:
 * prefer getAgentWallet; else NFT owner (Registered-as-owner path).
 * Throws on RPC failure so callers do not negative-cache as "no agent".
 */
async function resolveWalletForAgent(agentId: bigint): Promise<Address | null> {
  const canonical = await readCanonicalAgentWallet(agentId);
  if (canonical) return canonical;

  const client = getPublicClient();
  try {
    const owner = await client.readContract({
      address: ERC8004_ADDRESSES.identityRegistry,
      abi: identityOwnerAbi,
      functionName: "ownerOf",
      args: [agentId],
    });

    if (isValidAddress(owner)) {
      return owner as Address;
    }
    return null;
  } catch (error) {
    if (isLikelyMissingTokenError(error)) return null;
    throw new Error("agent_resolve_unavailable", { cause: error });
  }
}

/**
 * 候補 agentId をオンチェーンの束縛ウォレットで照合し、確定した1件を返す。
 *
 * 新しい agentId から見るのは、同じウォレットが再登録されている場合に最新の
 * 束縛を採るため。照合中の RPC 失敗は握り潰さず伝播させる——ここで null を
 * 返すと「エージェントではない」が負のキャッシュに入り、実在のエージェントを
 * 静かに素のウォレットへ降格させてしまう。
 */
export async function resolveFromCandidates(
  wallet: Address,
  candidates: Iterable<bigint>,
  walletForAgent: (agentId: bigint) => Promise<Address | null>,
): Promise<bigint | null> {
  const sorted = [...candidates].sort((a, b) => (a > b ? -1 : 1));

  for (const agentId of sorted) {
    const boundWallet = await walletForAgent(agentId);
    if (boundWallet && walletsMatch(boundWallet, wallet)) return agentId;
  }

  return null;
}

export function invalidateResolverCache(wallet?: string): void {
  if (!wallet) {
    for (const key of resolverCache.keys()) {
      resolverCache.delete(key);
    }
    return;
  }
  resolverCache.delete(wallet.toLowerCase());
}

/**
 * 索引の到達点から、実走査すべき tail を決める。
 *
 * 二つの scope（所有者側 / ウォレット側）のうち**遅い方**が索引の実力である。
 * 片方だけ tip に届いていても、もう片方が空けている穴は候補の取りこぼしになる。
 * どちらか欠けていれば索引は無いものとして扱う。
 */
async function planTailFromCheckpoints(): Promise<AgentResolvePlan> {
  const blocksPerDay = chainById(DEFAULT_CHAIN_ID)?.blocksPerDay ?? 43_200;

  let tip: bigint;
  let ownerCheckpoint: bigint | null;
  let walletCheckpoint: bigint | null;
  try {
    [tip, ownerCheckpoint, walletCheckpoint] = await Promise.all([
      getLogScanClient().getBlockNumber(),
      getIndexerCheckpoint(OWNER_INDEX_CHECKPOINT),
      getIndexerCheckpoint(AGENT_WALLET_INDEX_CHECKPOINT),
    ]);
  } catch {
    throw new Error("agent_resolve_unavailable");
  }

  const checkpoint =
    ownerCheckpoint === null || walletCheckpoint === null
      ? null
      : ownerCheckpoint < walletCheckpoint
        ? ownerCheckpoint
        : walletCheckpoint;

  return planAgentResolveScan({
    checkpoint,
    tip,
    maxTailBlocks: agentResolveTailMaxBlocks(blocksPerDay),
  });
}

/**
 * 未索引 tail のスナップショット。
 *
 * tail 走査は「そのウォレットだけ」を引いても往復数は同じなので、ウォレット別に
 * 走らせると 42 件のベンチマークが同じ区間を 42 回舐めることになる。区間ごとに
 * 1 回だけ走らせて全ウォレット分の候補表を作り、短い TTL で共有する。
 *
 * TTL 中に伸びた tip ぶん（60秒＝Base で約30ブロック）は次の更新まで見えないが、
 * 解決結果自体すでに 5 分キャッシュされている（RESOLVER_NEGATIVE_TTL_MS）ので、
 * ここが新しい鮮度の下限を作ることはない。
 */
type TailSnapshot = {
  fromBlock: bigint;
  toBlock: bigint;
  byWallet: Map<string, bigint[]>;
  expiresAt: number;
};

let tailSnapshot: TailSnapshot | null = null;
const TAIL_SNAPSHOT_TTL_MS = 60_000;
/** erc8004 のライブ tail と同じ考え方の上限。超過は「答えない」に写す。 */
const TAIL_SCAN_DEADLINE_MS = 3_000;
const TAIL_SCAN_CONCURRENCY = 2;

function tailScanChunkBlocks(): bigint {
  const configured = getLogsChunkSize();
  return configured < 10_000n ? configured : 10_000n;
}

function addCandidate(map: Map<string, bigint[]>, address: Address | undefined, agentId: bigint) {
  if (!address || !isValidAddress(address)) return;
  const key = address.toLowerCase();
  const list = map.get(key);
  if (list) list.push(agentId);
  else map.set(key, [agentId]);
}

async function scanTailCandidates(
  fromBlock: bigint,
  toBlock: bigint,
  deadlineMs: number,
): Promise<Map<string, bigint[]>> {
  // ライブ RPC はこのデプロイでは eth_getLogs を返さない（2026-08-12）。
  // 走査は必ずログ用のエンドポイントへ向ける。
  const client = getLogScanClient();
  const chunk = tailScanChunkBlocks();

  const [walletSetLogs, registeredLogs] = await Promise.all([
    getLogsChunked(
      client,
      {
        address: ERC8004_ADDRESSES.identityRegistry,
        event: walletSetEvent,
        fromBlock,
        toBlock,
      },
      chunk,
      TAIL_SCAN_CONCURRENCY,
      { deadlineMs, delayMs: 0 },
    ) as Promise<IdentityRegistryLog[]>,
    getLogsChunked(
      client,
      {
        address: ERC8004_ADDRESSES.identityRegistry,
        event: registeredEvent,
        fromBlock,
        toBlock,
      },
      chunk,
      TAIL_SCAN_CONCURRENCY,
      { deadlineMs, delayMs: 0 },
    ) as Promise<IdentityRegistryLog[]>,
  ]);

  const byWallet = new Map<string, bigint[]>();
  for (const log of walletSetLogs) {
    const agentId = agentIdFromLog(log);
    if (agentId !== undefined) addCandidate(byWallet, log.args.wallet, agentId);
  }
  for (const log of registeredLogs) {
    const agentId = agentIdFromLog(log);
    if (agentId !== undefined) addCandidate(byWallet, log.args.owner, agentId);
  }
  return byWallet;
}

async function getTailSnapshot(
  fromBlock: bigint,
  toBlock: bigint,
  deadlineMs: number = TAIL_SCAN_DEADLINE_MS,
): Promise<TailSnapshot> {
  const blocksPerDay = chainById(DEFAULT_CHAIN_ID)?.blocksPerDay ?? 43_200;
  const use = planTailSnapshotUse({
    snapshot: tailSnapshot,
    fromBlock,
    toBlock,
    now: Date.now(),
    maxTailBlocks: agentResolveTailMaxBlocks(blocksPerDay),
  });

  if (use.kind === "reuse" && tailSnapshot) return tailSnapshot;

  if (use.kind === "extend" && tailSnapshot) {
    const base = tailSnapshot;
    const added = await scanTailCandidates(use.fromBlock, use.toBlock, deadlineMs);
    const byWallet = new Map<string, bigint[]>();
    for (const [key, ids] of base.byWallet) byWallet.set(key, [...ids]);
    for (const [key, ids] of added) {
      const list = byWallet.get(key);
      if (list) list.push(...ids);
      else byWallet.set(key, [...ids]);
    }
    tailSnapshot = {
      fromBlock: base.fromBlock,
      toBlock: use.toBlock,
      byWallet,
      expiresAt: Date.now() + TAIL_SNAPSHOT_TTL_MS,
    };
    return tailSnapshot;
  }

  const byWallet = await scanTailCandidates(fromBlock, toBlock, deadlineMs);
  tailSnapshot = { fromBlock, toBlock, byWallet, expiresAt: Date.now() + TAIL_SNAPSHOT_TTL_MS };
  return tailSnapshot;
}

/**
 * バッチ呼び出し（週次ベンチマーク）向け: 未索引 tail のスナップショットを
 * 長めの予算で先に1回だけ作る（2026-09-29）。
 *
 * ライブの1件は 3 秒の identity 予算で tail を舐めきれないことがある（Base の
 * 公開 RPC が 2,000 ブロック上限になってから）。待っている人間の居ない走行では、
 * 先に一度だけ時間をかけて作っておけば、以降の各件は reuse / 伸びた分の extend
 * だけで済む。ライブ経路の予算・fail-closed の規則は何も変えない。
 */
export async function warmAgentResolveTail(
  deadlineMs: number,
): Promise<"skipped" | "indexed_only" | "warmed" | "unavailable"> {
  if (isSkipChainReadsEnabled()) return "skipped";
  const plan = await planTailFromCheckpoints();
  if (plan.kind === "unavailable") return "unavailable";
  if (plan.kind === "indexed_only") return "indexed_only";
  await getTailSnapshot(plan.fromBlock, plan.toBlock, deadlineMs);
  return "warmed";
}

/**
 * wallet → agentId。索引が本体、未索引の境界だけを実走査する。
 *
 * WHAT CHANGED (2026-08-13). ここは identity registry を FROM_BLOCK から tip まで
 * 2 フィルタで走査していた——運用値で 1 ウォレットあたり約8,200往復。本番の
 * 1 invocation が捌ける実力は約250往復なので、この経路に入った瞬間に関数は
 * 時間切れで殺される。週次の benchmark-scan cron は毎回それを踏み、
 * trust_events に 1 行も書けないまま ok:true を返していた（本番の
 * benchmark_seed は史上0行）。有料の /api/v1/wallets/{address}/score も、
 * キャッシュに無いウォレットでは同じ理由でハングしていた。
 *
 * 走査そのものを消す以外に直し方は無い。候補は DB 索引（agents / owner_agents）
 * から取り、確定は従来どおりオンチェーンの束縛照合が行う。索引で届かない
 * 境界（checkpoint→tip）だけを短く走査し、それが「境界」と呼べる長さを超えて
 * いれば走査せず unavailable にする。取りこぼしは fail-OPEN 側の誤り
 * （エージェントが素のウォレットとして採点される）なので、覆えないなら
 * 答えないのが正しい。
 */
export async function resolveAgentIdByWallet(wallet: Address): Promise<bigint | null> {
  const cacheKey = wallet.toLowerCase();
  const cached = resolverCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.agentId;
  }

  if (isSkipChainReadsEnabled()) {
    return null;
  }

  let indexed: bigint[];
  try {
    indexed = await findIndexedAgentIdsByWallet(wallet);
  } catch {
    // 索引が読めない＝候補が無いのではなく分からない。負にキャッシュしない。
    throw new Error("agent_resolve_unavailable");
  }

  // 索引で当たれば tail 走査は要らない。確定はライブのオンチェーン照合なので、
  // 索引が古くても「当たった答え」は現在のチェーン状態と一致している。
  let resolved = await resolveFromCandidates(wallet, indexed, resolveWalletForAgent);

  if (resolved === null) {
    const plan = await planTailFromCheckpoints();
    if (plan.kind === "unavailable") {
      throw new Error("agent_resolve_unavailable");
    }
    if (plan.kind === "tail_scan") {
      let snapshot: TailSnapshot;
      try {
        snapshot = await getTailSnapshot(plan.fromBlock, plan.toBlock);
      } catch {
        throw new Error("agent_resolve_unavailable");
      }
      resolved = await resolveFromCandidates(
        wallet,
        snapshot.byWallet.get(cacheKey) ?? [],
        resolveWalletForAgent,
      );
    }
  }

  resolverCache.set(cacheKey, {
    agentId: resolved,
    expiresAt:
      Date.now() +
      (resolved !== null ? RESOLVER_POSITIVE_TTL_MS : RESOLVER_NEGATIVE_TTL_MS),
  });

  return resolved;
}

/** Authoritative ERC-721 ownership count — O(1), not pad-able via Transfer spam. */
async function balanceOfOwner(owner: Address): Promise<number> {
  const client = getPublicClient();
  const balance = await client.readContract({
    address: ERC8004_ADDRESSES.identityRegistry,
    abi: identityBalanceAbi,
    functionName: "balanceOf",
    args: [owner],
  });

  if (balance > BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Number(balance);
}

/**
 * Prefer ERC-721 balanceOf (authoritative). Cross-check with indexer when present.
 * Never trust a lagging index when live balanceOf is unavailable.
 */
export async function countAgentsByOwner(owner: Address): Promise<number> {
  if (isSkipChainReadsEnabled()) return 0;

  const indexed = await getOwnerAgentCountFromIndex(owner);

  try {
    const onChain = await balanceOfOwner(owner);
    if (indexed === null) return onChain;
    // Index can lag by a few blocks; never under-count vs live balanceOf.
    return Math.max(indexed, onChain);
  } catch {
    // Never trust a lagging index without live balanceOf — fail closed for enforcement.
    throw new Error("owner_count_unavailable");
  }
}
