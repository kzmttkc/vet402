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
 * 時間の上限 3 つ。cron の maxDuration は 300 秒（src/app/api/cron/index-owners/route.ts）。
 * 300 秒でプラットフォームに殺されると応答も最後の checkpoint も消えるので、全部その手前で自分から止まる。
 *
 *  - DEFAULT_TIME_BUDGET_MS（170 秒）: これを過ぎたら新しい区切りを始めない。
 *  - DEFAULT_HARD_STOP_MS（200 秒）: 読んでいる途中の区切りも、ここで待つのをやめて捨てる。
 *    getLogsChunked に渡す期限は「次の要求を出さない」だけで、出してしまった 1 要求は transport の
 *    timeout 20 秒 × 最大 4 回まで返らないことがあるので、壁時計でも切る（withDeadline）。
 *  - DEFAULT_WRITE_DEADLINE_MS（270 秒）: 書き込みはここで次の文を始めない（走っている文は待つ）。
 *    書き終わらなかった区切りは checkpoint を進めずに応答を返す（stoppedBy: "write_deadline"）。
 *    次の回が同じ区切りを読み直す。最初の区切りで当たった回だけは throw する（読み取りの失敗と同じ）。
 *
 * 書き込みに残る時間は 270 − 200 = 70 秒以上。所有者索引の最も重い区切り（10/31 手元実測で
 * 18.5 万 agentId）の書き込みは 1,000 行ずつ・4 本並列・upsert の段と delete の段で 94 往復。
 * 手元の Postgres で 18.5 万 agentId を全部 wipe して 1 行ずつ残す形（最も重い形）を測ると 370 文で 5.7〜8.0 秒
 * （10/31・3 回）。70 秒はその 8.7 倍で、Neon HTTP なら 1 往復 0.74 秒（文の実行込み）まで耐える。
 * 270 秒の後に残るのは走っている文の終わり・checkpoint・応答で、300 秒まで 30 秒ある。
 */
export const DEFAULT_TIME_BUDGET_MS = 170_000;
export const DEFAULT_HARD_STOP_MS = 200_000;
export const DEFAULT_WRITE_DEADLINE_MS = 270_000;

export type SegmentedScanOptions = {
  segmentBlocks?: bigint;
  timeBudgetMs?: number;
  hardStopMs?: number;
  /** 書き込みで次の文を始めてよい経過時間（ms）。既定 DEFAULT_WRITE_DEADLINE_MS。 */
  writeDeadlineMs?: number;
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
  /** 途中で止まったときだけ: `time_budget`・`hard_stop`・`write_deadline`・`rpc:<読み先の言い分>`。 */
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
  /**
   * 読んだ区切りを書く。shouldStop() が true になったら次の文を始めずに DeadlineExceededError を投げる
   * （その区切りは checkpoint を進めずに止まる）。それ以外に投げたものは run ごと投げる。
   */
  write: (read: SegmentRead<R>, control: { shouldStop: () => boolean }) => Promise<void>;
  /** 書き終えた区切りの最後のブロックを checkpoint にする。 */
  checkpoint: (lastBlock: bigint) => Promise<void>;
}): Promise<SegmentedScanResult> {
  const { fromBlock, toBlock, options } = input;
  const now = options?.now ?? Date.now;
  const segmentBlocks =
    options?.segmentBlocks !== undefined && options.segmentBlocks > 0n ? options.segmentBlocks : DEFAULT_SEGMENT_BLOCKS;
  const timeBudgetMs = options?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const hardStopMs = options?.hardStopMs ?? DEFAULT_HARD_STOP_MS;
  const writeDeadlineMs = options?.writeDeadlineMs ?? DEFAULT_WRITE_DEADLINE_MS;
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

    try {
      await input.write(read, { shouldStop: () => now() - t0 >= writeDeadlineMs });
    } catch (error) {
      // 期限で書き終わらなかった区切り: checkpoint は前のまま、応答は返す（関数ごと殺されない）。
      // 書けた分は残るが、どれも何度書いても同じ結果の文で、次の回が同じ区切りを書き直す。
      // 最初の区切りなら throw（cron は ok:false・500）: 1 ブロックも進まない回を ok:true で返すと、
      // 毎日同じ区切りで止まっている索引が緑に見える（2026-10-31 再レビュー N-1）。
      if (error instanceof DeadlineExceededError) {
        if (segments === 0) throw error;
        stoppedBy = "write_deadline";
        break;
      }
      throw error;
    }
    await input.checkpoint(read.lastBlock);
    segments++;
    cursor = read.lastBlock + 1n;
  }

  return { scannedTo: cursor - 1n, segments, ...(stoppedBy !== undefined ? { stoppedBy } : {}) };
}
