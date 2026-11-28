// 規約の本文の主語は vet402（1人で運営しているので we / our / us を使わない・2026-11-28）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function publicText(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ") // /** */ と {/* */} のコメント
    .replace(/^\s*\/\/.*$/gm, " "); // 行のコメント
}

test("terms: the public text has no first person plural", () => {
  const text = publicText(readFileSync("src/app/legal/terms/page.tsx", "utf8"));
  const hits = text.match(/\b(?:[Ww]e|[Oo]ur|[Oo]urs|[Oo]urselves|us|Us)\b/g) ?? [];
  assert.deepEqual(hits, []);
});

test("terms: section 16 names vet402 in the cancel and failed payment paragraphs", () => {
  const text = readFileSync("src/app/legal/terms/page.tsx", "utf8");
  assert.match(text, /vet402 does not refund unused lookups/);
  assert.match(text, /managed in the portal by Stripe, not by vet402\./);
  assert.match(text, /before vet402 publishes results/);
});
