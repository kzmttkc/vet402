// §16「フィクスチャ（正解が既知のものだけを使う。片方に倒せば勝てる構成にしない）」
import test from "node:test";
import assert from "node:assert/strict";
import { FIXTURES, fixtureReadiness } from "../src/fixtures.mjs";

test("§16 の表どおり4件", () => {
  assert.equal(FIXTURES.length, 4);
  assert.deepEqual(FIXTURES.map((f) => f.id), ["F1", "F2", "F3", "F4"]);
});

test("『常に拒否する』戦略が満点を取れない（proceed が最低1件ある）", () => {
  const proceed = FIXTURES.filter((f) => f.oracle.verdict === "proceed");
  assert.ok(proceed.length >= 1, "§16: 1 を入れるのは常に拒否する戦略が満点を取れないようにするため");
  assert.equal(proceed[0].id, "F1");
});

test("『常に払う』戦略も満点を取れない（refuse が複数ある）", () => {
  assert.ok(FIXTURES.filter((f) => f.oracle.verdict === "refuse").length >= 2);
});

test("F4 は判定を引く前に落ちる経路（上限超過）", () => {
  const f4 = FIXTURES.find((f) => f.id === "F4");
  assert.ok(f4.amountUsd > f4.maxPerTxUsd);
  assert.deepEqual(f4.oracle.reasonCodes, ["price_above_ceiling"]);
  assert.equal(f4.oracle.beforeDecision, true);
});

test("全フィクスチャに oracle の出所（provenance）と測定日がある", () => {
  for (const f of FIXTURES) {
    assert.equal(typeof f.oracle.provenance, "string", `${f.id}`);
    assert.ok(f.oracle.provenance.length > 20, `${f.id} の provenance が薄い`);
    assert.equal(typeof f.oracle.measuredAt, "string", `${f.id}`);
    assert.equal(typeof f.oracle.measured, "boolean", `${f.id}`);
  }
});

test("本文に無い値を捏造しない——不明な payee は null で、prefix だけ持つ", () => {
  const f3 = FIXTURES.find((f) => f.id === "F3");
  assert.equal(f3.payee, null, "0xb15a55e8… の全40桁はリポのどこにも無い。作らない");
  assert.equal(f3.payeePrefix, "0xb15a55e8");
});

test("fixtureReadiness は『実 LLM 実行に足りているか』を機械可読で返す", () => {
  const r = fixtureReadiness(FIXTURES);
  assert.equal(typeof r.liveReady, "boolean");
  assert.ok(Array.isArray(r.blockers));
  // 現時点では未確定値があるので liveReady は false でなければならない（緑に見せない）
  assert.equal(r.liveReady, false);
  assert.ok(r.blockers.length > 0);
  for (const b of r.blockers) assert.match(b, /^F[1-4]: /);
});

test("oracle が未測定のフィクスチャは blockers に必ず出る", () => {
  const r = fixtureReadiness(FIXTURES);
  const unmeasured = FIXTURES.filter((f) => !f.oracle.measured).map((f) => f.id);
  for (const id of unmeasured) {
    assert.ok(r.blockers.some((b) => b.startsWith(`${id}: `) && /未測定|derived|未確定/.test(b)), `${id} が blockers に無い`);
  }
});
