// §10 連続異議のレート制限（純関数）
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDisputeRateLimited, DISPUTE_MAX_PER_WINDOW, DISPUTE_WINDOW_DAYS } from "@/lib/observatory/corrections";

const now = new Date("2026-09-02T00:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

test("7 日で 3 件未満なら通す", () => {
  assert.equal(isDisputeRateLimited([], now), false);
  assert.equal(isDisputeRateLimited([daysAgo(1), daysAgo(2)], now), false);
});
test("7 日で 3 件に達したら止める", () => {
  assert.equal(DISPUTE_MAX_PER_WINDOW, 3);
  assert.equal(isDisputeRateLimited([daysAgo(1), daysAgo(2), daysAgo(3)], now), true);
});
test("窓の外の古い異議は数えない", () => {
  assert.equal(DISPUTE_WINDOW_DAYS, 7);
  assert.equal(isDisputeRateLimited([daysAgo(8), daysAgo(9), daysAgo(1)], now), false);
});
