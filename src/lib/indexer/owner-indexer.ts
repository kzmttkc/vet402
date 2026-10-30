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
  applyOwnerAgentChanges,
  type OwnerAgentChanges,
  type OwnerWriteOptions,
} from "@/lib/db/owner-index-writer";
import { mapWithConcurrency } from "@/lib/util/concurrency";
import { logServerInfoSafe, logServerWarnSafe } from "@/lib/util/log-safe";
import { runSegmentedScan, type ScanClock, type SegmentedScanOptions } from "./segmented-scan";

/**
 * 所有者索引（Registered / Transfer → owner_agents）。
 *
 * 2026-10-31: 区切りごとに「読む → 書く → checkpoint」へ（segmented-scan.ts）。書き込みは
 * 1 イベントずつではなく、区切りの変更を agentId ごとの最後の形に畳んでからまとめて書く
 * （ownerChangesForSegment → applyOwnerAgentChanges）。
 *
 * WHY（10/31 実測）。10/8 から本番の checkpoint は 52,323,145 で止まり、cron は毎回 300 秒で
 * 殺されていた。読み取りは 1,000 ブロックの getLogs で 20,000 ブロック 2〜25 秒だったが、
 * その後ろの Transfer の書き込みが 1 件ずつ・直列に 2 文（Neon HTTP の 1 往復 150〜300ms）で、
 * 10/8 以降の 98 万ブロックには Transfer が 208 万件ある（20,000 ブロックに 44 万件の所もある）。
 * 1 回の 250,000 ブロックは書き込みだけで何時間もかかる量で、最後にしか checkpoint を
 * 書かないので、殺されるたびに全部が消えていた。
 */

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
  /** 最後に読み終えて書き終えたブロック（= この回の後の checkpoint）。 */
  toBlock: string;
  registeredEvents: number;
  transferEvents: number;
  upserted: number;
  removed: number;
  caughtUp: boolean;
  /** この回に checkpoint が進んだブロック数。 */
  blocksAdvanced: number;
  /** 読み終えて書き終えた区切りの数。 */
  segments: number;
  /** 予算・上限・読み先の失敗で、tip（または maxBlocks の端）の手前で止まった回。 */
  partial: boolean;
  /** partial のときだけ: `time_budget`・`hard_stop`・`rpc:<読み先の言い分>`。 */
  stoppedBy?: string;
};

const DEFAULT_MAX_BLOCKS = 150_000n;

/**
 * ownerOf の照合。1 回の eth_call（Multicall3）に 1,000 件、4 本並列。
 * 10/31 実測（手元 → mainnet.base.org）: 200 件 0.28 秒・1,000 件 0.64 秒・500 件 × 4 並列 0.48 秒。
 * 以前の 200 件ずつ直列では、23 万件の区切りで照合だけ 5 分かかる。
 */
const OWNER_VERIFY_BATCH = 1_000;
const OWNER_VERIFY_CONCURRENCY = 4;

/**
 * 1 区切りの中で読む窓（ブロック数）と、区切りを打ち切る件数。
 *
 * 1 区切り（20,000 ブロック）に Registered + Transfer が 65 万件入る所がある（10/31 実測:
 * 52,963,145〜52,983,144 で Transfer 437,807 件）。それを 1 度に読んで照合して書くと、メモリも
 * 時間も 1 区切りに収まらない。窓ごとに読み、件数が MAX_SEGMENT_EVENTS を越えたらその窓の終わりで
 * 区切りを閉じる。窓の境目はブロックの境目なので、1 ブロックの途中で切ることはない。
 * 上限は窓 1 つぶん越えうる（10/31 手元実測: 最も濃い所で 1 区切り 23 万件・18.5 万 agentId・
 * 読み 17 秒・ownerOf 10 秒・書き込み 3 秒（手元の Postgres）。疎な所は 20,000 ブロックで読み 7〜9 秒）。
 */
const READ_WINDOW_BLOCKS = 4_000n;
const MAX_SEGMENT_EVENTS = 100_000;

type OwnerLookup = Address | null | "unavailable";

type IndexerClient = Pick<ReturnType<typeof getIndexerPublicClient>, "getBlockNumber" | "multicall">;

