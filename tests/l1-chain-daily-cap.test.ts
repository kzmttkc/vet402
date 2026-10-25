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
  ARC_GATEWAY_DAILY_CAP_USD_DEFAULT,
  ARBITRUM_DAILY_CAP_USD_DEFAULT,
  BNB_DAILY_CAP_USD_DEFAULT,
  CELO_DAILY_CAP_USD_DEFAULT,
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

// ---- Celo（2026-10-10・Celo レーン）----
test("Celo: eip155:42220 だけが celo の別枠。テストネット・スラグ・前後に文字の付いた id は持たない", () => {
  assert.equal(cappedChainFor("eip155:42220"), "celo");
  assert.equal(cappedChainFor("eip155:11142220"), null, "Celo Sepolia は購入対象ではない");
  assert.equal(cappedChainFor("eip155:44787"), null, "Alfajores は購入対象ではない");
  assert.equal(cappedChainFor("celo"), null);
  assert.equal(cappedChainFor("eip155:422200"), null);
  assert.equal(cappedChainFor("eip155:4222"), null);
  assert.equal(CHAIN_DAILY_CAPS.celo.env, "L1_CELO_DAILY_CAP_USD");
  assert.equal(CHAIN_DAILY_CAPS.celo.networkLike, "eip155:42220", "ワイルドカード無し＝完全一致");
  assert.ok(!/[%_]/.test(CHAIN_DAILY_CAPS.celo.networkLike), "LIKE のワイルドカードを含まない");
});

test("Celo の既定は Arc と同じ $2。0 は Celo を止める。壊れた値・負の値は既定へ倒す。共有上限で頭打ち", () => {
  assert.equal(CELO_DAILY_CAP_USD_DEFAULT, ARC_DAILY_CAP_USD_DEFAULT);
  withEnv("L1_CELO_DAILY_CAP_USD", undefined, () => assert.equal(chainDailyCapUnits("celo"), 2_000_000n));
  withEnv("L1_CELO_DAILY_CAP_USD", "0.5", () => assert.equal(chainDailyCapUnits("celo"), 500_000n));
  withEnv("L1_CELO_DAILY_CAP_USD", "0", () => assert.equal(chainDailyCapUnits("celo"), 0n, "0 は 1 件も払わない"));
  for (const v of ["", "abc", "-1", "NaN", "Infinity"]) {
    withEnv("L1_CELO_DAILY_CAP_USD", v, () => assert.equal(chainDailyCapUnits("celo"), 2_000_000n, `value ${JSON.stringify(v)}`));
  }
  withEnv("L1_CELO_DAILY_CAP_USD", "100", () => assert.equal(chainDailyCapUnits("celo"), BigInt(DAILY_BUDGET_USD) * 1_000_000n));
});

test("Stellar: stellar:pubnet だけが stellar の別枠。testnet・スラグは持たない", () => {
  assert.equal(cappedChainFor("stellar:pubnet"), "stellar");
  assert.equal(cappedChainFor("stellar:testnet"), null);
  assert.equal(cappedChainFor("stellar"), null);
  assert.equal(cappedChainFor("stellar:pubnet "), null);
  assert.equal(CHAIN_DAILY_CAPS.stellar.env, "L1_STELLAR_DAILY_CAP_USD");
  assert.equal(CHAIN_DAILY_CAPS.stellar.networkLike, "stellar:pubnet", "ワイルドカード無し＝完全一致");
  assert.ok(!/[%_]/.test(CHAIN_DAILY_CAPS.stellar.networkLike));
});

