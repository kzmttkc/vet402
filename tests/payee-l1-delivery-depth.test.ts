// ============================================================
// vet402 2026-09-02 — 観測所自身の L1 配達確認は、受取実績の「深さ」に効く。
//
// 本番実測（2026-09-02、/payee/{address} と observed_purchases）:
//   0x36038e1d… vet402 が 65 回払い、65 回とも配達を確認（11 日にわたる）
//   0xfdb4b511… 46 回配達確認（7 日）、0x8c128f1e… 48 回（9 日）…
//   → 6 件全部が **69 / WARN / thin**。69 は PAYEE_THIN_SCORE_CEILING そのもの。
//
// 原因: l1DeliveryDepth が「買い手が 2 者以上」を要求していた。observed_purchases
// を書くのは信頼された観測所（settlement-verifier）だけで、買い手は常に vet402 の
// 測定ウォレット——つまり distinctBuyers は構造的に 1 で、この深さは誰にも与えられ
// ない。買い手の独立性を要求するのは、第三者が投函する x402_payments に対する
// sybil 防御であって、観測所が自分で払って自分で確かめた事実に掛ける規則ではない
// （売り手は vet402 の購入を偽造できないし、いつ買うかも vet402 が決める）。
//
// 置き換え: 深さは「配達確認の件数」と「異なる日の数」で決める。日数は売り手が
// 操作できない時間軸（vet402 の購入スケジュール）。件数だけで rich にはしない——
// 1 日に 65 回届けた相手と 11 日にわたり届けた相手は別物。
// 配達 0 件（払ったが届かない相手・未観測の相手）は従来どおり thin のまま。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { l1DeliveryDepth } from "@/lib/scoring/payee-engine";

test("観測所が 65 回・11 日にわたり配達を確認した payee は rich（買い手が観測所 1 者でも）", () => {
  assert.equal(l1DeliveryDepth({ deliveryCount: 65, uniqueDays: 11, distinctBuyers: 1 }), "rich");
});

test("10 回以上でも 7 日に満たなければ rich ではなく moderate（1 日の集中は継続実績ではない）", () => {
  assert.equal(l1DeliveryDepth({ deliveryCount: 12, uniqueDays: 3, distinctBuyers: 1 }), "moderate");
});

test("3 回・2 日で moderate（thin の天井 69 が外れる最小の実績）", () => {
  assert.equal(l1DeliveryDepth({ deliveryCount: 3, uniqueDays: 2, distinctBuyers: 1 }), "moderate");
});

test("3 回でも同じ 1 日なら thin（1 日の実績では深さを与えない）", () => {
  assert.equal(l1DeliveryDepth({ deliveryCount: 3, uniqueDays: 1, distinctBuyers: 1 }), "thin");
});

test("2 回・2 日は thin（件数の下限は 3）", () => {
  assert.equal(l1DeliveryDepth({ deliveryCount: 2, uniqueDays: 2, distinctBuyers: 1 }), "thin");
});

test("配達確認 0 件は thin——払ったのに届かない相手に深さは無い", () => {
  assert.equal(l1DeliveryDepth({ deliveryCount: 0, uniqueDays: 0, distinctBuyers: 0 }), "thin");
});
