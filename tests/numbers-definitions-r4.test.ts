// ============================================================
// 2026-09-29 敵対的監査 4 周目（競合エンジニアの立場）で見つかった「数字の定義」の食い違いを固定する。
//
//   1. トップの「L0 pass 21,229」が掲載中 20,086 を上回っていた（掲載落ちを含む数）
//      → publishedPassActive を別に出し、トップは掲載中の数を使う
//   2. /accuracy の「vet402 側の失敗」と /sellers の「vet402's side」と CSV の保留率が同じ名前で別の数
//      → 率の分子・分母（slo.l1_7d）を出し、名前を分ける
//   3. export.csv の spent_units は署名額で、tx が無くても価格が入る → confirmed_units（別の列）
//      （列の検査は tests/export-request-body.test.ts）
//   4. 「with receipt」2,958 に vet402 の索引が紐付けた行が混ざる → 売り手のレシート／索引のみ に分ける
//   5. 09-28 の測定が 09-29 UTC に「today」→ UTC の暦日で数える
//   6. backtest の定義文は 4 status、SQL は settle_claimed も数えていた → 同じ配列から作る
//   8. 非推奨のスコアが ALLOW を返しても応答は何も言わなかった → 本文とヘッダに非推奨を載せる
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse, NextRequest } from "next/server";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const squash = (s: string) => s.replace(/\s+/g, " ");

test("5. 最終 probe の経過日数は UTC の暦日の差（前日夕方の probe は翌日未明に 1）", async () => {
  const { utcCalendarDaysBetween } = await import("@/lib/observatory/reader");
  // 監査の実例: 2026-09-28 16:40 UTC の probe を 2026-09-29 00:22 UTC に読んだ。
  assert.equal(utcCalendarDaysBetween(new Date("2026-09-28T16:40:07Z"), new Date("2026-09-29T00:22:42Z")), 1);
  assert.equal(utcCalendarDaysBetween(new Date("2026-09-29T00:01:00Z"), new Date("2026-09-29T23:59:00Z")), 0);
  assert.equal(utcCalendarDaysBetween(new Date("2026-09-20T23:59:59Z"), new Date("2026-09-29T00:00:00Z")), 9);
  // 時計のずれで未来の probe になっても負にしない。
  assert.equal(utcCalendarDaysBetween(new Date("2026-09-30T00:00:00Z"), new Date("2026-09-29T12:00:00Z")), 0);
});

test("1・4. state API は掲載中の pass と、settled endpoint の内訳を出し、内訳の和が元の数になる", async () => {
  const { GET } = await import("@/app/api/v1/observatory/state/route");
  const res = await GET(new NextRequest("http://localhost/api/v1/observatory/state"));
  assert.equal(res.status, 200);
  const body = await res.json();
  for (const key of ["publishedPassActive", "publishedPassActiveProbeOlderThan7d"]) {
    assert.equal(typeof body[key], "number", `${key} must be a number`);
  }
  assert.ok(body.publishedPassActive <= body.publishedPass, "掲載中の pass は pass 全体を超えない");
  assert.ok(body.publishedPassActive <= body.activeEndpoints, "掲載中の pass は掲載中の件数を超えない");
  assert.ok(body.publishedPassActiveProbeOlderThan7d <= body.publishedPassActive);
  for (const key of ["endpointsSettledSellerReceipt", "endpointsSettledIndexOnly"]) {
    assert.equal(typeof body.l1[key], "number", `l1.${key} must be a number`);
  }
  assert.equal(
    body.l1.endpointsSettledSellerReceipt + body.l1.endpointsSettledIndexOnly,
    body.l1.endpointsSettled,
    "内訳の和は endpointsSettled",
  );
  assert.match(body.disclaimer, /publishedPassActive/);
  assert.match(body.disclaimer, /endpointsSettledIndexOnly/);
});

test("1・4. トップの図は掲載中の pass を使い、L1 を売り手のレシートと索引のみに分ける", () => {
  const src = read("src/app/page.tsx");
  assert.ok(src.includes("n: stats.publishedPassActive"), "L0 の段は publishedPassActive");
  assert.ok(!/label: "L0 pass \(402 wall answers\)", n: stats\.publishedPass\b/.test(src), "掲載落ちを含む数を L0 の段に使わない");
  assert.ok(src.includes("n: stats.l1.endpointsSettledSellerReceipt"));
  assert.ok(src.includes("n: stats.l1.endpointsSettledIndexOnly"));
  // 同じ数を使う他の面も揃っている。
  assert.ok(read("src/app/observatory/state/page.tsx").includes("stats.publishedPassActive.toLocaleString()"));
  assert.ok(read("src/app/observatory/state/page.tsx").includes("stats.l1.endpointsSettledIndexOnly.toLocaleString()"));
  assert.ok(read("src/app/observatory/page.tsx").includes("stats.l1.endpointsSettledIndexOnly.toLocaleString()"));
  assert.ok(read("src/app/impact/page.tsx").includes("stats.l1.settledLateLinked.toLocaleString()"));
});

