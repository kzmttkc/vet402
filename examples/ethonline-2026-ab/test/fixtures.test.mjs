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

test("値は実測で埋めるか null のまま。**推測で埋めない**", () => {
  // 2026-09-05: F1/F2/F3 は本番 API で実測して埋めた（WINDOW_PLAN §16 のフィクスチャ表）。
  // 元の検査は「F3 の payee は null であること」を要求していたが、それは
  // **「まだ測っていない」状態の記述**であって、守るべき規則ではなかった。
  // 守るべきは「**測っていない値を書かない**」。そちらを検査する。
  for (const f of FIXTURES) {
    if (f.payee !== null) {
      assert.match(f.payee, /^0x[0-9a-fA-F]{40}$/, `${f.id}: payee は全40桁か null`);
      assert.ok(f.payee.toLowerCase().startsWith(f.payeePrefix.toLowerCase()),
        `${f.id}: payee が payeePrefix と食い違う`);
    }
    if (f.resourceId !== null) {
      assert.match(f.resourceId, /^[0-9a-f]{64}$/, `${f.id}: resourceId は sha256 の64桁`);
    }
    // **出所の無い値を作らない。** measured: true なら provenance に測った日と面が書いてある。
    if (f.oracle.measured) {
      assert.match(f.oracle.provenance, /実測|実走/, `${f.id}: measured なのに provenance が実測と言っていない`);
      assert.match(f.oracle.measuredAt, /^\d{4}-\d{2}-\d{2}$/);
    }
  }
  // F3 の実測値（この2つは会期の提出物が名指しするので、値そのものを固定する）
  const f3 = FIXTURES.find((f) => f.id === "F3");
  assert.equal(f3.payee, "0xb15a55e85fdf5edc41b6c1eaf7813e2c6e6def59");
  assert.equal(f3.resourceId, "8146a86d0e858267f15388341fc99b7d5fa23b6ebb138ba0267a38eb9a76386b");
});

test("fixtureReadiness は blockers の有無と一致する——**両方向に**", () => {
  // 元の検査は「今は liveReady false であること」を要求していた。それは**その時点の状態**であって
  // 規則ではない。2026-09-05 に F1-F4 を全部実測して埋めたので true になった。
  // 守るべき規則は「blockers が無いときだけ liveReady が true」で、**両方向を検査する**。
  const r = fixtureReadiness(FIXTURES);
  assert.equal(typeof r.liveReady, "boolean");
  assert.ok(Array.isArray(r.blockers));
  assert.equal(r.liveReady, r.blockers.length === 0, "liveReady と blockers が食い違っている");
  for (const b of r.blockers) assert.match(b, /^F[1-4]: /);

  // 逆向き: 1件でも未測定に戻せば liveReady は false になる（緑に見せない）。
  const withUnmeasured = FIXTURES.map((f, i) =>
    i === 0 ? { ...f, oracle: { ...f.oracle, measured: false } } : f,
  );
  const r2 = fixtureReadiness(withUnmeasured);
  assert.equal(r2.liveReady, false, "未測定が1件でもあれば実走可にしない");
  assert.ok(r2.blockers.length > 0);
});

test("oracle が未測定のフィクスチャは blockers に必ず出る", () => {
  const r = fixtureReadiness(FIXTURES);
  const unmeasured = FIXTURES.filter((f) => !f.oracle.measured).map((f) => f.id);
  for (const id of unmeasured) {
    assert.ok(r.blockers.some((b) => b.startsWith(`${id}: `) && /未測定|derived|未確定/.test(b)), `${id} が blockers に無い`);
  }
});
