// ============================================================
// XRPL の secondary accept（2026-09-18）——Base が先頭・XRPL の RLUSD accept が 2 番目以降の壁。
// Arc の lane accept 優先（レビュー C1/C3/N1）と同じ規律を、DB もネットワークも無しで固定する:
//   - レーンとして優先された候補だけ / payTo はカタログの raw_accepts が宣言した r アドレスと完全一致
//   - 宣言額の免除は「宣言 network の accept が壁にあり宣言どおり払える・別チェーン・宣言額が正の整数」のときだけ
//   - 免除された accept は min(3 × 宣言額, $1) 以下（"0.01" → 10000 units で比較）
//   - 免除されない accept は宣言額と units で一致しなければ price_mismatch
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { selectXrplSecondaryAccept } from "@/lib/observatory/xrpl402-payer";
import { BASE_USDC } from "@/lib/observatory/x402-payer";

const BASE_PAYTO = "0x1111111111111111111111111111111111111111";
const XRPL_PAYTO = "rMnHeutYALco8RYFVcmuU4BCgSzBpPEh32";
const OTHER_R = "rG31cLyErnqeVj2eomEjBZtq7PYaupGYzL";

const baseAccept = (over: Record<string, unknown> = {}) => ({
  scheme: "exact",
  network: "eip155:8453",
  asset: BASE_USDC,
  payTo: BASE_PAYTO,
  amount: "10000",
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
  ...over,
});
/** 実物の壁（theaslangroup）と同じ形。 */
const xrplAccept = (over: Record<string, unknown> = {}) => ({
  scheme: "exact",
  network: "xrpl:0",
  asset: "524C555344000000000000000000000000000000",
  extra: { issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", invoiceId: "9ACC8E92BFAA468E8E02F67F82FFBEDB", sourceTag: 804681468 },
  payTo: XRPL_PAYTO,
  amount: "0.01",
  maxTimeoutSeconds: 300,
  ...over,
});
const opts = (over: Partial<Parameters<typeof selectXrplSecondaryAccept>[1]> = {}) => ({
  declaredAmount: "10000",
  declaredNetwork: "eip155:8453",
  declaredPayTo: BASE_PAYTO,
  declaredXrplPayTos: [XRPL_PAYTO],
  lanePreferred: true,
  ...over,
});

test("Base 先頭 + XRPL 2 番目の壁: レーンとして優先された候補は XRPL の RLUSD accept を選ぶ（units 10000）", () => {
  const sel = selectXrplSecondaryAccept([baseAccept(), xrplAccept()], opts());
  assert.equal(sel.reason, null);
  assert.equal(sel.accept?.network, "xrpl:0");
  assert.equal(sel.accept && "amountUnits" in sel ? sel.amountUnits : null, 10_000n);
  // v1 スラグの宣言（base）も同じチェーンとして読む
  assert.equal(selectXrplSecondaryAccept([baseAccept(), xrplAccept()], opts({ declaredNetwork: "base" })).reason, null);
  // 大文字の "BASE"（カタログの生の表記）も chains.toCaip2 が同じチェーンに寄せる。免除が効くこと（"0.02" は宣言額と
  // 一致しないので、免除が効かなければ price_mismatch になる）を固定する（2026-09-18 レビュー S1）。
  assert.equal(selectXrplSecondaryAccept([baseAccept(), xrplAccept({ amount: "0.02" })], opts({ declaredNetwork: "BASE" })).reason, null);
});

test("レーンとして優先されていない候補は XRPL レールへ入れない", () => {
  const sel = selectXrplSecondaryAccept([baseAccept(), xrplAccept()], opts({ lanePreferred: false }));
  assert.equal(sel.accept, null);
  assert.equal(sel.reason, "no_eligible_accept");
});

test("payTo: カタログの raw_accepts が宣言した r アドレスと完全一致。宣言に無い r アドレス・宣言が空・大小違いは拒否", () => {
  assert.equal(selectXrplSecondaryAccept([baseAccept(), xrplAccept({ payTo: OTHER_R })], opts()).reason, "payto_mismatch");
  assert.equal(selectXrplSecondaryAccept([baseAccept(), xrplAccept()], opts({ declaredXrplPayTos: [] })).reason, "payto_mismatch");
  assert.equal(selectXrplSecondaryAccept([baseAccept(), xrplAccept()], opts({ declaredXrplPayTos: [XRPL_PAYTO.toLowerCase()] })).reason, "payto_mismatch");
  // カタログの pay_to（0x）は r アドレスとは比べない——宣言の r アドレスが合っていれば通る
  assert.equal(selectXrplSecondaryAccept([baseAccept(), xrplAccept()], opts({ declaredXrplPayTos: [OTHER_R, XRPL_PAYTO] })).reason, null);
});

test("相対上限: 免除された accept は min(3 × 宣言額, $1) 以下", () => {
  // 宣言 10000 → 上限 30000（"0.03"）
  assert.equal(selectXrplSecondaryAccept([baseAccept(), xrplAccept({ amount: "0.03" })], opts()).reason, null);
  assert.equal(selectXrplSecondaryAccept([baseAccept(), xrplAccept({ amount: "0.030001" })], opts()).reason, "over_cap");
  // 宣言 3000 の行に "0.01"（10000）は 3 倍超
  const cheap = selectXrplSecondaryAccept([baseAccept({ amount: "3000" }), xrplAccept()], opts({ declaredAmount: "3000" }));
  assert.equal(cheap.reason, "over_cap");
  // 絶対上限 $1: 宣言 900000 でも "1.5" は払わない
  const big = selectXrplSecondaryAccept([baseAccept({ amount: "900000" }), xrplAccept({ amount: "1.5" })], opts({ declaredAmount: "900000" }));
  assert.equal(big.reason, "over_cap");
  assert.equal(selectXrplSecondaryAccept([baseAccept({ amount: "900000" }), xrplAccept({ amount: "1" })], opts({ declaredAmount: "900000" })).reason, null);
});

test("宣言額の免除条件: 宣言 network の accept が壁に無い／宣言どおり払えない／宣言額が正の整数でないときは免除しない", () => {
  // 壁に Base の accept が無い → 免除なし → 宣言額と units で一致したときだけ通る
  assert.equal(selectXrplSecondaryAccept([xrplAccept()], opts()).reason, null, "0.01 = 10000 units は宣言額と一致");
  assert.equal(selectXrplSecondaryAccept([xrplAccept({ amount: "0.02" })], opts()).reason, "price_mismatch");
  // Base の accept はあるが宣言と違う額（壁が Base を値上げ）→ 宣言どおり払えない → 免除なし
  assert.equal(selectXrplSecondaryAccept([baseAccept({ amount: "20000" }), xrplAccept({ amount: "0.02" })], opts()).reason, "price_mismatch");
  // Base の accept の payTo が宣言と違う → 同じく免除なし
  assert.equal(
    selectXrplSecondaryAccept([baseAccept({ payTo: "0x2222222222222222222222222222222222222222" }), xrplAccept({ amount: "0.02" })], opts()).reason,
    "price_mismatch",
  );
  // 宣言額が正の整数として読めない（"0.01" / "0" / "1e4" / 負 / null）→ 免除なし、かつ一致もしない
  for (const declaredAmount of ["0.01", "0", "1e4", "-1", "abc", null]) {
    const sel = selectXrplSecondaryAccept([baseAccept({ amount: declaredAmount ?? "10000" }), xrplAccept()], opts({ declaredAmount }));
    assert.equal(sel.accept, null, String(declaredAmount));
    assert.equal(sel.reason, "price_mismatch", String(declaredAmount));
  }
  // カタログの pay_to が null の行では免除を開かない（レビュー W3）: 宣言額と units の一致だけで判定する
  assert.equal(selectXrplSecondaryAccept([baseAccept(), xrplAccept({ amount: "0.02" })], opts({ declaredPayTo: null })).reason, "price_mismatch");
  assert.equal(selectXrplSecondaryAccept([baseAccept(), xrplAccept()], opts({ declaredPayTo: null })).reason, null, "一致すれば通る");
  // 宣言 network が寄せられない表記（base-mainnet）→ 免除なし（一致すれば通る・一致しなければ断る）
  assert.equal(selectXrplSecondaryAccept([baseAccept(), xrplAccept({ amount: "0.02" })], opts({ declaredNetwork: "base-mainnet" })).reason, "price_mismatch");
  assert.equal(selectXrplSecondaryAccept([baseAccept(), xrplAccept()], opts({ declaredNetwork: "base-mainnet" })).reason, null);
  // 宣言 network が XRPL そのもの（主ネットワークの行）はこの経路の対象外——免除なし
  assert.equal(selectXrplSecondaryAccept([xrplAccept({ amount: "0.02" })], opts({ declaredNetwork: "xrpl:0" })).reason, "price_mismatch");
});

test("XRPL の accept の関門は主ネットワークの経路と同じ: XRP 建て・発行者違い・invoiceId 無し・network 表記違いは選ばない", () => {
  const cases: [Record<string, unknown>, string | null][] = [
    [{ asset: "XRP", amount: "10000" }, "asset_not_usd"],
    [{ extra: { issuer: OTHER_R, invoiceId: "x", sourceTag: 1 } }, "issuer_mismatch"],
    [{ extra: { issuer: "rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De", sourceTag: 1 } }, "unbuildable"],
    [{ network: "xrpl" }, null],
    [{ network: "xrpl:mainnet" }, null],
  ];
  for (const [over, detail] of cases) {
    const sel = selectXrplSecondaryAccept([baseAccept(), xrplAccept(over)], opts());
    assert.equal(sel.reason, "no_eligible_accept", JSON.stringify(over));
    assert.equal(sel.detail, detail, JSON.stringify(over));
  }
});
