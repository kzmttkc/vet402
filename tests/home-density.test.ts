// フロント頁の密度上限（2026-11-10）。セクション数・エントリカード数・語数の変更はオーナー承認が必要。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/** オーナー承認なしに main 直下の section を増やしてはいけない上限 */
const HOME_MAIN_SECTION_MAX = 2;

/** オーナー承認なしにエントリカードを増やしてはいけない上限 */
const HOME_ENTRY_CARD_MAX = 3;

/** 2026-11-10 改稿時の main 語数（ライブ数字ブロックを除く）。+10% まで許容 */
const HOME_MAIN_WORD_BASE = 142;
const HOME_MAIN_WORD_MAX = Math.ceil(HOME_MAIN_WORD_BASE * 1.1);

/** 1 枚のエントリカード文の語数上限 */
const HOME_ENTRY_SENTENCE_WORD_MAX = 25;

const page = readFileSync("src/app/page.tsx", "utf8");

function mainBlock(src: string): string {
  const start = src.indexOf("<main");
  const end = src.indexOf("</main>", start);
  assert.ok(start >= 0 && end > start);
  return src.slice(start, end);
}

function stripLiveNumbers(block: string): string {
  let out = block;
  const patterns = [
    /className=\{s\.heroFacts\}[\s\S]*?<\/div>\s*\) :/,
    /className=\{s\.facts\}[\s\S]*?<\/dl>/,
    /className=\{`?\$\{s\.record\}/,
    /fmt\([^)]*\)/g,
    /\{ledger[^}]*\}/g,
    /\{days[^}]*\}/g,
    /\{notDelivered\}/g,
    /\{readAt[^}]*\}/g,
    /\{fmt\([^}]*\}\)/g,
  ];
  for (const re of patterns) {
    out = out.replace(re, " ");
  }
  return out;
}

function visibleWords(block: string): string[] {
  let text = block;
  text = text.replace(/\/\*[\s\S]*?\*\//g, " ");
  text = text.replace(/\{[^}]*\}/g, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&apos;/g, "'");
  return text
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, ""))
    .filter((w) => w.length > 0);
}

test("main has at most HOME_MAIN_SECTION_MAX top-level sections", () => {
  const main = mainBlock(page);
  const sections = [...main.matchAll(/<section\b/g)];
  assert.ok(
    sections.length <= HOME_MAIN_SECTION_MAX,
    `sections=${sections.length}, max=${HOME_MAIN_SECTION_MAX}`,
  );
});

test("at most HOME_ENTRY_CARD_MAX entry cards", () => {
  const cards = [...page.matchAll(/event: "entry_/g)];
  assert.ok(cards.length <= HOME_ENTRY_CARD_MAX, `entry cards=${cards.length}`);
  assert.equal(cards.length, HOME_ENTRY_CARD_MAX);
});

test("ENTRY_CARDS sentences stay within HOME_ENTRY_SENTENCE_WORD_MAX words", () => {
  const re = /sentence:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  const sentences: string[] = [];
  const slice = page.slice(page.indexOf("const ENTRY_CARDS"), page.indexOf("] as const", page.indexOf("const ENTRY_CARDS")));
  while ((m = re.exec(slice))) sentences.push(m[1]);
  assert.equal(sentences.length, HOME_ENTRY_CARD_MAX);
  for (const s of sentences) {
    const n = s.split(/\s+/).filter(Boolean).length;
    assert.ok(n <= HOME_ENTRY_SENTENCE_WORD_MAX, `"${s}" has ${n} words`);
  }
});

test("main visible word count stays within HOME_MAIN_WORD_MAX", () => {
  const words = visibleWords(stripLiveNumbers(mainBlock(page)));
  assert.ok(
    words.length <= HOME_MAIN_WORD_MAX,
    `words=${words.length}, max=${HOME_MAIN_WORD_MAX} (base ${HOME_MAIN_WORD_BASE})`,
  );
});

test("entry events are listed in SITE_EVENTS", () => {
  const events = readFileSync("src/lib/site-events.ts", "utf8");
  for (const name of ["entry_before_pay", "entry_while_pay", "entry_after_pay"]) {
    assert.match(events, new RegExp(`"${name}"`));
  }
});
