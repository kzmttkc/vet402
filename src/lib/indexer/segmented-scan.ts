import { DeadlineExceededError, withDeadline } from "@/lib/util/deadline";
import { redactSecretsForLog } from "@/lib/util/log-safe";

/**
 * identity registry の 2 つの索引（owner-indexer・agent-wallet-indexer）が共有する
 * 「区切りごとに 読む → 書く → checkpoint」の回し方（2026-10-31）。
 *
 * feedback-indexer（2026-10-13）と同じ考え方を、2 つの索引で 1 か所にまとめたもの。
 *
 * WHY. 以前の 2 つは 1 回の run の全範囲（本番 250,000 ブロック）を読み切ってから書き、
 * checkpoint は最後に 1 回だけ進めた。10/8 から getLogs は 1 回 1,000 ブロックまでの予備の
 * 読み先に回り、しかも 10 月の Base には 20,000 ブロックに Transfer が 28〜44 万件ある所がある
 * （10/31 実測）。1 回の run が 300 秒の中で終わらず関数ごと殺されると、読んだ分も
 * checkpoint も 1 つも残らないので、遅れた索引ほど追いつけない形だった。
 *
 * ここが守ること:
 *  - checkpoint に書くのは「読み終えて、書き終えた区切りの最後のブロック」だけ。
 *    区切りの途中のブロックを checkpoint にしない。
 *  - 新しい区切りを始めてよいのは timeBudgetMs まで。最初の区切りだけは予算に関係なく試す
 *    （「何も試さずに成功」を返さない）。
 *  - 読んでいる途中の区切りも hardStopMs で待つのをやめ、その区切りは書かずに捨てる
 *    （checkpoint は前の区切りの終わりのまま。次の回が同じ所から読む）。
 *  - 最初の区切りが読めなかった回は throw（cron は 500・checkpoint は動かない）。
 *    「読めていないのに成功」を返すと、止まった索引が緑に見える。
 *  - 書き込みの失敗は区切りの番号に関係なく throw。書けなかった区切りの先へ checkpoint は進まない。
 */

/** 1 区切りのブロック数。Base の約 11 時間。平常（1 日 1 回）は 3 区切りで終わる。 */
export const DEFAULT_SEGMENT_BLOCKS = 20_000n;

/**
 * 時間の上限 2 つ。cron の maxDuration は 300 秒（src/app/api/cron/index-owners/route.ts）。
 *
 *  - DEFAULT_TIME_BUDGET_MS（180 秒）: これを過ぎたら新しい区切りを始めない。
 *  - DEFAULT_HARD_STOP_MS（230 秒）: 読んでいる途中の区切りも、ここで待つのをやめて捨てる。
 *    getLogsChunked に渡す期限は「次の要求を出さない」だけで、出してしまった 1 要求は transport の
 *    timeout 20 秒 × 最大 4 回まで返らないことがあるので、壁時計でも切る（withDeadline）。
 *
 * feedback-indexer（200 / 250 秒）より 20 秒ずつ早いのは、所有者索引の 1 区切りの書き込みが
 * 重いから（読み終えた後に最大 10 万件ぶんの upsert / delete。500 行ずつ・4 本並列で数十秒）。
 * 230 秒で読み終えた区切りの書き込みと checkpoint に、300 秒まで 70 秒を残す。
 */
export const DEFAULT_TIME_BUDGET_MS = 180_000;
export const DEFAULT_HARD_STOP_MS = 230_000;

export type SegmentedScanOptions = {
  segmentBlocks?: bigint;
  timeBudgetMs?: number;
  hardStopMs?: number;
  now?: () => number;
  /** 呼び手がすでに測り始めた時刻（2 つの索引を同じ持ち時間で回すとき）。既定は呼んだ時の now()。 */
  startedAt?: number;
};

/** 読み取りの側から使う時計。 */
export type ScanClock = {
  /** hardStopMs までの残り（ms）。0 以下なら DeadlineExceededError を投げる。 */
  remainingMs: () => number;
  /** 残り時間の中で待つ。残りが無ければ待たずに投げる。 */
  within: <T>(work: (remainingMs: number) => Promise<T>, label: string) => Promise<T>;
};

