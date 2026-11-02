// 実績のない売り手の上限の環境変数（2026-11-02 監査 H-1）。DB なしの部分。予約と候補の動きは tests/l1-unproven-cap.pg.test.ts。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVEN_MIN_AGE_DAYS,
  PROVEN_MIN_DELIVERED_DAYS,
  SELLER_DAILY_CAP_USD_DEFAULT,
  DOMAIN_DAILY_CAP_USD_DEFAULT,
  DAILY_BUDGET_USD,
  overDimeDailyCapUnits,
  OVER_DIME_THRESHOLD_UNITS,
  unprovenDailyCapUnits,
  unprovenPurchaseCapUnits,
} from "@/lib/observatory/budget";

const withEnv = (name: string, value: string | undefined, f: () => void) => {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    f();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
};

test("1 件の上限: 既定 $0.10・0 で止める・壊れた値は既定・$1 で頭打ち", () => {
  const n = "L1_UNPROVEN_PURCHASE_CAP_USD";
  withEnv(n, undefined, () => assert.equal(unprovenPurchaseCapUnits(), 100_000n));
  withEnv(n, "", () => assert.equal(unprovenPurchaseCapUnits(), 100_000n));
  withEnv(n, "0", () => assert.equal(unprovenPurchaseCapUnits(), 0n));
  withEnv(n, "0.05", () => assert.equal(unprovenPurchaseCapUnits(), 50_000n));
  withEnv(n, "abc", () => assert.equal(unprovenPurchaseCapUnits(), 100_000n));
  withEnv(n, "-1", () => assert.equal(unprovenPurchaseCapUnits(), 100_000n));
  withEnv(n, "99", () => assert.equal(unprovenPurchaseCapUnits(), 1_000_000n));
});

test("日次合計: 既定 $3・0 で止める・壊れた値は既定・日次 $25 で頭打ち", () => {
  const n = "L1_UNPROVEN_DAILY_CAP_USD";
  withEnv(n, undefined, () => assert.equal(unprovenDailyCapUnits(), 3_000_000n));
  withEnv(n, "0", () => assert.equal(unprovenDailyCapUnits(), 0n));
  withEnv(n, "1.5", () => assert.equal(unprovenDailyCapUnits(), 1_500_000n));
  withEnv(n, "NaN", () => assert.equal(unprovenDailyCapUnits(), 3_000_000n));
  withEnv(n, "1000", () => assert.equal(unprovenDailyCapUnits(), 25_000_000n));
});

test("$0.10 超の日次枠: 既定 $15・0 で止める・壊れた値は既定・日次 $25 で頭打ち。境目は環境変数で動かない", () => {
  const n = "L1_OVER_DIME_DAILY_CAP_USD";
  withEnv(n, undefined, () => assert.equal(overDimeDailyCapUnits(), 15_000_000n));
  withEnv(n, "0", () => assert.equal(overDimeDailyCapUnits(), 0n));
  withEnv(n, "2.5", () => assert.equal(overDimeDailyCapUnits(), 2_500_000n));
  withEnv(n, "x", () => assert.equal(overDimeDailyCapUnits(), 15_000_000n));
  withEnv(n, "100", () => assert.equal(overDimeDailyCapUnits(), 25_000_000n));
  assert.equal(OVER_DIME_THRESHOLD_UNITS, 100_000n);
});

test("実績の定義と既存の上限の値", () => {
  assert.equal(PROVEN_MIN_DELIVERED_DAYS, 3);
  assert.equal(PROVEN_MIN_AGE_DAYS, 14);
  assert.equal(SELLER_DAILY_CAP_USD_DEFAULT, 2);
  assert.equal(DOMAIN_DAILY_CAP_USD_DEFAULT, 3);
  assert.equal(DAILY_BUDGET_USD, 25);
});
