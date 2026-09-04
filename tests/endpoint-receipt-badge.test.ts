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
