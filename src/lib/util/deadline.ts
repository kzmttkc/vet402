/**
 * Deadlines — turning slowness into something the degradation path can catch.
 *
 * WHY (2026-08-12 incident). The scoring engine wraps every optional chain
 * signal in try/catch so an unavailable upstream degrades to an
 * `*_unavailable` flag and a more cautious verdict — the documented
 * "fail-closed, not fail-wrong" contract. That handler only ever fires on a
 * REJECTION. A dependency that is merely SLOW is invisible to it: the await
 * simply sits there, the honest degradation never runs, and the caller's whole
 * time budget is consumed. In production a 7-day eth_getLogs scan took ~30s
 * against an 8s budget, so /api/demo/score and /agent/[id] both returned
 * "unavailable" by timeout rather than by the designed fallback.
 *
 * A deadline converts "too slow" into "rejected", which is the only shape the
 * existing fail-closed logic can act on. It never makes a verdict more
 * permissive — a missing signal is penalized, not assumed good.
 *
 * ------------------------------------------------------------------
 * 壁時計の期限は「凍結」に対して無力である（2026-09-08 実測・ここが唯一の記載箇所）
 * ------------------------------------------------------------------
 * `withDeadline` の期限は `setTimeout` で作る。タイマーはイベントループが
 * 動いているときにしか進まない。サーバーレス（Vercel Fluid compute）は
 * 応答を返した後のインスタンスを suspend するので、**凍結中は Date.now() だけが
 * 進み、期限は 1 度も発火しない**。
 *
 * 本番の実測（2026-09-08 19:10 JST・admin deep 検査）:
 *   payee=degraded ... payee.latencyMs = 59,957ms
 *   その経路の宣言された上限は PROBE_DEADLINE_MS = 24,000ms
 * しかもこの 59,957ms は withDeadline の **成功側**（degraded + unavailable 一覧）
 * から出ている。期限が発火していれば catch 側の `deadline_exceeded` になっていた。
 *
 * 手元での再現（SIGSTOP/SIGCONT で凍結を模す。同じ形が出る）:
 *   期限 24,000ms・仕事 5,000ms のプロセスを t=1s で 55 秒凍結 →
 *   {"branch":"success","value":"degraded+unavailable","latencyMs":56012}
 *
 * したがって:
 *   - **`withDeadline` の budgetMs は「実行時間の上限」であって「壁時計の上限」ではない。**
 *     凍結を挟むと latencyMs は budgetMs を何倍でも超えうる。数字を読む側が
 *     「上限を超えた = 期限が壊れている」と読まないこと。超えているのは凍結の分。
 *   - 対策はここではない。**応答後に走らせる処理を `next/server` の `after()` に
 *     載せて、そもそも凍結させない**こと（src/lib/util/after-response.ts）。
 *   - 実行時間そのものを縛りたいなら `createDeadline` も同じ制約を持つ
 *     （`Date.now()` 基準なので、凍結中に「残り時間」が消える方向へ壊れる）。
 */

export class DeadlineExceededError extends Error {
  readonly label: string;
  readonly budgetMs: number;

  constructor(label: string, budgetMs: number) {
    super(`deadline_exceeded:${label}:${budgetMs}ms`);
    this.name = "DeadlineExceededError";
    this.label = label;
    this.budgetMs = budgetMs;
  }
}

/**
 * Resolve `work` if it settles within `budgetMs`, otherwise reject with
 * DeadlineExceededError. An underlying rejection is passed through untouched
 * so a real error is never mislabelled as a timeout.
 *
 * The timer is always cleared — a leaked handle would keep a serverless
 * invocation (or a test run) alive past its work.
 */
export function withDeadline<T>(work: Promise<T>, budgetMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new DeadlineExceededError(label, budgetMs)),
      Math.max(0, budgetMs),
    );
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export type Deadline = {
  /** Milliseconds left, clamped at 0. Infinity when unbounded. */
  remaining(): number;
  expired(): boolean;
  /** Budget for one step: the smaller of its own allowance and what's left overall. */
  budgetFor(stepMs: number): number;
  throwIfExpired(label: string): void;
};

/**
 * A shared wall-clock budget for a multi-step operation.
 *
 * Per-step timeouts alone do not bound a SEQUENCE: six steps at 2s each is a
 * 12s worst case inside an 8s request. Steps take their budget from this
 * shared deadline so the total can never exceed it.
 */
export function createDeadline(totalMs?: number): Deadline {
  const expiresAt = totalMs === undefined ? null : Date.now() + Math.max(0, totalMs);

  const remaining = () => (expiresAt === null ? Infinity : Math.max(0, expiresAt - Date.now()));

  return {
    remaining,
    expired: () => remaining() <= 0,
    budgetFor: (stepMs: number) => Math.min(stepMs, remaining()),
    throwIfExpired(label: string) {
      if (remaining() <= 0) {
        throw new DeadlineExceededError(label, totalMs ?? 0);
      }
    },
  };
}