async function fetchCurrentOwners(
  client: IndexerClient,
  agentIds: bigint[],
): Promise<Map<string, OwnerLookup>> {
  const owners = new Map<string, OwnerLookup>();
  const unique = [...new Set(agentIds.map((id) => id.toString()))].map((id) => BigInt(id));
  const batches: bigint[][] = [];
  for (let i = 0; i < unique.length; i += OWNER_VERIFY_BATCH) batches.push(unique.slice(i, i + OWNER_VERIFY_BATCH));

  await mapWithConcurrency(batches, OWNER_VERIFY_CONCURRENCY, async (chunk) => {
    const results = await client.multicall({
      contracts: chunk.map((agentId) => ({
        address: ERC8004_ADDRESSES.identityRegistry,
        abi: identityOwnerAbi,
        functionName: "ownerOf",
        args: [agentId],
      })),
      allowFailure: true,
      // 1 束 = 1 回の eth_call（viem の既定 1,024 バイトだと 1,000 件が約 35 回に割れて並列で飛ぶ）。
      batchSize: 0,
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
  });

  return owners;
}

type RegisteredLogLike = { args: { agentId?: bigint; owner?: Address } };
type TransferLogLike = {
  args: { tokenId?: bigint; from?: Address; to?: Address };
  blockNumber?: bigint | null;
  logIndex?: number | null;
};

/**
 * 照合の答え。照合していない id は「答えが無い」と同じ扱い（unavailable）。
 * `?? "unavailable"` と書くと null（ownerOf が無効なアドレスを返した＝持ち主なし）まで
 * unavailable に化けて、消すべき行を残してしまう（10/31 の乱数テストで見つけた）。
 */
function lookup(owners: ReadonlyMap<string, OwnerLookup>, agentId: bigint): OwnerLookup {
  const value = owners.get(agentId.toString());
  return value === undefined ? "unavailable" : value;
}

/**
 * 1 区切りのイベントを、owner_agents への変更に畳む（2026-10-31）。
 *
 * 判断の規則は以前の 1 件ずつの手順そのまま（Registered を先に全部 → Transfer をチェーンの順に）。
 * 違うのは、DB に 1 件ずつ書く代わりに「その手順を順に当てたら最後に何が残るか」を
 * agentId ごとに記録すること:
 *   upsert(owner)        → その組は残す
 *   removeOwnerAgent     → その組は消す
 *   removeAgentFromIndex → その agentId の行を全部消す（それまでの記録も捨てる）
 * agentId どうしは互いに影響しないので、この畳み方は 1 件ずつ当てたときと同じ最終形になる。
 * upserted / removed の数え方も以前と同じ（1 手順 = 1）。
 */
export function ownerChangesForSegment(
  registeredLogs: readonly RegisteredLogLike[],
  transferLogs: readonly TransferLogLike[],
  owners: ReadonlyMap<string, OwnerLookup>,
): { changes: OwnerAgentChanges; upserted: number; removed: number; verifyUnavailable: number } {
  const perAgent = new Map<string, { agentId: bigint; wipe: boolean; ops: Map<string, { owner: Address; keep: boolean }> }>();
  const stateOf = (agentId: bigint) => {
    const key = agentId.toString();
    let state = perAgent.get(key);
    if (!state) {
      state = { agentId, wipe: false, ops: new Map() };
      perAgent.set(key, state);
    }
    return state;
  };
  const upsert = (owner: Address, agentId: bigint) => {
    stateOf(agentId).ops.set(owner.toLowerCase(), { owner, keep: true });
  };
  const removePair = (owner: Address, agentId: bigint) => {
    stateOf(agentId).ops.set(owner.toLowerCase(), { owner, keep: false });
  };
  const removeAgent = (agentId: bigint) => {
    const state = stateOf(agentId);
    state.wipe = true;
    state.ops.clear();
  };

  let upserted = 0;
  let removed = 0;
  let verifyUnavailable = 0;

  for (const log of registeredLogs) {
    const { agentId, owner } = log.args;
    if (agentId === undefined || !owner || !isValidAddress(owner)) continue;
    const current = lookup(owners, agentId);
    if (current === "unavailable") {
      // Event-based upsert when ownerOf is temporarily unavailable — avoid index holes.
      upsert(owner, agentId);
      upserted++;
    } else if (current && current.toLowerCase() === owner.toLowerCase()) {
      upsert(owner, agentId);
      upserted++;
    }
  }

  const transferOrdered = [...transferLogs].sort((a, b) => {
    const aBlock = a.blockNumber ?? 0n;
    const bBlock = b.blockNumber ?? 0n;
    if (aBlock !== bBlock) return aBlock < bBlock ? -1 : 1;
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });

  for (const log of transferOrdered) {
    const { tokenId: agentId, from, to } = log.args;
    if (agentId === undefined) continue;

    if (from && isValidAddress(from) && from !== zeroAddress) {
      removePair(from, agentId);
      removed++;
    }

    if (to && isValidAddress(to) && to !== zeroAddress) {
      const verified = lookup(owners, agentId);
      if (verified === "unavailable") {
        // Do not wipe the agent row on transient ownerOf failure — event-based upsert only.
        upsert(to, agentId);
        upserted++;
        verifyUnavailable++;
      } else if (verified !== null && verified.toLowerCase() === to.toLowerCase()) {
        removeAgent(agentId);
        upsert(to, agentId);
        upserted++;
      } else if (verified === null) {
        removeAgent(agentId);
        removed++;
      } else {
        // Live ownerOf differs from transfer `to` — trust ownerOf.
        removeAgent(agentId);
        upsert(verified, agentId);
        upserted++;
      }
    } else {
      removeAgent(agentId);
      removed++;
    }
  }

  const changes: OwnerAgentChanges = { upserts: [], deletePairs: [], wipe: [] };
  for (const state of perAgent.values()) {
    if (state.wipe) changes.wipe.push(state.agentId);
    for (const { owner, keep } of state.ops.values()) {
      if (keep) changes.upserts.push({ owner, agentId: state.agentId });
      else if (!state.wipe) changes.deletePairs.push({ owner, agentId: state.agentId });
    }
  }
  return { changes, upserted, removed, verifyUnavailable };
}

/** テストの差し替え口。本番は全部既定（実 RPC・実 DB・Date.now）。 */
export type OwnerIndexDeps = {
  now: () => number;
  applyChanges: (changes: OwnerAgentChanges, options?: OwnerWriteOptions) => Promise<void>;
};

type OwnerSegment = {
  from: bigint;
  readMs: number;
  verifyMs: number;
  changes: OwnerAgentChanges;
  registeredEvents: number;
  transferEvents: number;
  upserted: number;
  removed: number;
  verifyUnavailable: number;
};

export async function indexOwnerAgents(
  options?: {
    maxBlocks?: bigint;
    /** 1 区切りで読む窓のブロック数。既定 READ_WINDOW_BLOCKS。 */
    readWindowBlocks?: bigint;
    /** この件数を越えたら、その窓の終わりで区切りを閉じる。既定 MAX_SEGMENT_EVENTS。 */
    maxSegmentEvents?: number;
    deps?: Partial<OwnerIndexDeps>;
  } & Omit<SegmentedScanOptions, "now">,
): Promise<OwnerIndexResult> {
  const client = getIndexerPublicClient();
  const now = options?.deps?.now ?? Date.now;
  const applyChanges = options?.deps?.applyChanges ?? applyOwnerAgentChanges;
  const readWindow =
    options?.readWindowBlocks !== undefined && options.readWindowBlocks > 0n ? options.readWindowBlocks : READ_WINDOW_BLOCKS;
  const maxSegmentEvents = options?.maxSegmentEvents ?? MAX_SEGMENT_EVENTS;
  const startedAt = options?.startedAt ?? now();

  const chainTip = await client.getBlockNumber();
  const existing = await getIndexerCheckpoint(OWNER_INDEX_CHECKPOINT);
  // checkpoint は「最後に読み終えたブロック」。そのブロックから読み直す（1 ブロックの読み直しは
  // 同じ変更を作るだけ。10/31 より前の版は「次に読むブロック」を書いていたので、どちらの意味の
  // 値が残っていても穴が出ない側に倒す）。
  const fromBlock = existing ?? IDENTITY_REGISTRY_FROM_BLOCK;

  const maxBlocks = options?.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const toBlock = fromBlock + maxBlocks > chainTip ? chainTip : fromBlock + maxBlocks;

  if (fromBlock > toBlock) {
    await setIndexerCheckpoint(OWNER_INDEX_CHECKPOINT, chainTip, chainTip);
    return {
      fromBlock: fromBlock.toString(),
      toBlock: (existing ?? chainTip).toString(),
      registeredEvents: 0,
      transferEvents: 0,
      upserted: 0,
      removed: 0,
      caughtUp: true,
      blocksAdvanced: 0,
      segments: 0,
      partial: false,
    };
  }

  const readLogs = async (
    event: typeof registeredEvent | typeof transferEvent,
    from: bigint,
    to: bigint,
    clock: ScanClock,
    label: string,
  ) =>
    clock.within(
      (remainingMs) =>
        getLogsChunked(
          client,
          { address: ERC8004_ADDRESSES.identityRegistry, event, fromBlock: from, toBlock: to },
          undefined,
          undefined,
          { deadlineMs: remainingMs },
        ),
      label,
    );

  const totals = { registeredEvents: 0, transferEvents: 0, upserted: 0, removed: 0, verifyUnavailable: 0 };
  const t0 = now();

  const scan = await runSegmentedScan<OwnerSegment>({
    fromBlock,
    toBlock,
    options: { ...options, now, startedAt },
    read: async (from, maxTo, clock) => {
      const readStarted = now();
      const registeredLogs: RegisteredLogLike[] = [];
      const transferLogs: TransferLogLike[] = [];
      let end = from - 1n;
      while (end < maxTo) {
        const windowFrom = end + 1n;
        const windowTo = windowFrom + readWindow - 1n > maxTo ? maxTo : windowFrom + readWindow - 1n;
        const registered = await readLogs(registeredEvent, windowFrom, windowTo, clock, "owner-indexer.registered");
        const transfers = await readLogs(transferEvent, windowFrom, windowTo, clock, "owner-indexer.transfer");
        for (const log of registered) registeredLogs.push(log as unknown as RegisteredLogLike);
        for (const log of transfers) transferLogs.push(log as unknown as TransferLogLike);
        end = windowTo;
        if (registeredLogs.length + transferLogs.length >= maxSegmentEvents) break;
      }

      const verifyIds: bigint[] = [];
      for (const log of registeredLogs) if (log.args.agentId !== undefined) verifyIds.push(log.args.agentId);
      for (const log of transferLogs) {
        const { tokenId, to } = log.args;
        if (tokenId !== undefined && to && isValidAddress(to) && to !== zeroAddress) verifyIds.push(tokenId);
      }
      const verifyStarted = now();
      const owners = await clock.within(() => fetchCurrentOwners(client, verifyIds), "owner-indexer.ownerOf");
      const verifyMs = now() - verifyStarted;

      const folded = ownerChangesForSegment(registeredLogs, transferLogs, owners);
      return {
        lastBlock: end,
        payload: {
          from,
          readMs: verifyStarted - readStarted,
          verifyMs,
          ...folded,
          registeredEvents: registeredLogs.length,
          transferEvents: transferLogs.length,
        },
      };
    },
    write: async ({ lastBlock, payload }, control) => {
      const writeStarted = now();
      await applyChanges(payload.changes, { shouldStop: control.shouldStop });
      // 区切りごとの内訳（どこで時間を使っているかを本番のログで読めるように）。
      logServerInfoSafe(
        "owner-indexer.segment",
        `${payload.from}-${lastBlock} events=${payload.registeredEvents + payload.transferEvents}` +
          ` ids=${payload.changes.upserts.length + payload.changes.wipe.length} read=${payload.readMs}ms` +
          ` ownerOf=${payload.verifyMs}ms write=${now() - writeStarted}ms`,
      );
      totals.registeredEvents += payload.registeredEvents;
      totals.transferEvents += payload.transferEvents;
      totals.upserted += payload.upserted;
      totals.removed += payload.removed;
      totals.verifyUnavailable += payload.verifyUnavailable;
    },
    checkpoint: (lastBlock) => setIndexerCheckpoint(OWNER_INDEX_CHECKPOINT, lastBlock, chainTip),
  });

  if (totals.verifyUnavailable > 0) {
    logServerInfoSafe(
      "owner-indexer", `${totals.verifyUnavailable} transfer updates used event-based upsert due to ownerOf failures`,
    );
  }

  const caughtUp = scan.scannedTo >= chainTip;
  const partial = scan.stoppedBy !== undefined;
  logServerInfoSafe(
    "owner-indexer",
    `blocks=${fromBlock}-${scan.scannedTo} segments=${scan.segments} registered=${totals.registeredEvents}` +
      ` transfers=${totals.transferEvents} in ${now() - t0}ms`,
  );
  if (partial) {
    logServerWarnSafe("owner-indexer.partial", `stopped at ${scan.scannedTo} of ${toBlock} (tip ${chainTip}): ${scan.stoppedBy}`);
  }

  const before = existing ?? fromBlock;
  return {
    fromBlock: fromBlock.toString(),
    toBlock: scan.scannedTo.toString(),
    registeredEvents: totals.registeredEvents,
    transferEvents: totals.transferEvents,
    upserted: totals.upserted,
    removed: totals.removed,
    caughtUp,
    blocksAdvanced: scan.scannedTo > before ? Number(scan.scannedTo - before) : 0,
    segments: scan.segments,
    partial,
    ...(scan.stoppedBy !== undefined ? { stoppedBy: scan.stoppedBy } : {}),
  };
}