test("BNB: eip155:56 だけが bnb の別枠。テストネットと前後に文字の付いた id は持たない", () => {
  assert.equal(cappedChainFor("eip155:56"), "bnb");
  assert.equal(cappedChainFor("eip155:97"), null, "BSC testnet");
  assert.equal(cappedChainFor("eip155:204"), null, "opBNB");
  assert.equal(cappedChainFor("eip155:560"), null);
  assert.equal(cappedChainFor("eip155:5"), null);
  assert.equal(cappedChainFor("bnb"), null);
  assert.equal(cappedChainFor("bsc"), null);
  assert.equal(CHAIN_DAILY_CAPS.bnb.env, "L1_BNB_DAILY_CAP_USD");
  assert.equal(CHAIN_DAILY_CAPS.bnb.networkLike, "eip155:56", "ワイルドカード無し＝完全一致");
  assert.ok(!/[%_]/.test(CHAIN_DAILY_CAPS.bnb.networkLike));
  assert.equal(BNB_DAILY_CAP_USD_DEFAULT, 0.5);
});

test("Arbitrum: eip155:42161 だけが arbitrum の別枠。テストネット・スラグ・前後に文字の付いた id は持たない", () => {
  assert.equal(cappedChainFor("eip155:42161"), "arbitrum");
  assert.equal(cappedChainFor("eip155:421614"), null, "Arbitrum Sepolia");
  assert.equal(cappedChainFor("eip155:42170"), null, "Arbitrum Nova");
  assert.equal(cappedChainFor("arbitrum"), null);
  assert.equal(cappedChainFor("eip155:421610"), null);
  assert.equal(cappedChainFor("eip155:4216"), null);
  assert.equal(CHAIN_DAILY_CAPS.arbitrum.env, "L1_ARBITRUM_DAILY_CAP_USD");
  assert.equal(CHAIN_DAILY_CAPS.arbitrum.networkLike, "eip155:42161", "ワイルドカード無し＝完全一致");
  assert.ok(!/[%_]/.test(CHAIN_DAILY_CAPS.arbitrum.networkLike), "LIKE のワイルドカードを含まない");
});

test("Arbitrum の既定は Celo と同じ $2。0 は Arbitrum を止める。壊れた値・負の値は既定へ倒す。共有上限で頭打ち", () => {
  assert.equal(ARBITRUM_DAILY_CAP_USD_DEFAULT, CELO_DAILY_CAP_USD_DEFAULT);
  withEnv("L1_ARBITRUM_DAILY_CAP_USD", undefined, () => assert.equal(chainDailyCapUnits("arbitrum"), 2_000_000n));
  withEnv("L1_ARBITRUM_DAILY_CAP_USD", "0.5", () => assert.equal(chainDailyCapUnits("arbitrum"), 500_000n));
  withEnv("L1_ARBITRUM_DAILY_CAP_USD", "0", () => assert.equal(chainDailyCapUnits("arbitrum"), 0n, "0 は 1 件も払わない"));
  for (const v of ["", "abc", "-1", "NaN", "Infinity"]) {
    withEnv("L1_ARBITRUM_DAILY_CAP_USD", v, () => assert.equal(chainDailyCapUnits("arbitrum"), 2_000_000n, `value ${JSON.stringify(v)}`));
  }
  withEnv("L1_ARBITRUM_DAILY_CAP_USD", "100", () => assert.equal(chainDailyCapUnits("arbitrum"), BigInt(DAILY_BUDGET_USD) * 1_000_000n));
  withEnv("L1_ARBITRUM_DAILY_CAP_USD", "0", () => {
    withEnv("L1_CELO_DAILY_CAP_USD", undefined, () => {
      assert.equal(chainDailyCapUnits("arbitrum"), 0n);
      assert.equal(chainDailyCapUnits("celo"), 2_000_000n);
    });
  });
});

