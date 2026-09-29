import { parseAbiItem, zeroAddress, type Address } from "viem";
import { getLogsChunked } from "@/lib/chain/chunked-logs";
import { getIndexerPublicClient, isValidAddress } from "@/lib/chain/client";
import { ERC8004_ADDRESSES, IDENTITY_REGISTRY_FROM_BLOCK } from "@/lib/chain/config";
import {
  getIndexerCheckpoint,
  OWNER_INDEX_CHECKPOINT,
  setIndexerCheckpoint,
} from "@/lib/db/owner-index";
import {
  removeAgentFromIndex,
  removeOwnerAgent,
  upsertOwnerAgent,
} from "@/lib/db/owner-index-writer";
import { mapWithConcurrency } from "@/lib/util/concurrency";
import { logServerInfoSafe } from "@/lib/util/log-safe";

/**
 * Registered-event writes are independent per agentId (each is a brand-new
 * row), so they're safe to fan out concurrently — unlike transfer writes,
 * where multiple events can target the same agentId and must apply in
 * on-chain order. This was previously a sequential `for...await` loop; with
 * ~800 events per 100k-block window and Neon HTTP round-trips at
 * 150-300ms each, that serial loop alone could exceed the 300s function
 * budget (see 2026-07-22 index-owners FUNCTION_INVOCATION_TIMEOUT incident).
 */
const OWNER_WRITE_CONCURRENCY = 15;

const registeredEvent = parseAbiItem(
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
);
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);

const identityOwnerAbi = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

export type OwnerIndexResult = {
  fromBlock: string;
  toBlock: string;
  registeredEvents: number;
  transferEvents: number;
  upserted: number;
  removed: number;
  caughtUp: boolean;
};

const DEFAULT_MAX_BLOCKS = 150_000n;
const OWNER_VERIFY_BATCH = 200;

type OwnerLookup = Address | null | "unavailable";

async function fetchCurrentOwners(
  client: ReturnType<typeof getIndexerPublicClient>,
  agentIds: bigint[],
): Promise<Map<string, OwnerLookup>> {
  const owners = new Map<string, OwnerLookup>();
  const unique = [...new Set(agentIds.map((id) => id.toString()))].map((id) => BigInt(id));

  for (let i = 0; i < unique.length; i += OWNER_VERIFY_BATCH) {
    const chunk = unique.slice(i, i + OWNER_VERIFY_BATCH);
    const results = await client.multicall({
      contracts: chunk.map((agentId) => ({
        address: ERC8004_ADDRESSES.identityRegistry,
        abi: identityOwnerAbi,
        functionName: "ownerOf",
        args: [agentId],
      })),
      allowFailure: true,
    });

    for (let j = 0; j < chunk.length; j++) {
      const agentId = chunk[j]!;
      const result = results[j];
      if (result?.status === "success" && isValidAddress(result.result)) {
        owners.set(agentId.toString(), result.result);
      } else if (result?.status === "success") {
        owners.set(agentId.toString(), null);
      } else {
        // Transient multicall failure — do not treat as burned / unowned.
        owners.set(agentId.toString(), "unavailable");
      }
    }
  }

  return owners;
}

function ownerMatches(
  agentId: bigint,
  owner: Address,
  owners: Map<string, OwnerLookup>,
): boolean {
  const current = owners.get(agentId.toString());
  return Boolean(
    current &&
      current !== "unavailable" &&
      current.toLowerCase() === owner.toLowerCase(),
  );
}

async function syncOwnerAgent(
  owner: Address,
  agentId: bigint,
  owners: Map<string, OwnerLookup>,
): Promise<"upserted" | "skipped" | "unavailable"> {
  if (!owners.has(agentId.toString())) {
    const fetched = await fetchCurrentOwners(getIndexerPublicClient(), [agentId]);
    for (const [id, value] of fetched) owners.set(id, value);
  }
  const current = owners.get(agentId.toString());
  if (current === "unavailable") return "unavailable";
  if (!ownerMatches(agentId, owner, owners)) return "skipped";
  await upsertOwnerAgent(owner, agentId);
  return "upserted";
}

