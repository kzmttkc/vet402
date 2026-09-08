// ============================================================
// `feedback_stats_unavailable` alone does not say WHICH path raised it
// (2026-09-09).
//
// MEASURED IN PRODUCTION, the first rows that ever carried a reason:
//
//   09-09 01:30:38 | degraded | lat=3853 | iad1:e35d89c1
//                  | scoring=degraded fresh:  feedback_stats_unavailable; payee=ok cached
//   09-09 01:42:38 | degraded | lat=3721 | iad1:d30924f1
//                  | scoring=degraded fresh:  feedback_stats_unavailable; payee=ok cached
//
// The failed input got a name. The path that raised it did not. Reading the
// code, the flag is set by `!feedbackResult.ok` in the scoring engine, and a
// rejection can arrive there from at least five different places:
//
//   1. the engine's own 3,500ms `withDeadline(..., "feedback_stats")`
//   2. the tail scan's own 2,500ms deadline inside getLogsChunked
//   3. erc8004.ts — the unindexed tail is wider than 2 days
//   4. erc8004.ts — no index at all (no DB / no checkpoint / no migration)
//   5. erc8004.ts — an index that does not reach back to the window start
//
// 3, 4 and 5 threw the SAME string, so even carrying the error message up
// could not have separated them. 1 and 2 are both "deadline_exceeded" and
// differ only by label. And the engine did not carry the error to the health
// probe at all — it kept a boolean and rebuilt the flag name from it.
//
// This file pins the three pieces that make the next degraded row decide it:
//   1. the source-selection rules name their own reason (pure, no RPC/DB)
//   2. a failure is classified into a stable, low-cardinality, secret-free code
//   3. detail carries that code next to the flag, and says so when it has none
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { planFeedbackSources } from "@/lib/chain/feedback-window";
import { classifyDegradation, describeUnavailable } from "@/lib/health/probe-detail";
import { reportSignalDegraded } from "@/lib/scoring/engine";
import { DeadlineExceededError } from "@/lib/util/deadline";

// ------------------------------------------------------------
// 1. どの経路で degrade したかを、純粋な規則の側が名乗る
// ------------------------------------------------------------

const TAIL_MAX = 86_400n; // 2 日ぶん（Base 43,200 blocks/day）

test("index が無いときと、index が窓を覆えないときは別の理由になる", () => {
  const absent = planFeedbackSources({
    index: null,
    fromBlock: 1_000n,
    latestBlock: 2_000n,
    tailMax: TAIL_MAX,
    allowFullScan: false,
  });
  const tooYoung = planFeedbackSources({
    index: { coverageStart: 1_500n, checkpoint: 1_900n },
    fromBlock: 1_000n,
    latestBlock: 2_000n,
    tailMax: TAIL_MAX,
    allowFullScan: false,
  });
  assert.deepEqual(absent, { kind: "unavailable", reason: "index_absent" });
  assert.deepEqual(tooYoung, { kind: "unavailable", reason: "window_not_covered" });
});

test("index は窓を覆うが tip から離れすぎているときは、さらに別の理由になる", () => {
  const plan = planFeedbackSources({
    index: { coverageStart: 500n, checkpoint: 1_000n },
    fromBlock: 1_000n,
    latestBlock: 1_000_000n,
    tailMax: TAIL_MAX,
    allowFullScan: false,
  });
  assert.deepEqual(plan, { kind: "unavailable", reason: "index_behind_tip" });
});

test("3 つの理由はすべて異なる文字列——同じ名前で 2 つの原因を呼ばない", () => {
  const reasons = ["index_absent", "window_not_covered", "index_behind_tip"];
  assert.equal(new Set(reasons).size, 3);
});

test("覆えているときは degrade せず、読む必要のある tail の幅を返す", () => {
  const index = { coverageStart: 500n, checkpoint: 1_900n };
  assert.deepEqual(
    planFeedbackSources({
      index,
      fromBlock: 1_000n,
      latestBlock: 2_000n,
      tailMax: TAIL_MAX,
      allowFullScan: false,
    }),
    { kind: "index_and_tail", gap: 100n, index },
  );
  // checkpoint が tip 以上なら tail は無い（負の gap を作らない）
  const caughtUp = { coverageStart: 500n, checkpoint: 2_500n };
  assert.deepEqual(
    planFeedbackSources({
      index: caughtUp,
      fromBlock: 1_000n,
      latestBlock: 2_000n,
      tailMax: TAIL_MAX,
      allowFullScan: false,
    }),
    { kind: "index_and_tail", gap: 0n, index: caughtUp },
  );
});

