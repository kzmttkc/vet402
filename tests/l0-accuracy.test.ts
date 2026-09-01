// §12 L0 誤pass/誤fail（純関数）
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeL0Accuracy, L0_FALSE_FAIL_TARGET_PCT, L0_FALSE_PASS_TARGET_PCT } from "@/lib/scoring/l0-accuracy";

test("誤fail = 公開failが7日以内の再測定でpassに覆った割合、誤pass = 公開passの次回が no_402", () => {
  const r = computeL0Accuracy({ publishedFail: 100, failFlippedToPassWithin7d: 2, publishedPass: 200, passFollowedByNo402: 3, minSample: 10 });
  assert.equal(r.false_fail_rate, 2);
  assert.equal(r.false_pass_rate, 1.5);
  assert.equal(r.slo.false_fail_ok, true); // < 3%
  assert.equal(r.slo.false_pass_ok, true); // < 2%
  assert.equal(L0_FALSE_FAIL_TARGET_PCT, 3);
  assert.equal(L0_FALSE_PASS_TARGET_PCT, 2);
});

test("SLO 違反は false になる（自社に不利な数字を隠さない）", () => {
  const r = computeL0Accuracy({ publishedFail: 100, failFlippedToPassWithin7d: 5, publishedPass: 100, passFollowedByNo402: 4, minSample: 10 });
  assert.equal(r.false_fail_rate, 5);
  assert.equal(r.slo.false_fail_ok, false);
  assert.equal(r.slo.false_pass_ok, false);
});

test("標本不足は null（ノイズから率を出さない）・SLO 判定も null", () => {
  const r = computeL0Accuracy({ publishedFail: 5, failFlippedToPassWithin7d: 1, publishedPass: 200, passFollowedByNo402: 0, minSample: 10 });
  assert.equal(r.false_fail_rate, null);
  assert.equal(r.slo.false_fail_ok, null);
  assert.equal(r.false_pass_rate, 0);
  assert.equal(r.slo.false_pass_ok, true);
});