export type SegmentRead<R> = {
  /** この区切りで読み終えた最後のブロック（maxTo 以下。件数が多すぎるときは手前で切ってよい）。 */
  lastBlock: bigint;
  payload: R;
};

export type SegmentedScanResult = {
  /** 最後に読み終えて書き終えたブロック。1 区切りも終わらなかった回は無い（throw する）。 */
  scannedTo: bigint;
  segments: number;
  /** 途中で止まったときだけ: `time_budget`・`hard_stop`・`rpc:<読み先の言い分>`。 */
  stoppedBy?: string;
};

export function scanStopReason(error: unknown): string {
  if (error instanceof DeadlineExceededError) return "hard_stop";
  const err = error as { details?: string; shortMessage?: string; message?: string };
  const text = err?.details ?? err?.shortMessage ?? err?.message ?? String(error);
  // 1 行・短く・URL と鍵は伏せる（cron の応答とログに出る）。
  return `rpc:${redactSecretsForLog(String(text)).replace(/https?:\/\/\S+/g, "<url>").split("\n")[0]!.slice(0, 160)}`;
}

export async function runSegmentedScan<R>(input: {
  fromBlock: bigint;
  toBlock: bigint;
  options?: SegmentedScanOptions;
  /** [from, maxTo] を読む。RPC の失敗・期限切れはここで投げる。 */
  read: (from: bigint, maxTo: bigint, clock: ScanClock) => Promise<SegmentRead<R>>;
  /** 読んだ区切りを書く。ここで投げたものは run ごと投げる。 */
  write: (read: SegmentRead<R>) => Promise<void>;
  /** 書き終えた区切りの最後のブロックを checkpoint にする。 */
  checkpoint: (lastBlock: bigint) => Promise<void>;
}): Promise<SegmentedScanResult> {
  const { fromBlock, toBlock, options } = input;
  const now = options?.now ?? Date.now;
  const segmentBlocks =
    options?.segmentBlocks !== undefined && options.segmentBlocks > 0n ? options.segmentBlocks : DEFAULT_SEGMENT_BLOCKS;
  const timeBudgetMs = options?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const hardStopMs = options?.hardStopMs ?? DEFAULT_HARD_STOP_MS;
  const t0 = options?.startedAt ?? now();

  const clock: ScanClock = {
    remainingMs: () => hardStopMs - (now() - t0),
    within: async (work, label) => {
      const remaining = hardStopMs - (now() - t0);
      if (remaining <= 0) throw new DeadlineExceededError(label, hardStopMs);
      return withDeadline(work(remaining), remaining, label);
    },
  };

  let cursor = fromBlock;
  let segments = 0;
  let stoppedBy: string | undefined;

  while (cursor <= toBlock) {
    if (segments > 0 && now() - t0 >= timeBudgetMs) {
      stoppedBy = "time_budget";
      break;
    }
    const maxTo = cursor + segmentBlocks - 1n > toBlock ? toBlock : cursor + segmentBlocks - 1n;

    let read: SegmentRead<R>;
    try {
      read = await input.read(cursor, maxTo, clock);
      // 読み終えた時点で上限を越えていたら、書かずに捨てる（書き込みの時間を残すため）。
      if (clock.remainingMs() <= 0) throw new DeadlineExceededError("segment", hardStopMs);
    } catch (error) {
      if (segments === 0) throw error;
      stoppedBy = scanStopReason(error);
      break;
    }
    if (read.lastBlock < cursor || read.lastBlock > maxTo) {
      throw new Error(`segmented_scan_bad_last_block:${read.lastBlock}:${cursor}-${maxTo}`);
    }

    await input.write(read);
    await input.checkpoint(read.lastBlock);
    segments++;
    cursor = read.lastBlock + 1n;
  }

  return { scannedTo: cursor - 1n, segments, ...(stoppedBy !== undefined ? { stoppedBy } : {}) };
}