test("2. /accuracy の社側エラー率は /sellers の「vet402's side」と同じ名前を使わず、分子・分母を持つ", async () => {
  const { sloRows, fetchSloSnapshot } = await import("@/lib/scoring/l0-accuracy");
  const snap = await fetchSloSnapshot();
  assert.ok("l1_7d" in snap, "SloSnapshot は l1_7d を持つ（DB が無ければ null）");
  const row = sloRows(snap).find((r) => r.key === "l1_probe_error_rate_pct")!;
  assert.ok(!/failed on vet402's side/.test(row.label), "/sellers の列名と同じ言い方をしない");
  assert.match(row.label, /request_error/);
  assert.match(row.label, /out of every L1 attempt in those 7 days/, "分母を名前に書く");
  const page = squash(read("src/app/accuracy/page.tsx"));
  assert.match(page, /Three L1 figures that sound alike count different things/);
  assert.match(page, /held_reason/);
  assert.match(page, /counts listings, not attempts/);
  assert.ok(!/this week\. We print/.test(page), "「this week」は日付に置き換える");
  assert.ok(!/That is \{benchmarkAgeDays\} days ago/.test(page), "「N days ago」は日付と並べる");
});

test("6. backtest の定義文と SQL は同じ status の一覧から作り、照合待ち（settle_claimed）を数えない", async () => {
  const { BACKTEST_DEFINITION, BACKTEST_STATUSES } = await import("@/lib/observatory/backtest");
  assert.ok(!(BACKTEST_STATUSES as readonly string[]).includes("settle_claimed"), "照合待ちは結果が無い");
  assert.ok((BACKTEST_STATUSES as readonly string[]).includes("settle_claim_refuted"), "照合で否定された行は決済しなかった試行");
  assert.ok(BACKTEST_DEFINITION.includes(`(${BACKTEST_STATUSES.join(" / ")})`), "定義文が一覧をそのまま持つ");
  assert.match(BACKTEST_DEFINITION, /settle_claimed rows .* are left out/);
  const src = read("src/lib/observatory/backtest.ts");
  assert.ok(src.includes("WHERE pu.status IN (${sql.raw(BACKTEST_STATUSES."), "SQL も同じ一覧から");
  assert.ok(!/status IN \('settled', 'settle_failed'[^)]*'settle_claimed'/.test(src), "status を手で並べ直していない");
});

test("8. 非推奨のスコアは応答そのもの（本文とヘッダ）に非推奨と判定 API を載せ、値は変えない", async () => {
  const dep = await import("@/lib/api/score-deprecation");
  const body = dep.withScoreDeprecationBody({ score: 88, recommendation: "ALLOW" as const });
  assert.equal(body.score, 88, "値は変えない");
  assert.equal(body.recommendation, "ALLOW", "値は変えない");
  assert.equal(body.deprecated, true);
  assert.match(body.deprecation.use_instead, /\/api\/v1\/resources\/\{resourceId\}\/decision\?role=payer/);
  assert.match(body.deprecation.find_resource_id, /\/api\/v1\/resolve/);
  assert.equal(Object.keys(body)[0], "deprecated", "読み手が最初に目にする位置");
  // 既存キーは上書きしない。
  assert.equal(dep.withScoreDeprecationBody({ deprecated: "x" }).deprecated, "x");

  const res = dep.withScoreDeprecationHeaders(NextResponse.json({}, { headers: { Link: '<https://a.example>; rel="x"' } }));
  assert.equal(res.headers.get("Deprecation"), "@1788307200", "RFC 9745: 2026-09-02T00:00:00Z");
  assert.equal(res.headers.get("Link"), `<https://a.example>; rel="x", ${dep.SCORE_DEPRECATION_LINK}`);

  for (const route of [
    "src/app/api/v1/payees/[address]/score/route.ts",
    "src/app/api/v1/wallets/[address]/score/route.ts",
    "src/app/api/v1/agents/[agentId]/score/route.ts",
    "src/app/api/v1/scores/batch/route.ts",
    "src/app/api/v1/payees/[address]/verdict-fast/route.ts",
  ]) {
    const src = read(route);
    assert.ok(src.includes("withScoreDeprecationBody("), `${route}: 本文に非推奨を載せる`);
    assert.ok(src.includes("withScoreDeprecationHeaders("), `${route}: ヘッダに非推奨を載せる`);
  }
  const spec = read("docs/openapi.yaml");
  for (const op of ["getAgentScore", "getWalletScore", "getPayeeScore", "batchScore", "getPayeeVerdictFast"]) {
    const at = spec.indexOf(`operationId: ${op}\n`);
    assert.ok(at > 0, op);
    const block = spec.slice(at, at + 600);
    assert.match(block, /\n\s+deprecated: true\n/, `${op} は OpenAPI でも deprecated`);
  }
});
