// 2026-11-08 front page (owner 11/07 23:41): one neutral grey scale and a first screen with two ways in.
// The page is checked in the browser too (getComputedStyle over every element). This test keeps the
// source from drifting back to an accent colour or a third hero button between those checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync("src/app/home.module.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const page = readFileSync("src/app/page.tsx", "utf8");

test("every colour in the front page stylesheet is a neutral grey (R = G = B)", () => {
  const bad: string[] = [];
  for (const m of css.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)) {
    const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
    const [r, g, b] = [0, 2, 4].map((i) => h.slice(i, i + 2).toLowerCase());
    if (!(r === g && g === b)) bad.push(m[0]);
  }
  for (const m of css.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/g)) {
    if (!(m[1] === m[2] && m[2] === m[3])) bad.push(m[0]);
  }
  assert.deepEqual(bad, []);
  assert.doesNotMatch(css, /hsl\(|oklch\(|color-mix\(/);
});

test("the first screen has two ways in, one for each side", () => {
  const hero = page.slice(page.indexOf('className={s.hero}'), page.indexOf("lp-record"));
  const ctas = [...hero.matchAll(/position: "hero_(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(ctas, ["buyer", "seller"]);
  assert.equal((page.match(/<h1\b/g) ?? []).length, 1);
});

test("the counts carry the time of the state read, and the old document stays at /memo", () => {
  assert.match(page, /<time dateTime=\{readAt\}>/);
  assert.match(page, /href: "\/memo"/);
  assert.match(readFileSync("src/app/memo/page.tsx", "utf8"), /path: "\/memo"/);
});
