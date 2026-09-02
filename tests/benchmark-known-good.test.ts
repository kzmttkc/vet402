// ============================================================
// Vouch — the known-good addresses on /accuracy must not come back BLOCK.
//
// WHY THIS FILE EXISTS (2026-08-13). /accuracy published "0 of 17 allowed,
// 15 blocked — 88.2% false positives" against the operator benchmark's
// known-good set: long-operating, publicly attributed addresses (Vitalik, the
// Ethereum Foundation, Binance/Coinbase/Kraken operational wallets, the ENS
// DAO treasury, Gitcoin's matching pool). A trust layer that refuses every
// address the world already agrees is fine, and says so on its own marketing
// site, is worse than one that is switched off.
//
// The cause was NOT judgment. Measured against the production database
// (trust_events, scan of 2026-08-12 21:11-21:12 UTC), the run scored five
// addresses successfully and then returned this for all 37 that followed:
//
//     ageDays: 0, txCount: 0, isBurner: true,
//     flags: ["new_burner_wallet", "wallet_metrics_unavailable"],
//     sybil: high  ->  score 10  ->  BLOCK
//
// Every one of those verdicts is the fail-closed path working exactly as
// designed on top of a read that never happened: the scan spent Blockscout's
// v1 burst budget on its first few addresses and was rate-limited out for the
// rest. "We could not check" correctly becomes BLOCK — so the repair belongs
// in ACQUISITION (fewer, paced requests: see fetchWalletHistoryHead and the
// rate gate in src/lib/chain/blockscout.ts), never in the verdict rules.
//
// This file is the gate on the OTHER half of that sentence: once the data IS
// readable, these addresses must not be blocked. It is deliberately built from
// the pure scoring functions and REAL measurements, so it fails if anyone
// re-tightens the verdict path into the known-good set.
//
// The tx counts below were measured 2026-08-13 from
// base.blockscout.com/api/v2/addresses/{address}/counters (transactions_count)
// and independently agree with the counts recorded in dataset.ts at assembly
// time on 2026-08-06 — two instruments, one answer.
//
// ON "ALLOW": these are bare wallets with no ERC-8004 registration and no
// reputation history, and the engine caps that class well below the ALLOW
// threshold by design (see the ceiling test at the bottom, which pins the
// arithmetic). The honest bar for a known-good unregistered wallet is
// therefore "not a false positive" — not BLOCK — which is exactly what
// /accuracy's headline benchmark number measures (blocked / total).
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCORE_THRESHOLDS, SCORE_WEIGHTS } from "@/lib/chain/config";
import {
  applySybilPenalty,
  computeWeightedScore,
  normalizeWalletScore,
  X402_NO_HISTORY_SCORE,
} from "@/lib/scoring/helpers";
import { assessSybilRisk, resolveRecommendation } from "@/lib/scoring/verdict";

/** Bare-wallet neutral defaults, mirroring scoreWallet() in engine.ts. */
const WALLET_IDENTITY_SCORE = 30;
const WALLET_REPUTATION_SCORE = 30;
/**
 * 2026-09-02: この鏡は x402 軸を「中立 50」と写していたが、engine.ts は
 * 2026-08-13 以降 scoreEconomicActivity → X402_NO_HISTORY_SCORE(30) を入れている
 * （決済 0 件は中立ではなく「空」）。50 のままだと、この file が語る「未登録
 * ウォレットの天井」が 62 に見える——本当の天井は 52 で、known-good 17 件の
 * 本番実測（47/50）はそこから来ている。鏡は実装と同じ定数を引く。
 */
const X402_NEUTRAL_SCORE = X402_NO_HISTORY_SCORE;

/**
 * The verdict scoreWallet() produces for an unregistered wallet, expressed in
 * pure functions. Mirrors src/lib/scoring/engine.ts scoreWallet(); the
 * consistency of the two is what verdict-consistency.test.ts guards.
 */
function verdictForBareWallet(input: {
  ageDays: number;
  txCount: number;
  flags?: string[];
}): { score: number; recommendation: string; risk: string } {
  const flags = input.flags ?? [];
  const wallet = normalizeWalletScore({ ageDays: input.ageDays, txCount: input.txCount });
  const allFlags = [...new Set([...flags, ...wallet.flags])];
  const risk = assessSybilRisk(allFlags);
  const score = applySybilPenalty(
    computeWeightedScore(
      WALLET_IDENTITY_SCORE,
      WALLET_REPUTATION_SCORE,
      wallet.score,
      X402_NEUTRAL_SCORE,
    ),
    allFlags,
  );
  return { score, recommendation: resolveRecommendation(score, "none", risk), risk };
}

