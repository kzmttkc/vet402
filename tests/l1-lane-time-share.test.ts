// ============================================================
// L1 のレーン枠の時間の上限（L1_LANE_TIME_SHARE・2026-10-27）— 環境変数の読み取り。
//
// 本番の実測（2026-10-27・読み取り）: レーン枠の合計が 27 件から 45 件に増え、遅いレーン
// （Stellar 10〜12 秒/件、BNB・XRPL・Avalanche ~12 秒/件）が先頭で持ち時間 210 秒を使い切った。
// 10/26 02:00 と 17:30 UTC の実行では Base が 0 件。使った時間がこの割合を超えたあとのレーン候補は
// 買わずに飛ばす。ここは純関数（環境変数）だけ。購入の挙動は l1-lane-time-share.pg.test.ts。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { LANE_TIME_SHARE_DEFAULT, laneTimeShare } from "@/lib/observatory/budget";

function withEnv(name: string, value: string | undefined, fn: () => void) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

test("既定は 0.5（持ち時間の半分）", () => {
  assert.equal(LANE_TIME_SHARE_DEFAULT, 0.5);
  withEnv("L1_LANE_TIME_SHARE", undefined, () => assert.equal(laneTimeShare(), 0.5));
});

test("0〜1 の十進表記はそのまま読む（両端を含む・前後の空白は無視）", () => {
  withEnv("L1_LANE_TIME_SHARE", "0", () => assert.equal(laneTimeShare(), 0));
  withEnv("L1_LANE_TIME_SHARE", "1", () => assert.equal(laneTimeShare(), 1));
  withEnv("L1_LANE_TIME_SHARE", "0.3", () => assert.equal(laneTimeShare(), 0.3));
  withEnv("L1_LANE_TIME_SHARE", ".25", () => assert.equal(laneTimeShare(), 0.25));
  withEnv("L1_LANE_TIME_SHARE", "1.0", () => assert.equal(laneTimeShare(), 1));
  withEnv("L1_LANE_TIME_SHARE", " 0.7 ", () => assert.equal(laneTimeShare(), 0.7));
});

test("不正な値（空・範囲外・負・数字でない・指数・16 進・百分率）は既定へ倒す", () => {
  for (const v of ["", "  ", "abc", "-0.1", "-1", "1.5", "2", "NaN", "Infinity", "1e-1", "0x1", "50%", "0.5.1"]) {
    withEnv("L1_LANE_TIME_SHARE", v, () => assert.equal(laneTimeShare(), LANE_TIME_SHARE_DEFAULT, `value ${JSON.stringify(v)}`));
  }
});
