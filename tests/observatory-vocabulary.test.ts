// ============================================================
// 観測所の語彙が 1 文で取り出せる形で出ていること（2026-09-05 AEO/LLMO）。
//
// WHY: 方法論の散文は各語を丁寧に定義していたが、「settled とは何か」を
// 1 文で取り出せる場所がどこにも無かった。回答エンジンは段落から定義を
// 復元するのではなく、定義として書かれたものを引く。出典として引かれることが
// 配布 KPI（外部からの引用・現在 0 件）である以上、語彙は定義の形でも要る。
//
// この関門が守るのは:
//   1. 正典は src/lib/observatory/vocabulary.ts の 1 本だけ
//      （HTML・DefinedTermSet・llms-full.txt が同じ配列から出る）
//   2. 公開面が実際に使っている語が漏れていない
//   3. 定義が散文と別々に腐らない（語が散文にも在る）
//   4. 定義が 1 文の直接回答から始まる（"X means …" / "X is …"）
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OBSERVATORY_VOCABULARY,
  vocabularyJsonLd,
  VOCABULARY_GROUP_LABELS,
} from "@/lib/observatory/vocabulary";
import { SITE_URL } from "@/lib/site-url";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const METHODOLOGY = "src/app/observatory/methodology/page.tsx";

test("公開面が使う語が語彙から漏れていない", () => {
  const terms = new Set(OBSERVATORY_VOCABULARY.map((t) => t.term));
  for (const required of [
    "L0",
    "L1",
    "L2",
    "L3",
    "pass",
    "fail",
    "unverified",
    "settled",
    "delivered",
    "settle_claimed",
    "settle_claim_refuted",
    "settle_claimed_unverifiable",
    "delivered_no_receipt",
    "settle_failed",
    "match",
    "mismatch",
    "no_declaration",
    "not_checked",
    "delisted",
    "path_template",
  ]) {
    assert.ok(terms.has(required), `語彙に ${required} が無い`);
  }
  assert.equal(terms.size, OBSERVATORY_VOCABULARY.length, "語の重複がある");
});

test("各定義は 1 文の直接回答から始まる", () => {
  for (const t of OBSERVATORY_VOCABULARY) {
    const first = t.definition.split(/(?<=\.)\s/)[0];
    assert.ok(
      first.startsWith(`${t.term} means `) || first.startsWith(`${t.term} is `) || first.startsWith(`${t.term} would be `),
      `${t.term}: 1 文目が直接回答になっていない — "${first}"`,
    );
    assert.ok(first.length <= 320, `${t.term}: 1 文目が長すぎて回答として取り出せない`);
    assert.ok(t.definition.endsWith("."), `${t.term}: 定義が文で終わっていない`);
  }
});

test("語は方法論の散文にも在る（定義だけが独り歩きしない）", () => {
  const prose = read(METHODOLOGY);
  for (const t of OBSERVATORY_VOCABULARY) {
    assert.ok(prose.includes(t.term), `方法論の散文に ${t.term} が無い`);
  }
});

test("DefinedTermSet は語彙と同じ配列から出て、定義文が 1 文字も違わない", () => {
  const set = vocabularyJsonLd(SITE_URL);
  assert.equal(set["@type"], "DefinedTermSet");
  assert.equal(set.hasDefinedTerm.length, OBSERVATORY_VOCABULARY.length);
  for (const [i, term] of set.hasDefinedTerm.entries()) {
    assert.equal(term["@type"], "DefinedTerm");
    assert.equal(term.name, OBSERVATORY_VOCABULARY[i].term);
    assert.equal(term.description, OBSERVATORY_VOCABULARY[i].definition);
    assert.equal(term.inDefinedTermSet, `${SITE_URL}/observatory/methodology#vocabulary`);
  }
});

test("方法論頁と llms-full.txt は語彙モジュールから描画する（転記しない）", () => {
  const page = read(METHODOLOGY);
  assert.ok(page.includes("vocabularyJsonLd"), "方法論頁が DefinedTermSet を出していない");
  assert.ok(page.includes("OBSERVATORY_VOCABULARY"), "方法論頁が語彙を HTML に出していない");
  assert.ok(page.includes('id="vocabulary"'), "#vocabulary アンカーが無い（llms-full.txt が指している）");

  const llms = read("src/app/llms-full.txt/route.ts");
  assert.ok(llms.includes("OBSERVATORY_VOCABULARY"), "llms-full.txt が語彙モジュールを使っていない");
  assert.ok(llms.includes("#vocabulary"), "llms-full.txt が正典頁のアンカーを指していない");
});

test("グループのラベルは全グループぶん在る", () => {
  for (const t of OBSERVATORY_VOCABULARY) {
    assert.ok(VOCABULARY_GROUP_LABELS[t.group], `${t.group} のラベルが無い`);
  }
});
