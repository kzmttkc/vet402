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
import { DeadlineExceededError, withDeadline } from "@/lib/util/deadline";
import { logServerInfoSafe, logServerWarnSafe, redactSecretsForLog } from "@/lib/util/log-safe";

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
  /**
   * 途中で止まったが、読めた分は書いて checkpoint を進めた回（2026-10-13）。
   * `toBlock` は実際に読み終えた最後のブロック。次の回はその次から始まる。
   */
  partial: boolean;
  /** partial のときだけ: なぜ止まったか（`time_budget`・`hard_stop`・`rpc:<読み先の言い分>`）。 */
  stoppedBy?: string;
};

/**
 * Blocks per run. Base produces ~43,200 a day and the cron runs daily, so
 * steady state needs a fraction of this; the headroom is for the bootstrap
 * run (8 days ≈ 345,600 blocks) and for catching up after a missed run.
 */
const DEFAULT_MAX_BLOCKS = 400_000n;

/**
 * 1 区切りのブロック数（2026-10-13）。
 *
 * 以前は 1 回の run の全範囲（最大 400,000 ブロック）を 1 度の getLogsChunked で読み、
 * 全部読めたときだけ書いて checkpoint を進めた。200 個の chunk のうち 1 個が落ちると
 * 199 個ぶんの読み取りを捨て、次の回も同じ先頭から始まる——遅れが大きいほど 1 回で
 * 読む量が増え、どこかで落ちる見込みも増えるので、遅れた索引ほど追いつけない形だった。
 * 区切りごとに「読む → 書く → checkpoint を進める」にすると、落ちた回も手前までは残る。
 *
 * 20,000 ブロック ≈ Base の 11 時間。平常（3 時間ごとの cron で 5,400 ブロック）は
 * 1 区切りで終わるので、平常時の書き込みの回数は変わらない。
 */
const DEFAULT_SEGMENT_BLOCKS = 20_000n;

/**
 * 時間の上限 2 つ。cron の maxDuration は 300 秒（src/app/api/cron/index-feedback/route.ts）。
 * 関数ごと殺されると応答が返らず、最後の checkpoint と prune も走らないので、手前で自分から止まる。
 *
 *  - DEFAULT_TIME_BUDGET_MS（200 秒）: これを過ぎたら新しい区切りを始めない。
 *  - DEFAULT_HARD_STOP_MS（250 秒）: 読んでいる途中の区切りも、ここで待つのをやめる。
 *    getLogsChunked に渡す期限は「次の要求を出さない」だけで、出してしまった 1 要求は
 *    transport の timeout 20 秒 × 最大 4 回（retryCount 3）＝約 81 秒、読み先が 2 つなら
 *    その 2 倍まで返ってこないことがある。だから壁時計でも切る（withDeadline）。
 *    切られた区切りは書かれず、checkpoint も進まない（次の回が同じ所から読む）。
 *
 * 250 秒の後に残るのは DB の 3 文（最後に読み終えた区切りの行の insert・checkpoint・prune）で、
 * 300 秒までに 50 秒ある。平常の 1 回は 1 区切り・数秒（実測: 218,297 ブロック＝11 区切りで 25.3 秒）。
 */
const DEFAULT_TIME_BUDGET_MS = 200_000;
const DEFAULT_HARD_STOP_MS = 250_000;

/** テストの差し替え口。本番は全部既定（実 RPC・実 DB）。 */
export type FeedbackIndexDeps = {
  client: { getBlockNumber: () => Promise<bigint> };
  getLogs: (
    client: never,
    params: { address: Address; event: typeof NEW_FEEDBACK_EVENT; fromBlock: bigint; toBlock: bigint },
    chunkSize?: undefined,
    concurrency?: undefined,
    options?: { deadlineMs?: number },
  ) => Promise<readonly unknown[]>;
  getCheckpoint: typeof getIndexerCheckpoint;
  setCheckpoints: typeof setIndexerCheckpoints;
  record: typeof recordFeedbackEvents;
  prune: typeof pruneFeedbackEvents;
  now: () => number;
};

