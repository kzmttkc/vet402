// WINDOW_PLAN §16「成功の定義（この2条件の論理積）」を、そのままテストにする。
//   1. 判定が一致する
//   2. 挙げた理由コードが、実際に返ってきた理由コードの部分集合である
import test from "node:test";
import assert from "node:assert/strict";
import { grade } from "../src/grade.mjs";

const oracle = { verdict: "refuse", reasonCodes: ["l0_pass", "l1_not_attempted", "payee_recommendation_not_allow"] };

test("両条件を満たしたときだけ success", () => {
  const r = grade({ verdict: "refuse", reasonCodes: ["l1_not_attempted"] }, oracle);
  assert.equal(r.verdictMatch, true);
  assert.equal(r.reasonSubset, true);
  assert.equal(r.success, true);
});

test("判定が違えば失敗（理由が部分集合でも）", () => {
  const r = grade({ verdict: "proceed", reasonCodes: ["l1_not_attempted"] }, oracle);
  assert.equal(r.verdictMatch, false);
  assert.equal(r.success, false);
});

test("判定が当たっていても、理由を捏造したら失敗（§16 の要）", () => {
  const r = grade({ verdict: "refuse", reasonCodes: ["l1_not_attempted", "seller_is_a_scammer"] }, oracle);
  assert.equal(r.verdictMatch, true);
  assert.equal(r.reasonSubset, false);
  assert.equal(r.success, false);
  assert.deepEqual(r.fabricatedReasonCodes, ["seller_is_a_scammer"]);
});

test("理由コードの比較は順序に依存しない", () => {
  const r = grade({ verdict: "refuse", reasonCodes: ["payee_recommendation_not_allow", "l0_pass"] }, oracle);
  assert.equal(r.success, true);
});

test("空の理由コードは §16 の字義どおり部分集合として扱い、別フラグで可視化する", () => {
  // §16 は「部分集合である」としか書いていない。空集合は部分集合なので success は true。
  // 勝手に厳しくしない代わりに、後から数え直せるよう非採点のフラグを立てる。
  const r = grade({ verdict: "refuse", reasonCodes: [] }, oracle);
  assert.equal(r.success, true);
  assert.equal(r.reasonCodesEmpty, true);
});

test("エージェントの応答が解釈不能なら失敗（捨てない）", () => {
  const r = grade({ verdict: null, reasonCodes: [], unparseable: true }, oracle);
  assert.equal(r.verdictMatch, false);
  assert.equal(r.success, false);
});

test("大文字小文字と前後の空白は正規化する（同じコードを別物にしない）", () => {
  const r = grade({ verdict: "REFUSE ", reasonCodes: [" L1_NOT_ATTEMPTED "] }, oracle);
  assert.equal(r.success, true);
});