/**
 * The 17 known-good entries of src/lib/benchmark/dataset.ts, with Base
 * transaction counts measured 2026-08-13 via the v2 counters endpoint.
 * ageDays is the floor implied by the dataset's own admission rule (every
 * entry was verified to have real Base activity when assembled on 2026-08-06,
 * and all are long-operating addresses) — the test asserts the verdict holds
 * at that floor, so a real, larger age can only score higher.
 */
const KNOWN_GOOD_MEASURED: Array<{ label: string; txCount: number }> = [
  { label: "vitalik.eth", txCount: 37157 },
  { label: "Ethereum Foundation", txCount: 154 },
  { label: "Binance (proof-of-reserves cold)", txCount: 707 },
  { label: "Binance 14 hot", txCount: 115 },
  { label: "Binance 15 hot", txCount: 81 },
  { label: "Binance 16 hot", txCount: 81 },
  { label: "Binance 17 hot", txCount: 26 },
  { label: "Binance 18 hot", txCount: 19 },
  { label: "Coinbase operational", txCount: 7786660 },
  { label: "Coinbase 1", txCount: 20 },
  { label: "Coinbase 2", txCount: 8 },
  { label: "Coinbase 3", txCount: 8 },
  { label: "Coinbase 4", txCount: 12 },
  { label: "Kraken 4", txCount: 18 },
  { label: "Kraken", txCount: 7 },
  { label: "ENS DAO treasury", txCount: 4 },
  { label: "Gitcoin Grants matching pool", txCount: 21 },
];

/** Every entry is an address that has been operating for years. */
const ESTABLISHED_AGE_DAYS = 90;

test("GATE: 既知の善良アドレスは、データが読めていれば1件もBLOCKされない", () => {
  const blocked: string[] = [];
  for (const entry of KNOWN_GOOD_MEASURED) {
    const verdict = verdictForBareWallet({
      ageDays: ESTABLISHED_AGE_DAYS,
      txCount: entry.txCount,
    });
    if (verdict.recommendation === "BLOCK") {
      blocked.push(`${entry.label} (txCount=${entry.txCount} -> ${verdict.score})`);
    }
  }

  assert.deepEqual(
    blocked,
    [],
    `known-good が誤検知(BLOCK)されている: ${blocked.join(", ")}`,
  );
  assert.equal(KNOWN_GOOD_MEASURED.length, 17, "データセットの件数が変わったらこの関門を見直すこと");
});

test("GATE: 善良アドレスの sybil risk は high にならない(=無条件BLOCKに落ちない)", () => {
  for (const entry of KNOWN_GOOD_MEASURED) {
    const verdict = verdictForBareWallet({
      ageDays: ESTABLISHED_AGE_DAYS,
      txCount: entry.txCount,
    });
    assert.notEqual(
      verdict.risk,
      "high",
      `${entry.label}: 実データが読めているのに sybil=high`,
    );
  }
});

test("REGRESSION: 取得失敗を1件でも混ぜると、同じアドレスが即BLOCKに戻る", () => {
  // 旧実装の実測そのもの。この関門が守っているのは「判定を緩めたこと」ではなく
  // 「データが取れるようになったこと」だと示す対の検算——fail-closed は生きている。
  for (const entry of KNOWN_GOOD_MEASURED.slice(0, 3)) {
    const degraded = verdictForBareWallet({
      ageDays: 0,
      txCount: 0,
      flags: ["wallet_metrics_unavailable"],
    });
    assert.equal(degraded.risk, "high", `${entry.label}: 取得失敗が high に写っていない`);
    assert.equal(
      degraded.recommendation,
      "BLOCK",
      `${entry.label}: 取得失敗が BLOCK に写っていない——fail-closed が壊れている`,
    );
  }
});

