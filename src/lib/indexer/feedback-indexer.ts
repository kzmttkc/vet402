import type { Address } from "viem";
import { getLogsChunked } from "@/lib/chain/chunked-logs";
import { chainById, DEFAULT_CHAIN_ID } from "@/lib/chain/chains";
import { getIndexerPublicClient } from "@/lib/chain/client";
import { ERC8004_ADDRESSES, IDENTITY_REGISTRY_FROM_BLOCK } from "@/lib/chain/config";
import { NEW_FEEDBACK_EVENT } from "@/lib/chain/erc8004";
import { bootstrapBlocks, retentionBlocks } from "@/lib/chain/feedback-window";
import {
  FEEDBACK_COVERAGE_CHECKPOINT,
  FEEDBACK_INDEX_CHECKPOINT,
} from "@/lib/db/feedback-index";
import {
  pruneFeedbackEvents,
  recordFeedbackEvents,
  type FeedbackEventRow,
} from "@/lib/db/feedback-index-writer";
import { getIndexerCheckpoint, setIndexerCheckpoints } from "@/lib/db/owner-index";
import { logServerInfoSafe } from "@/lib/util/log-safe";

/**
 * NewFeedback indexer (2026-08-12).
 *
 * Replaces the 7-day eth_getLogs scan that used to run inside every uncached
 * score. That scan was ~151 round-trips at the operator's configured chunk
 * width — unfinishable inside a request budget, so it always ended in
 * `feedback_stats_unavailable`, which assessSybilRisk maps to high risk and
 * resolveRecommendation turns into an unconditional BLOCK. Every agent on the
 * site scored BLOCK because of it. The scan is unchanged in what it reads;
 * it has simply moved somewhere that can afford to run it.
 *
 * Same shape as owner-indexer.ts: checkpointed forward scan, capped per run,
 * checkpoint advanced only after the writes land.
 */

export type FeedbackIndexResult = {
  fromBlock: string;
  toBlock: string;
  coverageStart: string;
  events: number;
  inserted: number;
  pruned: number;
  caughtUp: boolean;
};

/**
 * Blocks per run. Base produces ~43,200 a day and the cron runs daily, so
 * steady state needs a fraction of this; the headroom is for the bootstrap
 * run (8 days ≈ 345,600 blocks) and for catching up after a missed run.
 */
const DEFAULT_MAX_BLOCKS = 400_000n;

function chainMeta() {
  const meta = chainById(DEFAULT_CHAIN_ID);
  return {
    chainId: DEFAULT_CHAIN_ID,
    blocksPerDay: meta?.blocksPerDay ?? 43_200,
    registryFromBlock: meta?.registryFromBlock ?? IDENTITY_REGISTRY_FROM_BLOCK,
  };
}

export async function indexFeedbackEvents(options?: {
  maxBlocks?: bigint;
}): Promise<FeedbackIndexResult> {
  const client = getIndexerPublicClient();
  const { chainId, blocksPerDay, registryFromBlock } = chainMeta();
  const chainTip = await client.getBlockNumber();

  const existingCheckpoint = await getIndexerCheckpoint(FEEDBACK_INDEX_CHECKPOINT);
  const existingCoverage = await getIndexerCheckpoint(FEEDBACK_COVERAGE_CHECKPOINT);

  // First run starts a bootstrap window back from the tip, NOT at the
  // registry's deployment block. A checkpointed scan advances forward, so
  // starting at deployment would deliver the oldest blocks first and leave the
  // last 7 days — the only range this signal reads — until millions of blocks
  // later. Starting 8 days back makes the scoring window whole in one run.
  const bootstrap = chainTip > bootstrapBlocks(blocksPerDay)
    ? chainTip - bootstrapBlocks(blocksPerDay)
    : registryFromBlock;
  const coverageStart = existingCoverage ?? (bootstrap < registryFromBlock ? registryFromBlock : bootstrap);
  const fromBlock = existingCheckpoint ?? coverageStart;

  const maxBlocks = options?.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const toBlock = fromBlock + maxBlocks > chainTip ? chainTip : fromBlock + maxBlocks;

  if (fromBlock > toBlock) {
    await setIndexerCheckpoints([
      { scope: FEEDBACK_INDEX_CHECKPOINT, lastBlock: chainTip, chainTipAtRun: chainTip },
      { scope: FEEDBACK_COVERAGE_CHECKPOINT, lastBlock: coverageStart, chainTipAtRun: chainTip },
    ]);
    return {
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      coverageStart: coverageStart.toString(),
      events: 0,
      inserted: 0,
      pruned: 0,
      caughtUp: true,
    };
  }

  const t0 = Date.now();
  const logs = await getLogsChunked(client, {
    address: ERC8004_ADDRESSES.reputationRegistry,
    event: NEW_FEEDBACK_EVENT,
    fromBlock,
    toBlock,
  });
  logServerInfoSafe(
    "feedback-indexer", `logs=${logs.length} blocks=${fromBlock}-${toBlock} in ${Date.now() - t0}ms`,
  );

  const rows: FeedbackEventRow[] = [];
  for (const log of logs) {
    const args = (log as { args?: { agentId?: bigint; clientAddress?: Address } }).args;
    const agentId = args?.agentId;
    const clientAddress = args?.clientAddress;
    const blockNumber = log.blockNumber;
    const logIndex = log.logIndex;
    const txHash = log.transactionHash;

    // A log missing any of these cannot be deduplicated or windowed, and a row
    // we cannot place in the window is worse than no row: it would be counted
    // for whatever range it happened to satisfy.
    if (
      agentId === undefined ||
      !clientAddress ||
      blockNumber === null ||
      blockNumber === undefined ||
      logIndex === null ||
      logIndex === undefined ||
      !txHash
    ) {
      continue;
    }

    rows.push({ chainId, agentId, clientAddress, blockNumber, logIndex, txHash });
  }

  const inserted = await recordFeedbackEvents(rows);

  // Retention. Rows before this boundary are gone, so coverage must move with
  // it — a reader that believed in the old coverage start would answer a wide
  // window from rows this line just deleted.
  const pruneBefore = chainTip > retentionBlocks(blocksPerDay)
    ? chainTip - retentionBlocks(blocksPerDay)
    : 0n;
  const nextCoverageStart = pruneBefore > coverageStart ? pruneBefore : coverageStart;
  const nextBlock = toBlock + 1n;
  const caughtUp = nextBlock > chainTip;

  // 2026-08-18 (audit residual): advance the retention floor BEFORE pruning,
  // and write both checkpoints in one statement. Two failure modes closed:
  //  - Coverage-before-prune: if we crash after moving the floor but before
  //    the prune, the floor points at a boundary where rows STILL exist —
  //    conservative (a reader sees complete data), never an undercount.
  //  - Atomic dual write: the scan cursor and the floor move together, so a
  //    crash can never leave the floor lagging the deleted boundary while the
  //    cursor has advanced past it.
  await setIndexerCheckpoints([
    { scope: FEEDBACK_INDEX_CHECKPOINT, lastBlock: caughtUp ? chainTip : nextBlock, chainTipAtRun: chainTip },
    { scope: FEEDBACK_COVERAGE_CHECKPOINT, lastBlock: nextCoverageStart, chainTipAtRun: chainTip },
  ]);
  const pruned = pruneBefore > 0n ? await pruneFeedbackEvents(chainId, pruneBefore) : 0;

  return {
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    coverageStart: nextCoverageStart.toString(),
    events: logs.length,
    inserted,
    pruned,
    caughtUp,
  };
}
