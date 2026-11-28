// プライバシー方針の seller-notices 節は主語 vet402（2026-11-28・terms と同じ規則）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function sellerNoticesText(src: string): string {
  const m = src.match(/id="seller-notices"[\s\S]*?<\/section>/);
  assert.ok(m, "seller-notices section");
  return m[0]!
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

test("privacy seller-notices: no first person plural", () => {
  const text = sellerNoticesText(readFileSync("src/app/legal/privacy/page.tsx", "utf8"));
  const hits = text.match(/\b(?:[Ww]e|[Oo]ur|[Oo]urs|[Oo]urselves|us|Us)\b/g) ?? [];
  assert.deepEqual(hits, []);
});

test("privacy seller-notices: names vet402 as the actor before publication", () => {
  const text = sellerNoticesText(readFileSync("src/app/legal/privacy/page.tsx", "utf8"));
  assert.match(text, /before vet402 publishes/);
  assert.match(text, /vet402 may email/);
});