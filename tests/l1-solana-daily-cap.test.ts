// ============================================================
// L1 の Solana 別枠（2026-09-15・グラント戦略の発注②の前提）。
//
// 日次 $25 は全チェーンで共有している。Solana のブートストラップ掃引（稼働中の Solana
// エンドポイントへ各 1 回・1 周 約 $5.23）を流すと、未購入を先に選ぶ並び順のせいで
// Base の定期購入の枠を先に食いうる。公開台帳の実測（2026-09-02〜15）: Base の日次支出は
// 平均 $13.95・最大 $22.73。Solana に $2 の別枠を付ければ Base には毎日 $23 以上が残る。
//
// ここは純関数（環境変数の読み取り）だけ。予約と候補選びの挙動は l1-solana-daily-cap.pg.test.ts。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { DAILY_BUDGET_USD, SOLANA_DAILY_CAP_USD_DEFAULT, solanaDailyCapUnits } from "@/lib/observatory/budget";

function withEnv(value: string | undefined, fn: () => void) {
  const saved = process.env.L1_SOLANA_DAILY_CAP_USD;
  if (value === undefined) delete process.env.L1_SOLANA_DAILY_CAP_USD;
  else process.env.L1_SOLANA_DAILY_CAP_USD = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.L1_SOLANA_DAILY_CAP_USD;
    else process.env.L1_SOLANA_DAILY_CAP_USD = saved;
  }
}

test("既定は $2（Base の実測最大 $22.73 を押し出さない）", () => {
  assert.equal(SOLANA_DAILY_CAP_USD_DEFAULT, 2);
  withEnv(undefined, () => assert.equal(solanaDailyCapUnits(), 2_000_000n));
  assert.ok(DAILY_BUDGET_USD - SOLANA_DAILY_CAP_USD_DEFAULT > 22.73);
});

test("環境変数で下げられる。0 は Solana を止める", () => {
  withEnv("0.5", () => assert.equal(solanaDailyCapUnits(), 500_000n));
  withEnv("0", () => assert.equal(solanaDailyCapUnits(), 0n));
});

test("壊れた値・負の値は既定へ倒す（上げる方向に誤らない）", () => {
  for (const v of ["", "abc", "-1", "NaN", "Infinity"]) {
    withEnv(v, () => assert.equal(solanaDailyCapUnits(), 2_000_000n, `value ${JSON.stringify(v)}`));
  }
});

test("全チェーン共有の日次上限を超える値は日次上限で頭打ち", () => {
  withEnv("100", () => assert.equal(solanaDailyCapUnits(), BigInt(DAILY_BUDGET_USD) * 1_000_000n));
});