function stopReason(error: unknown): string {
  if (error instanceof DeadlineExceededError) return "hard_stop";
  const err = error as { details?: string; shortMessage?: string; message?: string };
  const text = err?.details ?? err?.shortMessage ?? err?.message ?? String(error);
  // 1 行・短く・URL と鍵は伏せる（cron の応答とログに出る）。
  return `rpc:${redactSecretsForLog(String(text)).replace(/https?:\/\/\S+/g, "<url>").split("\n")[0]!.slice(0, 160)}`;
}

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
  /** 1 区切りのブロック数。既定 DEFAULT_SEGMENT_BLOCKS。 */
  segmentBlocks?: bigint;
  /** 新しい区切りを始めてよい経過時間（ms）。既定 DEFAULT_TIME_BUDGET_MS。 */
  timeBudgetMs?: number;
  /** 読んでいる途中の区切りを待つのをやめる経過時間（ms）。既定 DEFAULT_HARD_STOP_MS。 */
  hardStopMs?: number;
  deps?: Partial<FeedbackIndexDeps>;
}): Promise<FeedbackIndexResult> {
  const deps = options?.deps;
  const client = (deps?.client ?? getIndexerPublicClient()) as ReturnType<typeof getIndexerPublicClient>;
  const getLogs = (deps?.getLogs ?? getLogsChunked) as typeof getLogsChunked;
  const getCheckpoint = deps?.getCheckpoint ?? getIndexerCheckpoint;
  const setCheckpoints = deps?.setCheckpoints ?? setIndexerCheckpoints;
  const record = deps?.record ?? recordFeedbackEvents;
  const prune = deps?.prune ?? pruneFeedbackEvents;
  const now = deps?.now ?? Date.now;

  const { chainId, blocksPerDay, registryFromBlock } = chainMeta();
  const chainTip = await client.getBlockNumber();

  const existingCheckpoint = await getCheckpoint(FEEDBACK_INDEX_CHECKPOINT);
  const existingCoverage = await getCheckpoint(FEEDBACK_COVERAGE_CHECKPOINT);

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
    await setCheckpoints([
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
      partial: false,
    };
  }

  const segmentBlocks =
    options?.segmentBlocks !== undefined && options.segmentBlocks > 0n
      ? options.segmentBlocks
      : DEFAULT_SEGMENT_BLOCKS;
  const timeBudgetMs = options?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const hardStopMs = options?.hardStopMs ?? DEFAULT_HARD_STOP_MS;

  const t0 = now();
  // 次に読むブロック。ここより手前は書き終えている。
  //
  // checkpoint に書くのは cursor ではなく **cursor - 1n（最後に読み終えたブロック）**。
  // 読み手（erc8004.ts の fetchRecentFeedbackStats）は `checkpoint + 1n` から tail を読むので、
  // 「次に読むブロック」を書くと、そのブロックが索引にも tail にも入らない
  // （2026-10-13 の点検で再現: 3 区切り目で落とすと checkpoint=980000・書いた最大=979999・
  // tail の開始=980001 で、980000 が次の cron まで数えられない）。追いついた回が chainTip
  // （＝最後に読んだブロック）を書くのと同じ意味にそろえる。次の回は checkpoint のブロックを
  // もう 1 度読むが、行は (chain, tx, logIndex) の一意索引で重複しない。
  let cursor = fromBlock;
  let events = 0;
  let inserted = 0;
  let stoppedBy: string | undefined;

  while (cursor <= toBlock) {
    // 最初の区切りは必ず試す（予算 0 でも「何も試さずに成功」を返さない）。
    if (cursor > fromBlock && now() - t0 >= timeBudgetMs) {
      stoppedBy = "time_budget";
      break;
    }
    const segmentEnd = cursor + segmentBlocks - 1n > toBlock ? toBlock : cursor + segmentBlocks - 1n;

    let logs: readonly unknown[];
    try {
      const remainingMs = Math.max(0, hardStopMs - (now() - t0));
      logs = await withDeadline(
        getLogs(
          client,
          {
            address: ERC8004_ADDRESSES.reputationRegistry,
            event: NEW_FEEDBACK_EVENT,
            fromBlock: cursor,
            toBlock: segmentEnd,
          },
          undefined,
          undefined,
          { deadlineMs: remainingMs },
        ),
        remainingMs,
        "feedback-indexer.segment",
      );
    } catch (error) {
      // 1 区切りも読めなかった回は、以前と同じく throw（cron は 500・checkpoint は動かない）。
      // 「読めていないのに成功」を返すと、止まった索引が緑に見える。
      if (cursor === fromBlock) throw error;
      stoppedBy = stopReason(error);
      break;
    }

    const rows: FeedbackEventRow[] = [];
    for (const log of logs) {
      const entry = log as {
        args?: { agentId?: bigint; clientAddress?: Address };
        blockNumber?: bigint | null;
        logIndex?: number | null;
        transactionHash?: `0x${string}` | null;
      };
      const agentId = entry.args?.agentId;
      const clientAddress = entry.args?.clientAddress;
      const blockNumber = entry.blockNumber;
      const logIndex = entry.logIndex;
      const txHash = entry.transactionHash;

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

    // 書けなかったら throw のまま（下の checkpoint へ進まない）。行が無いのに
    // checkpoint だけ進むと、その範囲は二度と読まれない＝件数の取りこぼしになる。
    inserted += await record(rows);
    events += logs.length;
    cursor = segmentEnd + 1n;

    // 区切りの行を書き終えてから、その分だけ進める。最後の区切りは下の
    // 「floor と一緒の 1 文」に任せる（prune の前に floor を動かす順序を保つため）。
    if (cursor <= toBlock) {
      await setCheckpoints([
        { scope: FEEDBACK_INDEX_CHECKPOINT, lastBlock: cursor - 1n, chainTipAtRun: chainTip },
        { scope: FEEDBACK_COVERAGE_CHECKPOINT, lastBlock: coverageStart, chainTipAtRun: chainTip },
      ]);
    }
  }

  const scannedTo = cursor - 1n;
  const partial = stoppedBy !== undefined;
  logServerInfoSafe(
    "feedback-indexer", `logs=${events} blocks=${fromBlock}-${scannedTo} in ${now() - t0}ms`,
  );
  if (partial) {
    logServerWarnSafe(
      "feedback-indexer.partial",
      `stopped at ${scannedTo} of ${toBlock} (tip ${chainTip}): ${stoppedBy}`,
    );
  }

  // Retention. Rows before this boundary are gone, so coverage must move with
  // it — a reader that believed in the old coverage start would answer a wide
  // window from rows this line just deleted.
  const pruneBefore = chainTip > retentionBlocks(blocksPerDay)
    ? chainTip - retentionBlocks(blocksPerDay)
    : 0n;
  const nextCoverageStart = pruneBefore > coverageStart ? pruneBefore : coverageStart;
  const caughtUp = cursor > chainTip;

  // 2026-08-18 (audit residual): advance the retention floor BEFORE pruning,
  // and write both checkpoints in one statement. Two failure modes closed:
  //  - Coverage-before-prune: if we crash after moving the floor but before
  //    the prune, the floor points at a boundary where rows STILL exist —
  //    conservative (a reader sees complete data), never an undercount.
  //  - Atomic dual write: the scan cursor and the floor move together, so a
  //    crash can never leave the floor lagging the deleted boundary while the
  //    cursor has advanced past it.
  await setCheckpoints([
    // 最後に読み終えたブロック。追いついた回は chainTip と同じ値（以前のまま）。追いついていない回
    // （maxBlocks で切れた・途中で止まった）は、以前は「次に読むブロック」を書いていたのを改めた。
    { scope: FEEDBACK_INDEX_CHECKPOINT, lastBlock: scannedTo, chainTipAtRun: chainTip },
    { scope: FEEDBACK_COVERAGE_CHECKPOINT, lastBlock: nextCoverageStart, chainTipAtRun: chainTip },
  ]);
  const pruned = pruneBefore > 0n ? await prune(chainId, pruneBefore) : 0;

  return {
    fromBlock: fromBlock.toString(),
    toBlock: scannedTo.toString(),
    coverageStart: nextCoverageStart.toString(),
    events,
    inserted,
    pruned,
    caughtUp,
    partial,
    ...(stoppedBy !== undefined ? { stoppedBy } : {}),
  };
}
