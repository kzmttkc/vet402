import { after } from "next/server";

/**
 * 応答を返した「後」に走る処理を、プラットフォームに見える形で登録する。
 *
 * WHY（2026-09-08 の実測）。/api/health は判定を返してから
 * `void recordHealthSnapshotIfDue(...)` を撃ち、payee probe は
 * stale-while-revalidate の裏側リフレッシュを撃っていた。どちらも
 * **誰も待っていない promise** で、サーバーレスの実行環境から見れば
 * 「もう終わった呼び出し」の中で走っている。
 *
 * Vercel の一次資料（docs 2026-09-03 版）:
 *   - `waitUntil` は "Extends the lifetime of the request handler for the
 *     lifetime of the given Promise" ——渡さない promise の生存期間は延びない
 *   - `attachDatabasePool` は idle client を "released **before functions
 *     suspend**" と説明する ——Fluid compute でもインスタンスは suspend する
 *   - Next.js 15.1 以上では `waitUntil` ではなく `next/server` の `after()`
 *
 * Fluid は同じインスタンスを温かいまま使い回すので、裏側処理は「消える」
 * のではなく「**次に誰かがそのインスタンスを起こすまで止まる**」。
 * だから壁時計だけが進み、モジュールスコープのキャッシュは古いまま配られる。
 * 実測は 2 本ある——本番の payee.latencyMs 59,957ms（宣言上限 24,000ms）と、
 * 手元で SIGSTOP/SIGCONT で再現した 56,012ms。
 * 詳細は src/lib/util/deadline.ts の「凍結」節と tests/health-after-response.test.ts。
 *
 * ここを通せば、その処理が終わるまで invocation が終わらない。
 */
export type AfterResponseScheduler = (task: () => Promise<void>) => void;

/**
 * テスト用の差し替え口（`resetPayeeProbeCache` と同じ性格）。
 * `null` を渡すと本番の経路（`after()`）へ戻る。
 */
let override: AfterResponseScheduler | null = null;

export function setAfterResponseSchedulerForTest(scheduler: AfterResponseScheduler | null): void {
  override = scheduler;
}

/**
 * `after()` は request scope の外で必ず throw する（next 16.3.0 実測:
 * "`after` was called outside a request scope."）。スクリプト・テスト・
 * 将来の別経路からの呼び出しでヘルスチェックを落とすわけにはいかないので、
 * 文脈が無いときはその場で走らせる——**登録できないことは、やらない理由にならない**。
 */
function scheduleWithAfter(task: () => Promise<void>): void {
  try {
    after(task);
  } catch {
    void task();
  }
}

/** 例外を絶対に外へ出さない包み。裏側処理の失敗で応答や invocation を壊さない。 */
function guard(task: () => Promise<unknown>): () => Promise<void> {
  return async () => {
    try {
      await task();
    } catch {
      // 呼び出し側が自分でログを出す。ここは最後の砦。
    }
  };
}

/**
 * まだ始めていない処理を、応答を返した後に走らせる。
 * 応答の組み立てと DB 書き込みを競合させない分、`keepAliveUntilSettled` より好ましい。
 */
export function runAfterResponse(task: () => Promise<unknown>): void {
  (override ?? scheduleWithAfter)(guard(task));
}

/**
 * **すでに走り始めている**処理を登録し、それが決着するまで invocation を終わらせない。
 * 開始のタイミングを変えたくないとき（stale-while-revalidate の裏側リフレッシュは
 * 遅らせるほどキャッシュが古くなる）に使う。
 */
export function keepAliveUntilSettled(work: Promise<unknown>): void {
  // 登録の前に自前で握っておく。scheduler が task を呼ばない実装（テストの捕捉役）
  // でも unhandled rejection にしないため。
  const settled = work.then(
    () => undefined,
    () => undefined,
  );
  (override ?? scheduleWithAfter)(() => settled);
}
