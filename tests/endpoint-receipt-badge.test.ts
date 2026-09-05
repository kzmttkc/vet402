// ============================================================
// vet402 — endpoint receipt badge (seller-outreach hook, 2026-08-18).
//
// A seller whose endpoint vet402 has actually paid can embed a badge showing
// the settle-through record: "n/m settled". Unlike the trust badge, this is a
// FACT, not a judgment — so it carries NO evaluative colour (no green=good,
// red=bad). It states what happened when vet402 paid, in the observatory's
// facts-only register. These tests pin that the label is the honest ratio and
// that an unmeasured endpoint says so rather than inventing a 0 or 100.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { endpointReceiptBadge, renderReceiptBadgeSvg } from "@/lib/badge/receipt-badge";

test("a measured endpoint shows the settled/attempts ratio", () => {
  const b = endpointReceiptBadge({ attemptCount: 5, settledCount: 3, deliveredCount: 3 });
  assert.equal(b.label, "3/5 settled · 3 delivered");
  assert.match(b.aria, /3 of 5/);
  // Facts, not a verdict — the aria must not claim safety/trust.
  assert.doesNotMatch(b.aria.toLowerCase(), /trust|safe|verified|endors/);
});

test("an endpoint with no paid attempts says 'not yet measured', never 0/0", () => {
  const b = endpointReceiptBadge({ attemptCount: 0, settledCount: 0 });
  assert.equal(b.label, "not yet measured");
  assert.doesNotMatch(b.label, /0\/0|0%/);
});

test("all-settled and none-settled are both stated plainly (no colour-coding of good/bad)", () => {
  assert.equal(
    endpointReceiptBadge({ attemptCount: 3, settledCount: 3, deliveredCount: 3 }).label,
    "3/3 settled · 3 delivered",
  );
  assert.equal(
    endpointReceiptBadge({ attemptCount: 4, settledCount: 0, deliveredCount: 0 }).label,
    "0/4 settled · 0 delivered",
  );
  // Same ink for every measured state — the number carries the meaning, not a
  // green/red signal a human would read as vet402's opinion.
  const good = endpointReceiptBadge({ attemptCount: 3, settledCount: 3, deliveredCount: 3 });
  const bad = endpointReceiptBadge({ attemptCount: 4, settledCount: 0, deliveredCount: 0 });
  assert.equal(good.color, bad.color);
});

test("the SVG is well-formed, escapes its text, and carries the aria label", () => {
  const b = endpointReceiptBadge({ attemptCount: 2, settledCount: 1, deliveredCount: 1 });
  const svg = renderReceiptBadgeSvg(b);
  assert.match(svg, /^<svg[\s\S]*<\/svg>$/);
  assert.match(svg, /role="img"/);
  assert.ok(svg.includes(b.label));
  // No unescaped angle brackets injected via label (defense: label is ours,
  // but the renderer must escape regardless).
  const evil = renderReceiptBadgeSvg({ ...b, label: 'x"><script>' });
  assert.ok(!evil.includes("<script>"));
});

// ------------------------------------------------------------
// 2026-09-04 外部監査 E・P0-3: バッジは settled だけを描いていた。
// api.exa.ai/search は「10/10 settled」と出ていて、その 10 件はすべて
// HTTP 400 だった（金は動いたが品は来ていない）。settled と delivered を
// 併記しないと、バッジ 1 枚で LP §2 の L1 の定義に反する。
// ------------------------------------------------------------

test("バッジは settled と delivered と attempts の 3 つを併記する", () => {
  const b = endpointReceiptBadge({ attemptCount: 5, settledCount: 3, deliveredCount: 2 });
  assert.equal(b.label, "3/5 settled · 2 delivered");
  assert.match(b.aria, /3 of 5/);
  assert.match(b.aria, /2/);
  assert.doesNotMatch(b.aria.toLowerCase(), /trust|safe|endors/);
});

test("決済は通ったが応答が届かなかった endpoint は delivered 0 と描かれる", () => {
  // 実測形: settled 10 / delivered 0（HTTP 400 が 10 件）。
  const b = endpointReceiptBadge({ attemptCount: 10, settledCount: 10, deliveredCount: 0 });
  assert.equal(b.label, "10/10 settled · 0 delivered");
});

test("delivered が settled と同じでも省略しない（同じときだけ隠すのが事故の形）", () => {
  const b = endpointReceiptBadge({ attemptCount: 3, settledCount: 3, deliveredCount: 3 });
  assert.equal(b.label, "3/3 settled · 3 delivered");
});

test("delivered は settled を超えない（上流が壊れても表示は超えない）", () => {
  const b = endpointReceiptBadge({ attemptCount: 4, settledCount: 2, deliveredCount: 9 });
  assert.equal(b.label, "2/4 settled · 2 delivered");
});

