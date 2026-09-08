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

import { DeadlineExceededError } from "@/lib/util/deadline";

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

/**
 * 落ちた 1 つの signal を、**行の識別子として使える 1 語**にする（2026-09-09）。
 *
 * WHY THIS EXISTS. degraded の detail は `feedback_stats_unavailable` までしか
 * 言わなかった。その flag は engine.ts の `!feedbackResult.ok` 1 箇所から立ち、
 * そこへ届く rejection の出所は少なくとも 5 つある——エンジン自身の 3,500ms
 * 期限、tail 走査の内側 2,500ms 期限、そして erc8004 の 3 分岐。
 * 2026-09-09 01:30 JST の本番の行はどれとも読めた。
 *
 * 形は 2 つの制約で決まる。
 *
 * 1. **可変値を入れない。** この語は detail に載り、detail は
 *    shouldRecordSnapshot の比較対象になる。期限のミリ秒を書くと
 *    `budgetFor` が残り時間で返す値ごとに別の行になる（3,500 とは限らない）。
 *    だからラベルだけを取り、数字は latency_ms 列の側に任せる。
 * 2. **知らない error の本文を運ばない。** 上流の message には URL や鍵が
 *    入りうる。名指しできるのは**クラス名**まで——形は伝わり、秘密は乗らない。
 */
export function classifyDegradation(error: unknown): string {
  if (error instanceof DeadlineExceededError) return `deadline:${error.label}`;
  if (error instanceof Error) {
    // `<signal>_unavailable:<reason>` は自分たちが名乗った形（feedback-window.ts）。
    const named = /^[a-z0-9_]+_unavailable:([a-z0-9_]{1,40})$/.exec(error.message);
    if (named) return named[1]!;
    // `name` を先に見るのは、viem や pg のエラーがそこへ明示的に書くから
    // （バンドラの minify でクラス名が潰れても残る）。書いていない素朴な
    // サブクラスは既定の "Error" のままなので、そのときだけ実クラス名を見る。
    const name =
      error.name && error.name !== "Error" ? error.name : (error.constructor?.name ?? error.name);
    return `upstream_error:${name || "unknown"}`;
  }
  return "upstream_error:unknown";
}

/**
 * engine の signal 名 → flag 名がずれている組。
 * 素朴な `_unavailable` の剥がしだと繋がらず、理由が黙って落ちる。
 */
const FLAG_TO_SIGNAL: Readonly<Record<string, string>> = {
  x402: "x402_stats",
};

/**
 * degraded のときの理由——読めなかった入力の一覧と、**それを立てた経路**。
 *
 * `reasons` は engine が ctx.onSignalDegraded で渡してきた signal→理由。
 * 渡ってこなかった flag は `(unrecorded)` と書く。エンジンの 5 分キャッシュに
 * 当たった回は flag だけが残って経路は走っていないので、そこを空欄にすると
 * 「理由の無い degraded」と「理由を見ていない degraded」が同じ顔になる。
 */
export function describeUnavailable(
  unavailable: readonly string[],
  reasons?: ReadonlyMap<string, string>,
): string | null {
  if (unavailable.length === 0) return null;
  if (!reasons) return oneLine(unavailable.join(","), MAX_DETAIL);
  const parts = unavailable.map((flag) => {
    const base = flag.replace(/_unavailable$/, "");
    const reason = reasons.get(base) ?? reasons.get(FLAG_TO_SIGNAL[base] ?? base);
    return `${flag}(${reason ?? "unrecorded"})`;
  });
  return oneLine(parts.join(","), MAX_DETAIL);
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
