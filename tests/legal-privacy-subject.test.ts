// プライバシー方針の本文の主語は vet402（1人で運営しているので we / our / us を使わない・2026-11-28・terms と同じ規則）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function publicText(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /** */ と {/* */} のコメント
    .replace(/^\s*\/\/.*$/gm, " "); // 行のコメント
}

const privacy = () => publicText(readFileSync("src/app/legal/privacy/page.tsx", "utf8"));

test("privacy: the public text has no first person plural", () => {
  const hits = privacy().match(/\b(?:[Ww]e|[Oo]ur|[Oo]urs|[Oo]urselves|us|Us)\b/g) ?? [];
  assert.deepEqual(hits, []);
});

test("privacy seller-notices: names vet402 as the actor before publication", () => {
  const m = privacy().match(/id="seller-notices"[\s\S]*?<\/section>/);
  assert.ok(m, "seller-notices section");
  assert.match(m[0], /before vet402 publishes/);
  assert.match(m[0], /vet402 may email/);
});

test("privacy: headings name vet402", () => {
  const text = privacy();
  assert.match(text, /Data vet402 collects/);
  assert.match(text, /How vet402 protects your data/);
  assert.match(text, /People vet402 scores who are not its customers/);
});