test("FAIL-CLOSED: どんなに good なウォレットでも、未取得フラグが1つ付けばBLOCK", () => {
  // 「善良と判定できる」ことと「とりあえず通す」ことを取り違えていないかの関門。
  const best = verdictForBareWallet({ ageDays: 4000, txCount: 7786660 });
  assert.notEqual(best.recommendation, "BLOCK");

  for (const flag of [
    "wallet_metrics_unavailable",
    "feedback_stats_unavailable",
    "reputation_summary_unavailable",
    "owner_count_unavailable",
    "sybil_checks_unavailable",
    "x402_unavailable",
  ]) {
    const degraded = verdictForBareWallet({ ageDays: 4000, txCount: 7786660, flags: [flag] });
    assert.equal(
      degraded.recommendation,
      "BLOCK",
      `${flag} が付いているのに BLOCK になっていない——fail-open の穴`,
    );
  }
});

test("本番実測(2026-09-02): known-good 17 件は 47/50、known-bad の最高も 47——同じ帯に居る", () => {
  // scoreWallet が本番 DB に残した最新の benchmark_seed 判定（2026-09-02 10:18 UTC）:
  //   known-good 17 件: ageDays 876-1145 / txCount 84-100 / x402 0 件 / flags [] → 47 または 50、全部 WARN
  //   known-bad  25 件: 17 件が WARN（44-47）、8 件が BLOCK（Base 上で取引 0 の burner）
  //   Lazarus (Ronin) 0x098b716b…: ageDays 882 / txCount 29 → 47 WARN
  // この再現が壊れたら、テストの鏡（verdictForBareWallet）が engine.ts から
  // ずれている。ずれたまま「天井」を語ると、/accuracy の意味を読み違える。
  const coinbaseLike = verdictForBareWallet({ ageDays: 1129, txCount: 100 });
  const ensDaoLike = verdictForBareWallet({ ageDays: 1130, txCount: 97 });
  const lazarusRonin = verdictForBareWallet({ ageDays: 882, txCount: 29 });
  assert.equal(coinbaseLike.score, 50);
  assert.equal(coinbaseLike.recommendation, "WARN");
  assert.equal(ensDaoLike.score, 47);
  assert.equal(lazarusRonin.score, 47);
  assert.equal(lazarusRonin.recommendation, "WARN");
  // known-good と known-bad が同点で並ぶ帯。ALLOW 閾値をここまで下げると
  // 制裁アドレスが ALLOW になる——「閾値で ALLOW を作らない」の数値的根拠。
  assert.ok(
    SCORE_THRESHOLDS.allow > Math.max(coinbaseLike.score, lazarusRonin.score),
    "ALLOW 閾値が known-bad の到達点（47）以下——閾値で ALLOW を作ると Lazarus が通る",
  );
});

test("未登録ウォレットのスコア上限は ALLOW 閾値未満である(設計上の天井を明文化)", () => {
  // /accuracy の「0 of 17 allowed」は取得障害ではなく、この天井から来ている。
  // ERC-8004 の登録も評判履歴も無いウォレットは、活動がどれだけ健全でも
  // 「素性が分かっている」ことにはならない。天井を上げれば known-bad も一緒に
  // 上がるので、ここは数字を良く見せるために動かしてよい場所ではない。
  const ceiling = computeWeightedScore(
    WALLET_IDENTITY_SCORE,
    WALLET_REPUTATION_SCORE,
    100, // normalizeWalletScore の最大値
    X402_NEUTRAL_SCORE,
  );
  assert.ok(
    ceiling < SCORE_THRESHOLDS.allow,
    `未登録ウォレットの上限 ${ceiling} が ALLOW 閾値 ${SCORE_THRESHOLDS.allow} に届いている`,
  );
  assert.ok(
    ceiling >= SCORE_THRESHOLDS.warn,
    `未登録ウォレットの上限 ${ceiling} が WARN 閾値 ${SCORE_THRESHOLDS.warn} 未満——健全なウォレットを構造的に全部BLOCKしてしまう`,
  );
  // 重みが動いたらこの天井も動く。動かしたことに気づかないまま
  // /accuracy の意味が変わるのを防ぐ。
  const weightSum =
    SCORE_WEIGHTS.identity + SCORE_WEIGHTS.reputation + SCORE_WEIGHTS.wallet + SCORE_WEIGHTS.x402;
  assert.equal(Math.round(weightSum * 100) / 100, 0.8);
});