test("SVG は長くなったラベルを右の区画に収める（切れない）", () => {
  const b = endpointReceiptBadge({ attemptCount: 1234, settledCount: 1234, deliveredCount: 1200 });
  const svg = renderReceiptBadgeSvg(b);
  const width = Number(/(?:^|\s)width="(\d+)"/.exec(svg)?.[1]);
  assert.ok(width >= 58 + b.label.length * 6, `badge too narrow for ${b.label}: ${width}`);
  assert.ok(svg.includes(b.label));
});

// ------------------------------------------------------------
// 2026-09-05: 支払い後 4xx は判定保留（inconclusive）。
//
// `10/10 settled · 0 delivered` を実名の会社（api.exa.ai）に対して配っていた。
// 読み手はこれを「金を取って納品しなかった」と読む。だが 4xx は「送られた要求が
// 不正」で、我々は空のボディを送り API キーを持たずに買っている——要求のほうが
// 悪かった可能性が消せない。**行は消さない。判定を保留にして数える。**
// ------------------------------------------------------------

test("支払い後 4xx は inconclusive として別枠に出る（delivered の分母から外れる）", () => {
  const b = endpointReceiptBadge({
    attemptCount: 10,
    settledCount: 10,
    deliveredCount: 0,
    inconclusiveCount: 10,
  });
  assert.equal(b.label, "10/10 settled · 0 delivered · 10 inconclusive");
  // 「売り手が納品しなかった」と読める語を作らない。
  assert.doesNotMatch(b.aria.toLowerCase(), /failed to deliver|did not deliver/);
  // 保留の理由を必ず添える（数だけ出すと、読み手が理由を作る）。
  assert.match(b.aria, /4xx/);
  assert.match(b.aria, /no API key|empty request body/);
});

test("inconclusive が 0 件ならラベルに出さない（無い枠を出さない）", () => {
  const b = endpointReceiptBadge({
    attemptCount: 3,
    settledCount: 3,
    deliveredCount: 3,
    inconclusiveCount: 0,
  });
  assert.equal(b.label, "3/3 settled · 3 delivered");
});

test("delivered は「判定できた settled」を超えない", () => {
  // settled 10 のうち 8 が保留なら、delivered は最大 2。
  const b = endpointReceiptBadge({
    attemptCount: 10,
    settledCount: 10,
    deliveredCount: 9,
    inconclusiveCount: 8,
  });
  assert.equal(b.label, "10/10 settled · 2 delivered · 8 inconclusive");
});

// ------------------------------------------------------------
// 2026-09-05: バッジ自身に「誰の・いつの」を焼き込む。
//
// 実測: 他社バッジを Referer 偽装で取得して HTTP 200、保存した SVG には
// endpoint ID・ホスト名・日付が 1 文字も無かった。1 回落として自分のサーバに
// 置けば、その数字を永久に固定できる。SVG の中に主体と日付があれば、
// 固定されたコピーは「いつの測定か」を自分で名乗ることになる。
// ------------------------------------------------------------

test("SVG にホスト名と測定日が焼き込まれる", () => {
  const b = endpointReceiptBadge({
    attemptCount: 5,
    settledCount: 5,
    deliveredCount: 5,
    subject: "api.exa.ai",
    measuredOn: "2026-09-05",
  });
  const svg = renderReceiptBadgeSvg(b);
  assert.ok(svg.includes("api.exa.ai"), "ホスト名が SVG に無い");
  assert.ok(svg.includes("2026-09-05"), "測定日が SVG に無い");
  assert.match(b.aria, /api\.exa\.ai/);
  assert.match(b.aria, /2026-09-05/);
});

test("主体も日付も無ければ第二行を作らない（存在しない出所を書かない）", () => {
  const b = endpointReceiptBadge({ attemptCount: 2, settledCount: 1, deliveredCount: 1 });
  assert.equal(b.sublabel, "");
});

test("第二行も XML エスケープされる（焼き込みが注入口にならない）", () => {
  const b = endpointReceiptBadge({
    attemptCount: 1,
    settledCount: 1,
    deliveredCount: 1,
    subject: 'evil"><script>',
    measuredOn: "2026-09-05",
  });
  const svg = renderReceiptBadgeSvg(b);
  assert.ok(!svg.includes("<script>"), "第二行から生タグが出た");
});

test("第二行が長くてもバッジの幅に収まる", () => {
  const b = endpointReceiptBadge({
    attemptCount: 3,
    settledCount: 3,
    deliveredCount: 3,
    subject: "a-very-long-seller-hostname.example.com",
    measuredOn: "2026-09-05",
  });
  const svg = renderReceiptBadgeSvg(b);
  const width = Number(/(?:^|\s)width="(\d+)"/.exec(svg)?.[1]);
  assert.ok(width >= 58 + b.sublabel.length * 5, `badge too narrow for ${b.sublabel}: ${width}`);
});