test("allowFullScan の呼び出し側（cron）は degrade せず全走査へ行く——今までどおり", () => {
  assert.deepEqual(
    planFeedbackSources({
      index: null,
      fromBlock: 1_000n,
      latestBlock: 2_000n,
      tailMax: TAIL_MAX,
      allowFullScan: true,
    }),
    { kind: "full_scan" },
  );
});

test("tail が広すぎる判定は allowFullScan でも degrade のまま——2026-08-12 の判定を変えない", () => {
  // 元の fetchRecentFeedbackStats はこの throw を allowFullScan より **手前** に
  // 置いていた。理由を名乗らせるだけの変更で、どの入力がどう倒れるかを動かさない。
  assert.deepEqual(
    planFeedbackSources({
      index: { coverageStart: 500n, checkpoint: 1_000n },
      fromBlock: 1_000n,
      latestBlock: 1_000_000n,
      tailMax: TAIL_MAX,
      allowFullScan: true,
    }),
    { kind: "unavailable", reason: "index_behind_tip" },
  );
});

// ------------------------------------------------------------
// 2. 落ちた error を、低カーディナリティで秘密を含まない 1 語にする
// ------------------------------------------------------------

test("エンジンの期限切れと、内側の tail 走査の期限切れを取り違えない", () => {
  assert.equal(
    classifyDegradation(new DeadlineExceededError("feedback_stats", 3_500)),
    "deadline:feedback_stats",
  );
  assert.equal(
    classifyDegradation(new DeadlineExceededError("getLogsChunked", 2_500)),
    "deadline:getLogsChunked",
  );
});

test("期限のミリ秒は理由に入れない——budgetFor は残り時間で変わるので行が毎回別物になる", () => {
  const a = classifyDegradation(new DeadlineExceededError("feedback_stats", 3_500));
  const b = classifyDegradation(new DeadlineExceededError("feedback_stats", 2_812));
  assert.equal(a, b);
  assert.doesNotMatch(a, /\d/);
});

test("erc8004 が名乗った理由はそのまま 1 語になる", () => {
  assert.equal(
    classifyDegradation(new Error("feedback_stats_unavailable:index_behind_tip")),
    "index_behind_tip",
  );
  assert.equal(
    classifyDegradation(new Error("feedback_stats_unavailable:window_not_covered")),
    "window_not_covered",
  );
  assert.equal(
    classifyDegradation(new Error("feedback_stats_unavailable:index_absent")),
    "index_absent",
  );
});

test("知らない上流エラーは本文を運ばない——秘密と無制限のカーディナリティを列へ入れない", () => {
  class HttpRequestError extends Error {}
  const reason = classifyDegradation(
    new HttpRequestError("HTTP 401 https://rpc.example/v2/SUPER_SECRET_KEY"),
  );
  assert.equal(reason, "upstream_error:HttpRequestError");
  assert.doesNotMatch(reason, /SUPER_SECRET_KEY/);
  assert.doesNotMatch(reason, /rpc\.example/);
});

test("Error ですらない throw も 1 語になる（黙って落とさない）", () => {
  assert.equal(classifyDegradation("boom"), "upstream_error:unknown");
  assert.equal(classifyDegradation(undefined), "upstream_error:unknown");
});

// ------------------------------------------------------------
// 3. detail が flag のとなりに理由を載せる
// ------------------------------------------------------------

test("detail は flag と、それを立てた経路の両方を持つ", () => {
  const detail = describeUnavailable(
    ["feedback_stats_unavailable"],
    new Map([["feedback_stats", "deadline:feedback_stats"]]),
  );
  assert.equal(detail, "feedback_stats_unavailable(deadline:feedback_stats)");
});

