// ============================================================
// L1 のチェーン別の日次別枠（2026-09-17・Arc レーン）。
//
// 2026-09-15 の Solana の別枠（$2・共有 $25 の内側）を、チェーンごとの表に一般化した。
// Arc（eip155:5042）も同じ $2 の別枠を持つ。Base は別枠を持たない（共有 $25 だけ）。
//
// ここは純関数（環境変数の読み取りと network → 別枠の対応）だけ。予約と候補選びの
// 挙動は l1-solana-daily-cap.pg.test.ts と l1-arc-lane.pg.test.ts。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARC_DAILY_CAP_USD_DEFAULT,
  CHAIN_DAILY_CAPS,
  DAILY_BUDGET_USD,
  SOLANA_DAILY_CAP_USD_DEFAULT,
  cappedChainFor,
  chainDailyCapUnits,
  solanaDailyCapUnits,
} from "@/lib/observatory/budget";

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

test("cappedChainFor: Solana mainnet と Arc だけが別枠を持つ。Base・他の EVM・Arc testnet は持たない", () => {
  assert.equal(cappedChainFor("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"), "solana");
  assert.equal(cappedChainFor("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"), "solana", "devnet 行も solana: の別枠に数える（既存の LIKE 'solana:%' と同じ）");
  assert.equal(cappedChainFor("eip155:5042"), "arc");
  assert.equal(cappedChainFor("eip155:5042002"), null, "Arc testnet は購入対象ではない");
  assert.equal(cappedChainFor("eip155:8453"), null);
  assert.equal(cappedChainFor("base"), null);
  assert.equal(cappedChainFor("eip155:137"), null);
  assert.equal(cappedChainFor(""), null);
});

test("表: 環境変数名・既定値・SQL の LIKE パターン", () => {
  assert.equal(CHAIN_DAILY_CAPS.solana.env, "L1_SOLANA_DAILY_CAP_USD");
  assert.equal(CHAIN_DAILY_CAPS.solana.networkLike, "solana:%");
  assert.equal(CHAIN_DAILY_CAPS.arc.env, "L1_ARC_DAILY_CAP_USD");
  assert.equal(CHAIN_DAILY_CAPS.arc.networkLike, "eip155:5042", "ワイルドカード無し＝完全一致。5042002（testnet）を巻き込まない");
  assert.equal(ARC_DAILY_CAP_USD_DEFAULT, 2);
  assert.equal(SOLANA_DAILY_CAP_USD_DEFAULT, 2);
});

test("Arc の既定は $2（Base の実測最大 $22.73 を Solana と合わせても押し出さない）", () => {
  withEnv("L1_ARC_DAILY_CAP_USD", undefined, () => assert.equal(chainDailyCapUnits("arc"), 2_000_000n));
  assert.ok(DAILY_BUDGET_USD - SOLANA_DAILY_CAP_USD_DEFAULT - ARC_DAILY_CAP_USD_DEFAULT > 20, "両方の別枠を引いても Base に $20 以上残る");
});

test("Arc: 環境変数で下げられる。0 は Arc を止める。壊れた値・負の値は既定へ倒す。共有上限で頭打ち", () => {
  withEnv("L1_ARC_DAILY_CAP_USD", "0.5", () => assert.equal(chainDailyCapUnits("arc"), 500_000n));
  withEnv("L1_ARC_DAILY_CAP_USD", "0", () => assert.equal(chainDailyCapUnits("arc"), 0n));
  for (const v of ["", "abc", "-1", "NaN", "Infinity"]) {
    withEnv("L1_ARC_DAILY_CAP_USD", v, () => assert.equal(chainDailyCapUnits("arc"), 2_000_000n, `value ${JSON.stringify(v)}`));
  }
  withEnv("L1_ARC_DAILY_CAP_USD", "100", () => assert.equal(chainDailyCapUnits("arc"), BigInt(DAILY_BUDGET_USD) * 1_000_000n));
});

test("Arc と Solana の別枠は独立に読む（片方の環境変数はもう片方に効かない）", () => {
  withEnv("L1_ARC_DAILY_CAP_USD", "0.25", () => {
    withEnv("L1_SOLANA_DAILY_CAP_USD", undefined, () => {
      assert.equal(chainDailyCapUnits("arc"), 250_000n);
      assert.equal(chainDailyCapUnits("solana"), 2_000_000n);
      assert.equal(solanaDailyCapUnits(), chainDailyCapUnits("solana"), "solanaDailyCapUnits は表の solana 行の別名のまま");
    });
  });
});
