// ============================================================
// 2026-08-26: 「我々が払って、届かなかった」が判定に効くことを固定する。
//
// 本番実測（変更前）:
//   0x36038e1d… 48回払って 48回決済 → 受取軸 76 → 最終 69 WARN
//   0x76a672…  140回払って  0回決済 → 受取軸 50 → 最終 69 WARN
// 完璧に届ける相手と、140回受け取って一度も届けない相手が同点だった。
//
// 原因: scoreL1Receiving は deliveryCount<=0 で 50 を返し（「測っていない」と
// 「測ったが届かなかった」を同じ中立値に潰す）、受取軸の合成が Math.max なので
// L1 の記録はスコアを上げることしかできなかった。不履行は構造的に不可視。
//
// このテストが守るのは、効かせたこと**と**、罰しすぎないことの両方。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCORE_THRESHOLDS } from "@/lib/chain/config";
import { PAID_ATTEMPT_STATUSES } from "@/lib/observatory/reader";
import {
  nonDeliveryCeiling,
  nonDeliveryReason,
  RESOLVED_NON_SETTLING_STATUSES,
  L1_NONDELIVERY_SEVERE_CEILING,
  L1_NONDELIVERY_MODERATE_CEILING,
  L1_NONDELIVERY_LIGHT_CEILING,
  EMPTY_L1_SETTLEMENT_RECORD,
} from "@/lib/scoring/l1-settlement-record";

const rec = (o: Partial<typeof EMPTY_L1_SETTLEMENT_RECORD>) => ({
  ...EMPTY_L1_SETTLEMENT_RECORD,
  ...o,
});

test("本番の 0x76a672…（140回・8日・決済0）は BLOCK 帯まで落ちる", () => {
  const c = nonDeliveryCeiling(rec({ resolvedNonSettling: 140, nonSettlingDays: 8 }));
  assert.equal(c, L1_NONDELIVERY_SEVERE_CEILING);
  assert.ok(c < SCORE_THRESHOLDS.warn, "天井が warn 以上では BLOCK に届かない");
  assert.equal(nonDeliveryReason(rec({ resolvedNonSettling: 140, nonSettlingDays: 8 })), "paid_never_settled_sustained");
});

test("本番の 0x36038e1d…（48回すべて決済）には天井を掛けない", () => {
  assert.equal(nonDeliveryCeiling(rec({ settled: 48 })), 100);
  assert.equal(nonDeliveryReason(rec({ settled: 48 })), null);
});

test("一度でも届いていれば、その後の不履行では天井を掛けない（正の枝が扱う）", () => {
  assert.equal(nonDeliveryCeiling(rec({ settled: 1, resolvedNonSettling: 99, nonSettlingDays: 9 })), 100);
});

test("照合待ちは失敗に数えない——我々の検証の遅れを売り手の落ち度にしない", () => {
  assert.equal(nonDeliveryCeiling(rec({ pendingVerification: 50 })), 100);
  assert.equal(nonDeliveryCeiling(rec({ resolvedNonSettling: 0, pendingVerification: 200 })), 100);
});

test("1日に集中した失敗では重い天井を掛けない（我々側の障害と区別できない）", () => {
  // 件数は重度の条件を満たすが、1日しかない
  const c = nonDeliveryCeiling(rec({ resolvedNonSettling: 100, nonSettlingDays: 1 }));
  assert.notEqual(c, L1_NONDELIVERY_SEVERE_CEILING, "1日の障害で BLOCK にしている");
  assert.equal(c, L1_NONDELIVERY_LIGHT_CEILING);
});

test("中度: 5件以上・2日以上", () => {
  assert.equal(
    nonDeliveryCeiling(rec({ resolvedNonSettling: 6, nonSettlingDays: 2 })),
    L1_NONDELIVERY_MODERATE_CEILING,
  );
  assert.equal(nonDeliveryReason(rec({ resolvedNonSettling: 6, nonSettlingDays: 2 })), "paid_never_settled_repeated");
});

test("軽度: 1〜4件は凹みであって断罪ではない", () => {
  for (const n of [1, 2, 3, 4]) {
    const c = nonDeliveryCeiling(rec({ resolvedNonSettling: n, nonSettlingDays: n }));
    assert.equal(c, L1_NONDELIVERY_LIGHT_CEILING, `${n}件で断罪している`);
    assert.ok(c > SCORE_THRESHOLDS.warn, "少数の失敗で BLOCK 帯へ落としている");
  }
});

test("記録が無い相手には天井を掛けない（未測定は中立）", () => {
  assert.equal(nonDeliveryCeiling(EMPTY_L1_SETTLEMENT_RECORD), 100);
  assert.equal(nonDeliveryReason(EMPTY_L1_SETTLEMENT_RECORD), null);
});

test("境界: 重度の条件は件数と日数の両方が要る", () => {
  assert.notEqual(nonDeliveryCeiling(rec({ resolvedNonSettling: 19, nonSettlingDays: 9 })), L1_NONDELIVERY_SEVERE_CEILING);
  assert.notEqual(nonDeliveryCeiling(rec({ resolvedNonSettling: 99, nonSettlingDays: 2 })), L1_NONDELIVERY_SEVERE_CEILING);
  assert.equal(nonDeliveryCeiling(rec({ resolvedNonSettling: 20, nonSettlingDays: 3 })), L1_NONDELIVERY_SEVERE_CEILING);
});

test("数える status は observatory の定義と割れていない", () => {
  // 定義が2箇所に割れるのは、このリポが繰り返してきた欠陥。
  const paid = new Set<string>(PAID_ATTEMPT_STATUSES as readonly string[]);
  for (const st of RESOLVED_NON_SETTLING_STATUSES) {
    assert.ok(paid.has(st), `${st} が PAID_ATTEMPT_STATUSES に無い——払っていない試行を数えている`);
  }
  assert.ok(paid.has("settled"), "settled が支払い済み集合から外れている");
  assert.ok(
    !(RESOLVED_NON_SETTLING_STATUSES as readonly string[]).includes("settle_claimed"),
    "照合待ちを失敗に数えている",
  );
});
