// ============================================================
// TableScroll（2026-09-02 デザイン監査 P1: 表が紙幅 665px を超え、主要列が初期非表示）。
// 先頭列を紙面に貼り付け、右に続きがあるときだけ「→ N more columns」を出す。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TableScroll } from "@/components/site/TableScroll";

function render() {
  return renderToStaticMarkup(
    createElement(
      TableScroll,
      { label: "t" } as Parameters<typeof TableScroll>[0],
      createElement("table", { className: "fact-table" }, createElement("tbody", null, createElement("tr", null, createElement("td", null, "a"), createElement("td", null, "b")))),
    ),
  );
}

test("first column of a fact table is sticky on the paper", () => {
  // renderToStaticMarkup は属性の & を &amp; にする
  const html = render().replace(/&amp;/g, "&");
  assert.match(html, /\[&_\.fact-table_td:first-child\]:sticky/);
  assert.match(html, /\[&_\.fact-table_td:first-child\]:left-0/);
  assert.match(html, /\[&_\.fact-table_td:first-child\]:bg-paper/);
  assert.match(html, /\[&_\.fact-table_th:first-child\]:sticky/);
});

test("the overflow hint exists in the markup but is hidden until the client measures overflow", () => {
  const html = render();
  assert.match(html, /data-table-scroll-hint/);
  assert.match(html, /<[^>]*data-table-scroll-hint[^>]*hidden/);
  assert.match(html, /aria-hidden="true"/);
});
