/**
 * なぜ落ちたかを、1 行の・低カーディナリティの・秘密を含まない文字列にする。
 *
 * WHY THIS EXISTS (2026-09-08). /api/health が断続的に 503 {"status":"error"}
 * を返していた。理由はどこにも残っていなかった。console.error は出るが、
 * Vercel CLI の `vercel logs` は直近 12 件しか返さず MESSAGE 列を落とすので、
 * 30 分後には「503 だった」という 1 ビットしか手元に無い。health_snapshots も
 * status 1 列しか持たないので、表からも名指しできなかった。
 *
 * この文字列は console.error の行と**同じ材料**から作る。ログと列が食い違うと、
 * どちらが本当かを確かめる作業がもう 1 つ増えるだけになる。
 *
 * 設計上の制約が 2 つある。
 *
 * 1. **低カーディナリティ**。この文字列は shouldRecordSnapshot の
 *    「detail が変わったら書く」判定に使う。レイテンシやインスタンス識別子を
 *    ここへ混ぜると、リクエスト毎に文字列が変わって表が 1 リクエスト 1 行に
 *    膨らむ。だから可変値は別列に置き、ここには
 *    「どちらの probe が・どの状態で・実測かキャッシュか・原因タグ」だけを入れる。
 * 2. **上限つきの 1 行**。エラーの message と cause は上流が作る任意長の文字列で、
 *    改行や本文まるごとが入りうる。列に入れるものは自分で長さと形を決める。
 */

/** detail 全体の上限。Postgres の text に上限は無いが、表を読む人間の側にある。 */
const MAX_DETAIL = 600;
const MAX_MESSAGE = 200;
const MAX_CAUSE = 300;

function oneLine(value: string, limit: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, limit);
}

/**
 * probe が投げた error を「なぜ落ちたか」の 1 行にする。
 *
 * DeadlineExceededError は message が `deadline_exceeded:<label>:<budget>ms` なので、
 * そのまま**タイムアウトと上流エラーの区別**になる。probe が自分の期限で死んだのか、
 * 上流が拒否したのかは、資源を足す先が違う（前者は期限か上流の遅さ、後者は上流の可用性）。
 *
 * scoring エンジンは上流の失敗を `new Error(tag, { cause })` に包む。tag
 * （"agent_identity_unavailable"）は**どの読みが死んだか**しか言わず、
 * **なぜ**は cause の側にある。運用者に要るのは後半なので両方運ぶ。
 */
export function describeProbeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  const causeText =
    cause instanceof Error
      ? ` | cause: ${(cause as { details?: string })?.details ?? cause.message}`
      : "";
  return oneLine(
    `${oneLine(message, MAX_MESSAGE)}${oneLine(causeText, MAX_CAUSE)}`,
    MAX_DETAIL,
  );
}

/** degraded のときの理由——読めなかった入力の一覧。 */
export function describeUnavailable(unavailable: readonly string[]): string | null {
  if (unavailable.length === 0) return null;
  return oneLine(unavailable.join(","), MAX_DETAIL);
}

/**
 * 1 つの probe の状態を 1 区間にする: `scoring=error fresh: <reason>`
 *
 * `fresh` / `cached` を必ず書くのがこの関数の要点。2026-09-08 の調査で、
 * 赤と緑を分けていたのは**キャッシュの齢**だった（下の liveness.ts の注記）。
 * 「測った結果 ok だった」と「前に測った ok を出しただけ」を同じ ok として
 * 記帳すると、表は健全性ではなくポーリング間隔を記録することになる。
 */
export function probeSegment(
  name: "scoring" | "payee",
  status: "ok" | "degraded" | "error",
  fromCache: boolean,
  reason: string | null,
): string {
  const head = `${name}=${status} ${fromCache ? "cached" : "fresh"}`;
  return reason ? `${head}: ${reason}` : head;
}

/** 両 probe の区間をつないだ 1 行。上限で切る。 */
export function composeDetail(segments: readonly string[]): string {
  return oneLine(segments.join("; "), MAX_DETAIL);
}
