import { type Address, isAddress, parseAbi, parseAbiItem, zeroAddress } from "viem";
import { isSkipChainReadsEnabled } from "@/lib/config/env";
import { getIndexedFeedbackWindow } from "@/lib/db/feedback-index";
import { getLogsChunked, getLogsChunkSize } from "./chunked-logs";
import { getLogScanClient, getPublicClient } from "./client";
import { ERC8004_ADDRESSES, IDENTITY_REGISTRY_FROM_BLOCK } from "./config";
import { DEFAULT_CHAIN_ID, chainById } from "./chains";
import {
  feedbackUnavailableMessage,
  feedbackWindowFromBlock,
  planFeedbackSources,
  summarizeFeedback,
  tailMaxBlocks,
  type FeedbackEntry,
  type RecentFeedbackStats,
} from "./feedback-window";

const identityRegistryAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function totalSupply() view returns (uint256)",
]);

/**
 * ReputationRegistry ABI — corrected 2026-08-12 against the DEPLOYED contract.
 *
 * The previous signature took `bytes32 tag1, bytes32 tag2`. The registry at
 * 0x8004BAa1… (ERC-1967 proxy → 0x16e0fa7f…) has no such function: its
 * selector 0x31259cff is absent from the implementation bytecode, so EVERY
 * call reverted, for every agent, since the feature shipped. The engine
 * faithfully converted that into `reputation_summary_unavailable`, which
 * assessSybilRisk maps to high risk → BLOCK. That is why every score on the
 * site read 3/BLOCK: not a rate limit, not a timeout, an ABI that never
 * matched the chain.
 *
 * The deployed function is 0x81bbba58 — tags are `string`, not `bytes32`. It
 * also rejects an empty client list ("clientAddresses required"), so the
 * caller must supply one; getClients() is the registry's own accessor for it.
 *
 * Verified on Base mainnet: agent 1 → 20 clients, count=39, avg 81.
 */
const reputationRegistryAbi = parseAbi([
  "function getClients(uint256 agentId) view returns (address[])",
  "function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)",
]);

export type AgentIdentity = {
  agentId: bigint;
  owner: Address | null;
  agentWallet: Address | null;
  tokenUri: string | null;
  registered: boolean;
};

export async function fetchAgentIdentity(agentId: bigint, chainId?: number): Promise<AgentIdentity> {
  if (isSkipChainReadsEnabled()) {
    return {
      agentId,
      owner: null,
      agentWallet: null,
      tokenUri: null,
      registered: false,
    };
  }

  const client = getPublicClient(chainId);

  try {
    const owner = await client.readContract({
      address: ERC8004_ADDRESSES.identityRegistry,
      abi: identityRegistryAbi,
      functionName: "ownerOf",
      args: [agentId],
    });

    const tokenUri = await client.readContract({
      address: ERC8004_ADDRESSES.identityRegistry,
      abi: identityRegistryAbi,
      functionName: "tokenURI",
      args: [agentId],
    });

    let agentWallet: Address | null = null;
    try {
      const agentWalletRaw = await client.readContract({
        address: ERC8004_ADDRESSES.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "getAgentWallet",
        args: [agentId],
      });
      agentWallet =
        isAddress(agentWalletRaw) && agentWalletRaw !== zeroAddress
          ? (agentWalletRaw as Address)
          : null;
    } catch (error) {
      throw new Error("agent_wallet_read_unavailable", { cause: error });
    }

    return {
      agentId,
      owner: owner as Address,
      agentWallet,
      tokenUri: tokenUri as string,
      registered: true,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === "agent_wallet_read_unavailable" ||
        error.message === "agent_resolve_unavailable")
    ) {
      throw error;
    }

    const message = String((error as Error)?.message ?? error).toLowerCase();
    const missingToken =
      message.includes("reverted") ||
      message.includes("nonexistent") ||
      message.includes("invalid token") ||
      message.includes("owner query for nonexistent");

    if (!missingToken) {
      throw new Error("agent_identity_unavailable", { cause: error });
    }

    return {
      agentId,
      owner: null,
      agentWallet: null,
      tokenUri: null,
      registered: false,
    };
  }
}

