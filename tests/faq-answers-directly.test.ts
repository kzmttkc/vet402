// ============================================================
// FAQ は 1 文目で答える（2026-09-05 AEO）。
//
// WHY: 回答エンジンは段落を要約して答えを作るのではなく、答えとして
// 書かれた 1 文を引く。既存の 13 問は全部その形になっていたが、観測所の
// 中心語 — settled とは何か、L1 はどう測るのか — には 1 問 1 答の面が
// 無く、方法論 §6 の長い段落を読ませるしかなかった。
//
// この関門が守るのは:
//   1. 3 つの中心的な問いが FAQ に在る
//   2. どの答えも 1 文目が直接回答（問いの言い換えや前置きで始まらない）
//   3. 新規 2 問の 1 文目が語彙の正典と 1 文字も違わない
//      （faq-data.ts は軽く保ちたいので import せず、テストで突合する）
//   4. FAQPage JSON-LD が FAQS から生成される（2 つ目のコピーを作らない）
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FAQS } from "@/components/site/faq-data";
import { OBSERVATORY_VOCABULARY } from "@/lib/observatory/vocabulary";

const ROOT = process.cwd();
const firstSentence = (s: string) => s.split(/(?<=\.)\s/)[0];
const find = (q: string) => FAQS.find((f) => f.question === q);

test("答えを 1 文で返せる中心的な問いが FAQ に在る", () => {
  for (const q of ["What is x402?", "What does settled mean on vet402?", "How is L1 measured?"]) {
    assert.ok(find(q), `FAQ に「${q}」が無い`);
  }
});

test("どの答えも 1 文目が直接回答（前置きで始まらない）", () => {
  const openers = /^(Well|Basically|In order to|It depends|That is a good question|There are many)/i;
  for (const item of FAQS) {
    const first = firstSentence(item.answer);
    assert.ok(first.length > 0, `${item.question}: 答えが空`);
    assert.ok(!openers.test(first), `${item.question}: 前置きで始まっている — "${first}"`);
    assert.ok(
      first.length <= 400,
      `${item.question}: 1 文目が長すぎて回答として取り出せない (${first.length} 字)`,
    );
    assert.ok(
      !first.toLowerCase().startsWith(item.question.toLowerCase().replace(/\?$/, "")),
      `${item.question}: 1 文目が問いの言い換え`,
    );
  }
});

test("settled / L1 の答えの 1 文目は語彙の正典と同一", () => {
  const vocab = (term: string) => {
    const t = OBSERVATORY_VOCABULARY.find((v) => v.term === term);
    assert.ok(t, `語彙に ${term} が無い`);
    return firstSentence(t.definition);
  };
  assert.equal(firstSentence(find("What does settled mean on vet402?")!.answer), vocab("settled"));
  assert.equal(firstSentence(find("How is L1 measured?")!.answer), vocab("L1"));
});

test("FAQPage JSON-LD と llms-full.txt は FAQS から生成する", () => {
  const page = readFileSync(join(ROOT, "src/app/faq/page.tsx"), "utf8");
  assert.ok(page.includes('"@type": "FAQPage"'));
  assert.ok(page.includes("FAQS.map"), "FAQPage が FAQS から生成されていない");
  const llms = readFileSync(join(ROOT, "src/app/llms-full.txt/route.ts"), "utf8");
  assert.ok(llms.includes("FAQS.map"), "llms-full.txt が FAQS から生成されていない");
});