export async function indexOwnerAgents(options?: {
  maxBlocks?: bigint;
}): Promise<OwnerIndexResult> {
  const client = getIndexerPublicClient();
  const chainTip = await client.getBlockNumber();
  const fromBlock = (await getIndexerCheckpoint(OWNER_INDEX_CHECKPOINT)) ?? IDENTITY_REGISTRY_FROM_BLOCK;

  const maxBlocks = options?.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const toBlock = fromBlock + maxBlocks > chainTip ? chainTip : fromBlock + maxBlocks;

  const empty: OwnerIndexResult = {
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    registeredEvents: 0,
    transferEvents: 0,
    upserted: 0,
    removed: 0,
    caughtUp: fromBlock >= chainTip,
  };

  if (fromBlock > toBlock) {
    await setIndexerCheckpoint(OWNER_INDEX_CHECKPOINT, chainTip, chainTip);
    return { ...empty, caughtUp: true };
  }

  const t0 = Date.now();
  const registeredLogs = await getLogsChunked(client, {
    address: ERC8004_ADDRESSES.identityRegistry,
    event: registeredEvent,
    fromBlock,
    toBlock,
  });
  logServerInfoSafe("owner-indexer", `registeredLogs=${registeredLogs.length} in ${Date.now() - t0}ms`);
  const t1 = Date.now();
  const transferLogs = await getLogsChunked(client, {
    address: ERC8004_ADDRESSES.identityRegistry,
    event: transferEvent,
    fromBlock,
    toBlock,
  });
  logServerInfoSafe("owner-indexer", `transferLogs=${transferLogs.length} in ${Date.now() - t1}ms`);

  let upserted = 0;
  let removed = 0;

  const registeredPairs: { owner: Address; agentId: bigint }[] = [];
  for (const log of registeredLogs) {
    const agentId = (log as { args: { agentId?: bigint; owner?: Address } }).args.agentId;
    const owner = (log as { args: { agentId?: bigint; owner?: Address } }).args.owner;
    if (agentId === undefined || !owner || !isValidAddress(owner)) continue;
    registeredPairs.push({ owner, agentId });
  }

  const t2 = Date.now();
  const owners = await fetchCurrentOwners(
    client,
    registeredPairs.map((pair) => pair.agentId),
  );
  const registeredOutcomes = await mapWithConcurrency(
    registeredPairs,
    OWNER_WRITE_CONCURRENCY,
    async ({ owner, agentId }) => {
      const outcome = await syncOwnerAgent(owner, agentId, owners);
      if (outcome === "unavailable") {
        // Event-based upsert when ownerOf is temporarily unavailable — avoid index holes.
        await upsertOwnerAgent(owner, agentId);
        return "upserted" as const;
      }
      return outcome;
    },
  );
  for (const outcome of registeredOutcomes) {
    if (outcome === "upserted") upserted++;
  }
  logServerInfoSafe("owner-indexer", `verified ${registeredPairs.length} registered owners in ${Date.now() - t2}ms`);

  const transferOrdered = [...transferLogs].sort((a, b) => {
    const aBlock = a.blockNumber ?? 0n;
    const bBlock = b.blockNumber ?? 0n;
    const blockDelta = Number(aBlock - bBlock);
    if (blockDelta !== 0) return blockDelta;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });

  const transferAgentIds: bigint[] = [];
  for (const log of transferOrdered) {
    const args = (log as { args: { tokenId?: bigint; to?: Address } }).args;
    const agentId = args.tokenId;
    const to = args.to;
    if (agentId !== undefined && to && isValidAddress(to) && to !== zeroAddress) {
      transferAgentIds.push(agentId);
    }
  }
  const transferOwners = await fetchCurrentOwners(client, transferAgentIds);
  for (const [id, owner] of transferOwners) owners.set(id, owner);

  let verifyUnavailable = 0;

  for (const log of transferOrdered) {
    const args = (log as {
      args: { tokenId?: bigint; from?: Address; to?: Address };
    }).args;
    const agentId = args.tokenId;
    const from = args.from;
    const to = args.to;
    if (agentId === undefined) continue;

    if (from && isValidAddress(from) && from !== zeroAddress) {
      await removeOwnerAgent(from, agentId);
      removed++;
    }

    if (to && isValidAddress(to) && to !== zeroAddress) {
      const verified = owners.get(agentId.toString());
      if (verified === "unavailable") {
        // Do not wipe the agent row on transient ownerOf failure — event-based upsert only.
        await upsertOwnerAgent(to, agentId);
        upserted++;
        verifyUnavailable++;
      } else if (verified && verified !== null && verified.toLowerCase() === to.toLowerCase()) {
        await removeAgentFromIndex(agentId);
        await upsertOwnerAgent(to, agentId);
        upserted++;
      } else if (verified === null) {
        await removeAgentFromIndex(agentId);
        removed++;
      } else if (verified) {
        // Live ownerOf differs from transfer `to` — trust ownerOf.
        await removeAgentFromIndex(agentId);
        await upsertOwnerAgent(verified, agentId);
        upserted++;
      }
    } else {
      await removeAgentFromIndex(agentId);
      removed++;
    }
  }

  if (verifyUnavailable > 0) {
    logServerInfoSafe(
      "owner-indexer", `${verifyUnavailable} transfer updates used event-based upsert due to ownerOf failures`,
    );
  }

  const nextBlock = toBlock + 1n;
  const caughtUp = nextBlock > chainTip;
  await setIndexerCheckpoint(
    OWNER_INDEX_CHECKPOINT,
    caughtUp ? chainTip : nextBlock,
    chainTip,
  );

  return {
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    registeredEvents: registeredLogs.length,
    transferEvents: transferLogs.length,
    upserted,
    removed,
    caughtUp,
  };
}
