// 2026-10-21: モバイルの一覧は、リンクを押すと閉じる（同じ pathname への遷移でも本文に重ならない）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("mobile menu closes its details when a link inside is clicked", () => {
  const src = readFileSync("src/components/site/SiteHeader.tsx", "utf8");
  const nav = src.slice(src.indexOf('aria-label="Mobile navigation"'), src.indexOf('aria-label="Mobile navigation"') + 600);
  assert.match(nav, /onClick=\{\(e\) => \{[\s\S]*closest\("a"\)[\s\S]*closest\("details"\)\?\.removeAttribute\("open"\)/);
});
