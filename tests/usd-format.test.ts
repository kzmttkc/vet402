// ============================================================
// 金額表示の統一（2026-09-02 監査 P2）。/impact の "$16.71" と /decisions の
// "$16.712" が別関数で桁が違った。USDC（6 桁 units）は小数 2 桁、1 セント未満は
// 4 桁で、同じ関数から出す。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatUsdcUnits } from "@/lib/util/usd";

test("1 セント以上は小数 2 桁", () => {
  assert.equal(formatUsdcUnits("16712000"), "$16.71");
  assert.equal(formatUsdcUnits(16712000), "$16.71");
  assert.equal(formatUsdcUnits("1000000"), "$1.00");
  assert.equal(formatUsdcUnits("10000"), "$0.01");
  assert.equal(formatUsdcUnits("3000000"), "$3.00");
});

test("1 セント未満は小数 4 桁（0 と区別できるように）", () => {
  assert.equal(formatUsdcUnits("3000"), "$0.0030");
  assert.equal(formatUsdcUnits("100"), "$0.0001");
  assert.equal(formatUsdcUnits("9999"), "$0.0100");
});

test("0 と不正入力", () => {
  assert.equal(formatUsdcUnits("0"), "$0.00");
  assert.equal(formatUsdcUnits(0), "$0.00");
  assert.equal(formatUsdcUnits("abc"), "—");
  assert.equal(formatUsdcUnits(null), "—");
  assert.equal(formatUsdcUnits(undefined), "—");
});