export async function fetchReputationSummary(agentId: bigint, chainId?: number) {
  if (isSkipChainReadsEnabled()) {
    return { count: 0, summaryValue: 0, summaryValueDecimals: 0 };
  }

  const client = getPublicClient(chainId);

  try {
    const clients = (await client.readContract({
      address: ERC8004_ADDRESSES.reputationRegistry,
      abi: reputationRegistryAbi,
      functionName: "getClients",
      args: [agentId],
    })) as readonly Address[];

    // No clients means no feedback has ever been left — a FACT about this
    // agent, not a failed read. Returning zeros here (rather than letting the
    // empty-list revert become `reputation_summary_unavailable`) is the
    // difference between "this agent has no reputation yet" and "we could not
    // check its reputation". The first is a low score; the second is a BLOCK.
    // Conflating them would BLOCK every brand-new agent on the network.
    if (clients.length === 0) {
      return { count: 0, summaryValue: 0, summaryValueDecimals: 0 };
    }

    const [count, summaryValue, summaryValueDecimals] = await client.readContract({
      address: ERC8004_ADDRESSES.reputationRegistry,
      abi: reputationRegistryAbi,
      functionName: "getSummary",
      // Empty tags = no tag filter, i.e. summarise all feedback from these
      // clients — the same intent the old `bytes32(0)` args carried.
      args: [agentId, clients, "", ""],
    });

    return {
      count: Number(count),
      summaryValue: Number(summaryValue),
      summaryValueDecimals: Number(summaryValueDecimals),
    };
  } catch (error) {
    throw new Error("reputation_summary_unavailable", { cause: error });
  }
}

export type { RecentFeedbackStats } from "./feedback-window";

export const NEW_FEEDBACK_EVENT = parseAbiItem(
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
);

/**
 * Chunk width for any live scan here: the operator's configured value, never
 * wider.
 *
 * A first cut hardcoded 10,000 ("the provider maximum"). Production proved
 * that wrong: the configured provider answers a 10,000-block eth_getLogs with
 * a block-range complaint, so EVERY chunk bisected (10,000 → 5,000 → 2,500 …),
 * multiplying one scan into far more calls than the sequential version it
 * replaced — and the resulting burst had the provider returning 429 to
 * unrelated reads in the same request, including the identity read the whole
 * score depends on. GET_LOGS_CHUNK_BLOCKS exists precisely because someone
 * already measured what this endpoint accepts.
 */
function liveScanChunkBlocks(): bigint {
  const configured = getLogsChunkSize();
  return configured < 10_000n ? configured : 10_000n;
}

/**
 * Live-tail scan settings.
 *
 * These bound the ONLY chain scan left on the request path: the blocks between
 * the indexer's checkpoint and the tip. That gap is a day or two at worst (see
 * FEEDBACK_TAIL_MAX_DAYS), roughly a dozen chunks in the common case, so a
 * 2.5s ceiling inside the engine's 3,500ms signal budget is generous rather
 * than tight. Overrunning it is not fatal — the caller converts it into
 * `feedback_stats_unavailable`, which the verdict layer treats as high risk.
 * Slower is allowed to mean "more cautious"; never "hangs".
 *
 * The batch pacing delay is overridden to 0: GET_LOGS_CHUNK_DELAY_MS exists to
 * be kind to the RPC during nightly catch-up, and its mere presence forces
 * getLogsChunked onto its strictly-sequential path — correct for a cron, wrong
 * for a request someone is waiting on.
 */
const TAIL_SCAN_CONCURRENCY = 2;
const TAIL_SCAN_DEADLINE_MS = 2_500;

type FeedbackLog = {
  args?: { clientAddress?: Address };
  blockNumber?: bigint | null;
  logIndex?: number | null;
  transactionHash?: string | null;
};

function toEntries(logs: readonly FeedbackLog[]): FeedbackEntry[] {
  return logs.map((log) => ({
    clientAddress: log.args?.clientAddress ?? null,
    blockNumber: log.blockNumber ?? null,
    txHash: log.transactionHash ?? null,
    logIndex: log.logIndex ?? null,
  }));
}

async function scanFeedbackLogs(
  chainId: number,
  agentId: bigint,
  fromBlock: bigint,
  toBlock: bigint | "latest",
  options?: { deadlineMs?: number },
): Promise<FeedbackEntry[]> {
  // Deliberately NOT the client the rest of this file uses. The live endpoint
  // does not answer eth_getLogs on this deployment — see getLogScanClient.
  const logs = (await getLogsChunked(
    getLogScanClient(chainId),
    {
      address: ERC8004_ADDRESSES.reputationRegistry,
      event: NEW_FEEDBACK_EVENT,
      args: { agentId },
      fromBlock,
      toBlock,
    },
    liveScanChunkBlocks(),
    TAIL_SCAN_CONCURRENCY,
    { deadlineMs: options?.deadlineMs, delayMs: 0 },
  )) as FeedbackLog[];

  return toEntries(logs);
}

