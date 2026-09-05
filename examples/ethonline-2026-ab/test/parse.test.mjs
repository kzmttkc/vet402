// エージェントの生応答から verdict / reason_codes を取り出す。
// **取り出せなかったら失敗として記録する。捨てない。**
import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentAnswer } from "../src/parse.mjs";

test("素の JSON を読む", () => {
  const r = parseAgentAnswer('{"verdict":"refuse","reason_codes":["l1_not_attempted"],"explanation":"x"}');
  assert.equal(r.verdict, "refuse");
  assert.deepEqual(r.reasonCodes, ["l1_not_attempted"]);
  assert.equal(r.unparseable, false);
});

test("前後に散文が付いていても読む（実モデルはよくやる）", () => {
  const r = parseAgentAnswer('Sure!\n```json\n{"verdict":"proceed","reason_codes":[]}\n```\nHope that helps.');
  assert.equal(r.verdict, "proceed");
  assert.deepEqual(r.reasonCodes, []);
  assert.equal(r.unparseable, false);
});

test("JSON が無ければ unparseable（推測で埋めない）", () => {
  const r = parseAgentAnswer("I would not pay this endpoint.");
  assert.equal(r.unparseable, true);
  assert.equal(r.verdict, null);
  assert.deepEqual(r.reasonCodes, []);
});

test("散文から verdict を推測しない（『refuse』の語が本文にあっても拾わない）", () => {
  const r = parseAgentAnswer("My decision is to refuse this payment because l1_not_attempted.");
  assert.equal(r.unparseable, true);
  assert.equal(r.verdict, null);
});

test("reason_codes が配列でなければ空配列にし、raw は残す", () => {
  const r = parseAgentAnswer('{"verdict":"refuse","reason_codes":"l1_not_attempted"}');
  assert.equal(r.verdict, "refuse");
  assert.deepEqual(r.reasonCodes, []);
  assert.equal(r.unparseable, false);
});

test("verdict が語彙外なら null（黙って refuse に丸めない）", () => {
  const r = parseAgentAnswer('{"verdict":"maybe","reason_codes":[]}');
  assert.equal(r.verdict, null);
});

test("空文字・null は unparseable", () => {
  assert.equal(parseAgentAnswer("").unparseable, true);
  assert.equal(parseAgentAnswer(null).unparseable, true);
});