test("BNB の既定は $0.5。0 は BNB を止める。壊れた値は既定へ倒す。共有上限で頭打ち。他チェーンに効かない", () => {
  withEnv("L1_BNB_DAILY_CAP_USD", undefined, () => assert.equal(chainDailyCapUnits("bnb"), 500_000n));
  withEnv("L1_BNB_DAILY_CAP_USD", "0", () => assert.equal(chainDailyCapUnits("bnb"), 0n));
  withEnv("L1_BNB_DAILY_CAP_USD", "0.1", () => assert.equal(chainDailyCapUnits("bnb"), 100_000n));
  for (const v of ["", "abc", "-1", "NaN", "Infinity"]) {
    withEnv("L1_BNB_DAILY_CAP_USD", v, () => assert.equal(chainDailyCapUnits("bnb"), 500_000n, `value ${JSON.stringify(v)}`));
  }
  withEnv("L1_BNB_DAILY_CAP_USD", "100", () => assert.equal(chainDailyCapUnits("bnb"), BigInt(DAILY_BUDGET_USD) * 1_000_000n));
  withEnv("L1_BNB_DAILY_CAP_USD", "0", () => {
    withEnv("L1_CELO_DAILY_CAP_USD", undefined, () => {
      assert.equal(chainDailyCapUnits("bnb"), 0n);
      assert.equal(chainDailyCapUnits("celo"), 2_000_000n);
    });
  });
});

test("Arc Gateway: eip155:5042 は arc のまま。arc_gateway は network から返さない", () => {
  assert.equal(cappedChainFor("eip155:5042"), "arc");
  assert.equal(cappedChainFor("circle-gateway:5042"), null);
  assert.equal(cappedChainFor("arc_gateway"), null);
  assert.equal(cappedChainFor(""), null);
  assert.equal(CHAIN_DAILY_CAPS.arc_gateway.env, "L1_ARC_GATEWAY_DAILY_CAP_USD");
  assert.equal(CHAIN_DAILY_CAPS.arc_gateway.networkLike, "circle-gateway:5042");
  assert.ok(!/[%_]/.test(CHAIN_DAILY_CAPS.arc_gateway.networkLike), "LIKE のワイルドカードを含まない");
  assert.equal(ARC_GATEWAY_DAILY_CAP_USD_DEFAULT, 2);
});

test("Arc Gateway の既定は $2。0 は Gateway を止める。壊れた値は既定へ倒す。Arc の別枠は動かさない", () => {
  withEnv("L1_ARC_GATEWAY_DAILY_CAP_USD", undefined, () => assert.equal(chainDailyCapUnits("arc_gateway"), 2_000_000n));
  withEnv("L1_ARC_GATEWAY_DAILY_CAP_USD", "0.5", () => assert.equal(chainDailyCapUnits("arc_gateway"), 500_000n));
  withEnv("L1_ARC_GATEWAY_DAILY_CAP_USD", "0", () => assert.equal(chainDailyCapUnits("arc_gateway"), 0n, "0 は 1 件も払わない"));
  for (const v of ["", "abc", "-1", "NaN", "Infinity"]) {
    withEnv("L1_ARC_GATEWAY_DAILY_CAP_USD", v, () => assert.equal(chainDailyCapUnits("arc_gateway"), 2_000_000n, `value ${JSON.stringify(v)}`));
  }
  withEnv("L1_ARC_GATEWAY_DAILY_CAP_USD", "100", () => assert.equal(chainDailyCapUnits("arc_gateway"), BigInt(DAILY_BUDGET_USD) * 1_000_000n));
  withEnv("L1_ARC_GATEWAY_DAILY_CAP_USD", "0", () => {
    withEnv("L1_ARC_DAILY_CAP_USD", undefined, () => {
      assert.equal(chainDailyCapUnits("arc_gateway"), 0n);
      assert.equal(chainDailyCapUnits("arc"), 2_000_000n);
    });
  });
});

test("Celo の別枠は他のチェーンの環境変数に動かされず、他のチェーンの別枠も動かさない", () => {
  withEnv("L1_CELO_DAILY_CAP_USD", "0", () => {
    withEnv("L1_ARC_DAILY_CAP_USD", undefined, () => {
      assert.equal(chainDailyCapUnits("celo"), 0n);
      assert.equal(chainDailyCapUnits("arc"), 2_000_000n);
    });
  });
  withEnv("L1_ARC_DAILY_CAP_USD", "0", () => {
    withEnv("L1_CELO_DAILY_CAP_USD", undefined, () => assert.equal(chainDailyCapUnits("celo"), 2_000_000n));
  });
});