/**
 * Recent feedback volume and reviewer diversity — the input to
 * `review_velocity_anomaly`.
 *
 * WHAT CHANGED (2026-08-12). This used to scan a 7-day window (~302,400 Base
 * blocks) with eth_getLogs on every uncached score: ~151 round-trips at the
 * operator's configured chunk width, which cannot complete inside any request
 * budget on the current RPC plan. It always ended in
 * `feedback_stats_unavailable`, assessSybilRisk mapped that to high risk, and
 * resolveRecommendation turned it into an unconditional BLOCK — so EVERY agent
 * scored BLOCK regardless of merit, no matter how good its other signals were.
 *
 * The answer now comes from two sources that together cover the whole window:
 * rows written by the nightly indexer, plus a short live scan of the blocks
 * the indexer has not reached yet. The return type, its fields and their
 * meaning are unchanged, and so is every consumer — sybil.ts, verdict.ts and
 * helpers.ts are untouched by this change, deliberately.
 *
 * WHAT DID NOT CHANGE: coverage is still all-or-nothing. If the index does not
 * reach back far enough, or the unindexed tail is too wide to read cheaply,
 * this throws and the fail-closed chain runs exactly as before. A partial
 * window would UNDERCOUNT, and undercounting is fail-open here — the anomaly
 * is raised by feedback being plentiful, so missing rows make a sybil cluster
 * look quieter than it is. "We could not check" must never be reported as
 * "we checked and it was fine".
 *
 * `allowFullScan` is for callers with no request budget — the outcome-detector
 * cron, which asks for windows up to 30 days that a young index cannot yet
 * cover. It must never be set on a request path: that is the unbounded scan
 * this function exists to get rid of.
 */
export async function fetchRecentFeedbackStats(
  agentId: bigint,
  windowDays = 7,
  chainId?: number,
  options?: { allowFullScan?: boolean },
): Promise<RecentFeedbackStats> {
  if (isSkipChainReadsEnabled()) {
    return { recentCount: 0, uniqueClients: 0, windowDays };
  }

  const client = getPublicClient(chainId);
  const resolvedChainId = chainId ?? DEFAULT_CHAIN_ID;

  try {
    const latestBlock = await client.getBlockNumber();
    // Chain-aware window: Base mints ~43,200 blocks/day, Ethereum ~7,200.
    // Using the Base figure everywhere would scan a 6x longer window on
    // mainnet — a silent 6x RPC bill and a wrong "recent" definition.
    const meta = chainById(resolvedChainId);
    const blocksPerDay = meta?.blocksPerDay ?? 43_200;
    const floorBlock = meta?.registryFromBlock ?? IDENTITY_REGISTRY_FROM_BLOCK;
    const fromBlock = feedbackWindowFromBlock(
      latestBlock,
      windowDays,
      blocksPerDay,
      floorBlock,
    );

    const index = await getIndexedFeedbackWindow(resolvedChainId, agentId, fromBlock);

    // 2026-09-09: この選択規則は feedback-window.ts が持つ（RPC も DB も
    // 要らない純粋な判定なので、そこなら直接テストできる）。ここが返す
    // `reason` は「なぜ degrade したか」の語で、health_snapshots の detail
    // まで運ばれる——同じ名前で 3 つの原因を呼んでいたのが、2026-09-09 の
    // degraded 行を決着させられなかった理由そのものだった。
    const plan = planFeedbackSources({
      index,
      fromBlock,
      latestBlock,
      tailMax: tailMaxBlocks(blocksPerDay),
      allowFullScan: options?.allowFullScan === true,
    });

    if (plan.kind === "unavailable") {
      throw new Error(feedbackUnavailableMessage(plan.reason));
    }

    if (plan.kind === "index_and_tail") {
      const tail =
        plan.gap > 0n
          ? await scanFeedbackLogs(
              resolvedChainId,
              agentId,
              plan.index.checkpoint + 1n,
              latestBlock,
              { deadlineMs: TAIL_SCAN_DEADLINE_MS },
            )
          : [];

      return summarizeFeedback([...plan.index.entries, ...tail], fromBlock, windowDays);
    }

    const full = await scanFeedbackLogs(resolvedChainId, agentId, fromBlock, "latest");
    return summarizeFeedback(full, fromBlock, windowDays);
  } catch (error) {
    // Error でない throw だけがここで名前を得る。Error はそのまま通す——
    // 上流の message（`deadline_exceeded:getLogsChunked:2500ms` など）を
    // 潰すと、内側の期限切れと外側の期限切れが同じ顔になる。
    throw error instanceof Error
      ? error
      : new Error("feedback_stats_unavailable:non_error_throw");
  }
}
