// ============================================================
// 2026-09-29 監査 5 周目（WCAG 2.2）: 通知・異議のフォーム、/docs/api の実行 UI、モバイルのメニューボタン。
// フォームの送信ボタンは理由なく disabled にしない・誤りは欄に aria-invalid / aria-describedby で結ぶ・
// 文字数カウンタは label の外。実行 UI は disabled でなく aria-busy、結果は常設の role="status"。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RecordSubscribe, { emailProblem, reasonProblem } from "@/components/site/RecordSubscribe";
import { TryItPanel } from "@/components/docs/TryItPanel";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

test("RecordSubscribe: 送信ボタンは初期表示で押せる（disabled なし）", () => {
  for (const kind of ["notify", "dispute"] as const) {
    const html = renderToStaticMarkup(createElement(RecordSubscribe, { endpointId: "x", kind }));
    const button = html.match(/<button[^>]*type="submit"[^>]*>/)?.[0] ?? "";
    assert.ok(button, `${kind}: submit button rendered`);
    assert.doesNotMatch(button, /\sdisabled(=|\s|>)/, `${kind}: the submit button is not disabled`);
    assert.match(html, /role="status"/, `${kind}: the server error line is a standing live region`);
  }
});

test("RecordSubscribe: 文字数カウンタは label の外で、textarea の説明として結ばれている", () => {
  const html = renderToStaticMarkup(createElement(RecordSubscribe, { endpointId: "x", kind: "dispute" }));
  const labels = html.match(/<label[\s\S]*?<\/label>/g) ?? [];
  assert.ok(labels.length >= 2);
  for (const l of labels) assert.doesNotMatch(l, /so far/, "no counter inside a label");
  const countId = html.match(/<span id="([^"]+)"[^>]*>20–2,000 characters/)?.[1];
  assert.ok(countId, "the counter has an id");
  assert.match(html, new RegExp(`<textarea[^>]*aria-describedby="${countId}"`));
});

test("RecordSubscribe: 誤りの判定（email の形・理由の長さ・書き出しの後の本人の分）", () => {
  assert.match(emailProblem("") ?? "", /Enter an email/);
  assert.match(emailProblem("not-an-email") ?? "", /does not look like/);
  assert.equal(emailProblem(" a@b.co "), null);
  assert.match(reasonProblem(5, 5, false) ?? "", /at least 20 characters \(5 so far\)/);
  assert.match(reasonProblem(3, 60, true) ?? "", /after the prefilled line/);
  assert.equal(reasonProblem(20, 20, false), null);
  assert.match(reasonProblem(2001, 2001, false) ?? "", /limit is 2,000/);
  const src = read("src/components/site/RecordSubscribe.tsx");
  assert.match(src, /aria-invalid=\{showEmailError/);
  assert.match(src, /aria-invalid=\{showReasonError/);
  assert.doesNotMatch(src, /disabled=\{!canSend\}/);
});

test("TryItPanel: disabled でなく aria-busy・結果は常設の role=status・はみ出す pre は tabindex=0 の region", () => {
  const html = renderToStaticMarkup(createElement(TryItPanel, { path: "/api/v1/accuracy", label: "GET /api/v1/accuracy" }));
  assert.doesNotMatch(html, /\sdisabled(=|\s|>)/);
  assert.match(html, /aria-busy="false"/);
  assert.match(html, /role="status"/, "the live region exists before the result arrives");
  const src = read("src/components/docs/TryItPanel.tsx");
  assert.match(src, /tabIndex=\{0\}/);
  assert.match(src, /role="region"/);
  assert.match(src, /aria-label=\{`Response body of \$\{label\}`\}/);
});

test("SiteHeader: メニューボタンは aria-label（Menu / Close menu）と aria-controls を持つ", () => {
  const src = read("src/components/site/SiteHeader.tsx");
  assert.match(src, /aria-label=\{mobileOpen \? "Close menu" : "Menu"\}/);
  assert.match(src, /aria-controls=\{mobileNavId\}/);
  assert.match(src, /id=\{mobileNavId\}/);
  assert.match(src, /hidden=\{!mobileOpen\}/, "the controlled nav stays in the DOM");
});