test("同じ flag でも経路が違えば detail が違う——次の degraded で決着する条件", () => {
  const byDeadline = describeUnavailable(
    ["feedback_stats_unavailable"],
    new Map([["feedback_stats", "deadline:feedback_stats"]]),
  );
  const byCoverage = describeUnavailable(
    ["feedback_stats_unavailable"],
    new Map([["feedback_stats", "window_not_covered"]]),
  );
  assert.notEqual(byDeadline, byCoverage);
});

test("signal 名と flag 名がずれている x402 も取り違えない", () => {
  // engine の signal は "x402_stats"、flag は "x402_unavailable"。
  // 素朴な接尾辞剥がしだと両者が繋がらず、理由が黙って落ちる。
  const detail = describeUnavailable(
    ["x402_unavailable"],
    new Map([["x402_stats", "upstream_error:PostgresError"]]),
  );
  assert.equal(detail, "x402_unavailable(upstream_error:PostgresError)");
});

test("理由を取れなかった flag は「取れなかった」と書く——黙って ok の形にしない", () => {
  // エンジンの 5 分キャッシュに当たると flag だけが残り、経路は走っていない。
  const detail = describeUnavailable(["feedback_stats_unavailable"], new Map());
  assert.equal(detail, "feedback_stats_unavailable(unrecorded)");
});

test("flag が無ければ detail も無い（今までどおり）", () => {
  assert.equal(describeUnavailable([], new Map()), null);
});

test("理由を渡さない既存の呼び出しは今までと同じ 1 行（後方互換）", () => {
  assert.equal(
    describeUnavailable(["feedback_stats_unavailable", "x402_unavailable"]),
    "feedback_stats_unavailable,x402_unavailable",
  );
});

test("detail の上限は理由を足しても守られる", () => {
  const flags = Array.from({ length: 40 }, (_, i) => `signal_${i}_unavailable`);
  const reasons = new Map(flags.map((f, i) => [`signal_${i}`, "upstream_error:VeryLongErrorName"]));
  const detail = describeUnavailable(flags, reasons) ?? "";
  assert.ok(detail.length <= 600, `detail が長すぎる: ${detail.length}`);
  assert.doesNotMatch(detail, /\n/);
});

// ------------------------------------------------------------
// 4. エンジンが理由を外へ渡す（渡さなければ probe は永久に flag しか見ない）
// ------------------------------------------------------------

test("degrade した signal は ctx の sink へ error ごと渡る", () => {
  const seen: { signal: string; error: unknown }[] = [];
  const error = new DeadlineExceededError("feedback_stats", 3_500);
  reportSignalDegraded("feedback_stats", error, {
    onSignalDegraded: (signal, err) => seen.push({ signal, error: err }),
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.signal, "feedback_stats");
  assert.equal(seen[0]!.error, error);
});

test("sink が無い呼び出し（本番の通常経路）でも投げない", () => {
  assert.doesNotThrow(() => reportSignalDegraded("feedback_stats", new Error("x"), {}));
  assert.doesNotThrow(() => reportSignalDegraded("feedback_stats", new Error("x")));
});

test("degrade を記録する呼び出しが ctx を渡し忘れていない（禁止形）", () => {
  const engine = readFileSync(join(process.cwd(), "src/lib/scoring/engine.ts"), "utf8");
  const calls = (engine.match(/reportSignalDegraded\([^)]*\)/g) ?? []).filter(
    (call) => !call.includes("signal: string"), // 定義そのものは呼び出しではない
  );
  assert.ok(calls.length >= 5, `記録の呼び出しが減っている: ${calls.length}`);
  for (const call of calls) {
    assert.match(call, /,\s*ctx\s*\)$/, `ctx を渡していない: ${call}`);
  }
});

// ------------------------------------------------------------
// 5. 公開面は 1 語のまま（この変更で漏らさない）
// ------------------------------------------------------------

test("理由は公開本文にも /status にも出さない", () => {
  const route = readFileSync(join(process.cwd(), "src/app/api/health/route.ts"), "utf8");
  assert.match(route, /NextResponse\.json\(\s*\{\s*status\s*\}\s*,\s*\{\s*status:\s*httpStatus\s*\}\s*\)/);
  const page = readFileSync(join(process.cwd(), "src/app/status/page.tsx"), "utf8");
  assert.doesNotMatch(page, /detail/i);
  assert.doesNotMatch(page, /unavailable/i);
});
