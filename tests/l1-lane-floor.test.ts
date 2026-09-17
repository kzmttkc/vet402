// ============================================================
// L1 のチェーンごとの候補の最低枠（per-lane floor・2026-09-17）。
//
// 候補 SQL は需要順で 1 回 LIMIT 100 を取るが、cron が 1 回に処理できるのは 20〜30 件。
// Solana（候補 204・未購入 192）は需要順で EVM の未購入 7,898 件に負け、$2 の別枠を
// 一度も使い切れずに 1 件/日しか買えていなかった（9/17 は 0 件）。Arc も同じ理由で
// 自然には選ばれない。そこで別枠を持つレーンごとに LIMIT laneFloorPerRun() の候補を
// 主候補の先頭に置く。ここは純関数（環境変数の読み取り）だけ。並びと購入の挙動は
// l1-lane-floor.pg.test.ts。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { LANE_FLOOR_PER_RUN_DEFAULT, LANE_FLOOR_PER_RUN_MAX, laneFloorPerRun } from "@/lib/observatory/budget";

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

test("既定は 5 件、上限は 20 件（Base の候補を毎回 20 件以上残す）", () => {
  assert.equal(LANE_FLOOR_PER_RUN_DEFAULT, 5);
  assert.equal(LANE_FLOOR_PER_RUN_MAX, 20);
  withEnv("L1_LANE_FLOOR_PER_RUN", undefined, () => assert.equal(laneFloorPerRun(), 5));
});

test("環境変数で変えられる: 0 は枠なし、整数はそのまま、上限で頭打ち", () => {
  withEnv("L1_LANE_FLOOR_PER_RUN", "0", () => assert.equal(laneFloorPerRun(), 0));
  withEnv("L1_LANE_FLOOR_PER_RUN", "1", () => assert.equal(laneFloorPerRun(), 1));
  withEnv("L1_LANE_FLOOR_PER_RUN", "12", () => assert.equal(laneFloorPerRun(), 12));
  withEnv("L1_LANE_FLOOR_PER_RUN", "20", () => assert.equal(laneFloorPerRun(), 20));
  withEnv("L1_LANE_FLOOR_PER_RUN", "21", () => assert.equal(laneFloorPerRun(), 20));
  withEnv("L1_LANE_FLOOR_PER_RUN", "100", () => assert.equal(laneFloorPerRun(), 20));
  withEnv("L1_LANE_FLOOR_PER_RUN", " 7 ", () => assert.equal(laneFloorPerRun(), 7, "前後の空白は無視"));
});

test("壊れた値・負の値・小数・非有限は既定へ倒す（設定ミスで枠が消えたり膨らんだりしない）", () => {
  for (const v of ["", "  ", "abc", "-1", "-0.5", "2.5", "NaN", "Infinity", "1e1", "0x10"]) {
    withEnv("L1_LANE_FLOOR_PER_RUN", v, () => assert.equal(laneFloorPerRun(), LANE_FLOOR_PER_RUN_DEFAULT, `value ${JSON.stringify(v)}`));
  }
});
