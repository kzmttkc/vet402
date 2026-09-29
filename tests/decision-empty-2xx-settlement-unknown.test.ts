// ============================================================
// 判定規則 2026-09-29.3 — 独立レビューの警告 2（空の 2xx で、お金が動いたかどうか未確定の行）。
//
// 2026-09-29.3 は、お金が動いていない失敗を /sellers の売り手の側（確定）の行だけ数える。そのままだと
//   - 空の 2xx でレシートの無い行（/sellers: not sorted: no charge・answered_no_charge）
//   - 払う側の残高不足（payer_short）の期間の空の 2xx（/sellers: vet402 の側）
// が l1_not_counted_unproven / vet402_side として落ち、以前の独立レビューが入れた「空の 200 で抜け道を作らない」
// 守りが、遅延回収で決済が結び付くまで効かなかった（配達の後にこの行が続いても ALLOW、allow_without_l1 なら
// この行だけでも ALLOW）。
//
// 方針: この行は「お金が動いたかどうか未確定」（settlement_unknown）。失敗には数えないが WARN
// （l1_empty_2xx_settlement_unknown）で、確定するまで ALLOW に戻さない。BLOCK にするのは決済が結び付いて
// お金が動いたと確定したとき（l1_paid_not_delivered）だけ。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assembleSellerFacts,
  isEmpty2xxUnsettled,
  l1NotCountedOf,
  l1TimelineOf,
  notCountedReasonOf,
  type PurchaseInput,
  type SellerFactsInput,
  type SellerRowView,
} from "@/lib/decision/seller-facts";
import { decidePayer, L1_EMPTY_2XX_SETTLEMENT_UNKNOWN, type PayerOptions } from "@/lib/decision/rules";
import { reasonCodeDocOf } from "@/lib/decision/reason-codes";
import { BASE_USDC_ADDRESS } from "@/lib/sellers/fix-modes";

const NOW = new Date("2026-09-29T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const PROBES = [
  { probedAt: daysAgo(0.1), verdict: "pass", dialect: "v2", failReason: null, priceAmount: "declared", priceAsset: null, payTo: "declared" },
  { probedAt: daysAgo(1), verdict: "pass", dialect: "v2", failReason: null, priceAmount: "declared", priceAsset: null, payTo: "declared" },
];
let seq = 0;
const tx = () => `0x${(++seq).toString(16).padStart(64, "0")}`;
const row = (d: number, over: Partial<PurchaseInput>): PurchaseInput => ({
  attemptedAt: daysAgo(d),
  status: "settled",
  latencyMs: 300,
  httpStatusPaid: 200,
  payloadNonEmpty: true,
  l2Schema: "no_declaration",
  txHash: tx(),
  network: "eip155:8453",
  requestMeta: { requestBody: "none" },
  ...over,
});

/** /sellers が置く分類（board.ts の classifySellerRow）。 */
const NO_CHARGE_VIEW: SellerRowView = { bucket: "unsorted", modeKey: "answered_no_charge", confirmedSeller: false };
const PAYER_SHORT_VIEW: SellerRowView = { bucket: "vet402", modeKey: "payer_short", confirmedSeller: false };
const PENDING_VIEW: SellerRowView = { bucket: "pending", modeKey: null, confirmedSeller: false };
const CONFIRMED: SellerRowView = { bucket: "seller", modeKey: "no_receipt", confirmedSeller: true };

/** 空の 2xx・レシートなし・tx なし（遅延回収がまだ決済を結び付けていない）。 */
const empty200 = (d: number, view: SellerRowView | null = NO_CHARGE_VIEW, over: Partial<PurchaseInput> = {}) =>
  row(d, { status: "delivered_no_receipt", httpStatusPaid: 200, payloadNonEmpty: false, txHash: null, sellerView: view, ...over });
/** 払う側の残高不足の期間（seller-attribution.test.ts の payer_short の行）の空の 200。 */
const shortEmpty200 = (view: SellerRowView | null = PAYER_SHORT_VIEW): PurchaseInput =>
  ({
    ...row(17, { status: "settle_failed", httpStatusPaid: 200, payloadNonEmpty: false, txHash: null, sellerView: view }),
    attemptedAt: "2026-09-12T18:02:18Z",
    requestMeta: { requestBody: true },
    amountUnits: "1000000",
    payer: "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670",
    payTo: `0x${"11".repeat(20)}`,
    asset: BASE_USDC_ADDRESS,
  }) as PurchaseInput;
const SHORT_DECL = { method: "POST", declaredSchema: null, declaredInput: { query: "empty", body: "empty" } };

function inputOf(purchases: PurchaseInput[], decl: { method: string; declaredSchema: unknown; declaredInput: unknown } = { method: "GET", declaredSchema: null, declaredInput: null }): SellerFactsInput {
  const sorted = [...purchases].sort((a, b) => (a.attemptedAt < b.attemptedAt ? 1 : -1));
  return {
    probes: PROBES,
    purchases: sorted,
    settlements30d: { raw: 46, real: 46, test: 0, uniquePayersReal: 5 },
    payees: ["eip155:8453:0xb"],
    ...decl,
    lastAttemptAt: sorted[0]?.attemptedAt ?? null,
  };
}
function run(purchases: PurchaseInput[], extra: Partial<PayerOptions> = {}, decl?: Parameters<typeof inputOf>[1]) {
  const input = inputOf(purchases, decl);
  const facts = assembleSellerFacts(input);
  const options: PayerOptions = { l1NotCounted: l1NotCountedOf(input), l1Timeline: l1TimelineOf(input), now: NOW, ...extra };
  return { input, facts, d: decidePayer(facts, options), timeline: options.l1Timeline! };
}

test("表に l1_empty_2xx_settlement_unknown（WARN）がある", () => {
  assert.equal(L1_EMPTY_2XX_SETTLEMENT_UNKNOWN, "l1_empty_2xx_settlement_unknown");
  assert.equal(reasonCodeDocOf(L1_EMPTY_2XX_SETTLEMENT_UNKNOWN)?.effect, "WARN");
});

test("空の 2xx・レシートなしの行だけの売り手は ALLOW にならない（allow_without_l1 でも WARN）", () => {
  const rows = [empty200(2), empty200(9), empty200(17)];
  const { d, input } = run(rows);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes(L1_EMPTY_2XX_SETTLEMENT_UNKNOWN), d.reason_codes.join(","));
  assert.ok(d.reason_codes.includes("l1_inconclusive"), "失敗としては数えない");
  assert.ok(!d.reason_codes.includes("l1_not_counted_unproven"), "お金が動いていないとは言わない");
  assert.equal(l1NotCountedOf(input).by.settlement_unknown, 3);
  // 呼び手が L1 の証拠なしで ALLOW をオプトインしても、未確定の空の 2xx は免除しない
  const optIn = run(rows, { allowWithoutL1: true }).d;
  assert.equal(optIn.recommendation, "WARN");
  assert.ok(optIn.reason_codes.includes(L1_EMPTY_2XX_SETTLEMENT_UNKNOWN));
});

test("配達の後に空の 2xx・レシートなしが続けば WARN（ALLOW に戻さない）。配達より前の行だけなら ALLOW", () => {
  const after = run([row(10, {}), empty200(1)]);
  assert.equal(after.d.recommendation, "WARN");
  assert.ok(after.d.reason_codes.includes(L1_EMPTY_2XX_SETTLEMENT_UNKNOWN));
  assert.equal(after.timeline.n_settlement_unknown_since_delivery, 1);
  // 最後の配達より前の行は、決済が結び付いても l1_paid_not_delivered に数えないので、ここでも数えない
  const before = run([row(1, {}), empty200(10)]);
  assert.equal(before.d.recommendation, "ALLOW");
  assert.ok(!before.d.reason_codes.includes(L1_EMPTY_2XX_SETTLEMENT_UNKNOWN));
});

test("払う側の残高不足（payer_short）の期間の空の 200 も settlement_unknown（WARN）。502 なら従来どおり vet402 の側", () => {
  const p = shortEmpty200();
  assert.equal(notCountedReasonOf(p, SHORT_DECL), "settlement_unknown");
  const { d } = run([row(20, {}), p], { allowWithoutL1: true }, SHORT_DECL);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes(L1_EMPTY_2XX_SETTLEMENT_UNKNOWN));
  // 空の 2xx でなければ、残高不足は vet402 の側のまま（お金の動いていない 502）
  assert.equal(notCountedReasonOf({ ...p, httpStatusPaid: 502 }, SHORT_DECL), "vet402_side");
});

test("決済が結び付けば l1_paid_not_delivered として数える（照合待ちの間も ALLOW に戻さない）", () => {
  const delivered = row(20, {});
  // 1) レシートなし・tx なし → 未確定（WARN）
  const s1 = run([delivered, empty200(2), empty200(3)]).d;
  assert.equal(s1.recommendation, "WARN");
  assert.ok(s1.reason_codes.includes(L1_EMPTY_2XX_SETTLEMENT_UNKNOWN));
  assert.ok(!s1.reason_codes.includes("l1_paid_not_delivered"));
  // 2) 遅延回収が tx を結び付け、照合待ち（settle_claimed）→ 除外の理由は held のまま、判定は WARN のまま
  const claimed = (d: number) => empty200(d, PENDING_VIEW, { status: "settle_claimed", txHash: tx() });
  const s2run = run([delivered, claimed(2), claimed(3)]);
  assert.equal(s2run.d.recommendation, "WARN");
  assert.ok(s2run.d.reason_codes.includes(L1_EMPTY_2XX_SETTLEMENT_UNKNOWN));
  assert.equal(l1NotCountedOf(s2run.input).by.held, 2);
  // 3) 照合器がチェーンで確かめて settled → お金が動いた未配達。2 回で BLOCK、未確定の語は消える
  const settled = (d: number) => empty200(d, { bucket: "seller", modeKey: "no_receipt", confirmedSeller: false }, { status: "settled", txHash: tx() });
  const s3 = run([delivered, settled(2), settled(3)]).d;
  assert.equal(s3.recommendation, "BLOCK");
  assert.ok(s3.reason_codes.includes("l1_paid_not_delivered"));
  assert.ok(!s3.reason_codes.includes(L1_EMPTY_2XX_SETTLEMENT_UNKNOWN));
  // tx の付いた settle_failed も、照合で確かめられれば同じ（settlementConfirmed）
  const confirmedFailed = (d: number) => empty200(d, PENDING_VIEW, { status: "settle_failed", txHash: tx(), settlementConfirmed: true });
  const s3b = run([delivered, confirmedFailed(2)]).d;
  assert.equal(s3b.recommendation, "WARN");
  assert.ok(s3b.reason_codes.includes("l1_paid_not_delivered"));
  assert.ok(!s3b.reason_codes.includes(L1_EMPTY_2XX_SETTLEMENT_UNKNOWN));
  // 売り手が名指した tx がまだ確かめられていない（照合待ち）空の 2xx も未確定
  const named = empty200(2, PENDING_VIEW, { status: "settle_failed", txHash: tx(), settlementConfirmed: false });
  assert.equal(notCountedReasonOf(named, { method: "GET", declaredSchema: null }), "settlement_unknown");
});

test("未確定に入れない行: 中身の届いた 2xx・照合で反証された主張・/sellers で売り手の側（確定）・分類が読めない", () => {
  const decl = { method: "GET", declaredSchema: null };
  // 中身の届いた無料応答は従来どおり課金なし
  assert.equal(notCountedReasonOf(empty200(2, NO_CHARGE_VIEW, { payloadNonEmpty: true }), decl), "no_charge");
  // 反証された主張（売り手の名指した tx はチェーンに無かった）はお金が動いていないと確かめた行
  const refuted = empty200(2, { bucket: "unsorted", modeKey: "other", confirmedSeller: false }, { status: "settle_claim_refuted", txHash: tx() });
  assert.equal(isEmpty2xxUnsettled(refuted), false);
  assert.equal(notCountedReasonOf(refuted, decl), "unproven");
  // 売り手の側（確定）と、分類が読めない行は従来どおり数える（失敗・WARN まで）
  assert.equal(notCountedReasonOf(empty200(2, CONFIRMED), decl), null);
  assert.equal(notCountedReasonOf(empty200(2, null), decl), null);
  // お金の動いていない 502 は従来どおり unproven（空の 2xx ではない）
  assert.equal(notCountedReasonOf(row(2, { status: "settle_failed", httpStatusPaid: 502, txHash: null, sellerView: NO_CHARGE_VIEW }), decl), "unproven");
});

test("並びを渡さない呼び手（facts と除外の数だけ）でも、未確定の空の 2xx は ALLOW にしない", () => {
  const { facts, input } = run([row(10, {}), empty200(1)]);
  const d = decidePayer(facts, { l1NotCounted: l1NotCountedOf(input), now: NOW });
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes(L1_EMPTY_2XX_SETTLEMENT_UNKNOWN));
});

// 2026-09-29 判定のレビュー: 同時刻の行と、オプトインの語の食い違い。
test("最後の配達と同じ時刻の行は「配達より後」に数えない（空の 2xx も、払ったのに届かなかった行も）", () => {
  const at = daysAgo(3);
  const delivered = { ...row(3, {}), attemptedAt: at };
  const sameEmpty = { ...empty200(3), attemptedAt: at };
  const samePaid = { ...row(3, { httpStatusPaid: 500, payloadNonEmpty: false, sellerView: CONFIRMED }), attemptedAt: at };
  const same = run([delivered, sameEmpty, samePaid]);
  assert.equal(same.timeline.n_settlement_unknown_since_delivery, 0);
  assert.equal(same.timeline.n_paid_undelivered_since_delivery, 0);
  assert.ok(!same.d.reason_codes.includes(L1_EMPTY_2XX_SETTLEMENT_UNKNOWN));
  assert.ok(!same.d.reason_codes.includes("l1_paid_not_delivered"));
  // 1 ミリ秒でも後なら数える
  const later = new Date(Date.parse(at) + 1).toISOString();
  const after = run([delivered, { ...sameEmpty, attemptedAt: later }, { ...samePaid, attemptedAt: later }]);
  assert.equal(after.timeline.n_settlement_unknown_since_delivery, 1);
  assert.equal(after.timeline.n_paid_undelivered_since_delivery, 1);
  assert.equal(after.d.recommendation, "WARN");
});

test("allow_without_l1 と未確定の空の 2xx が重なったら l1_waived_by_operator を付けない（WARN と食い違わない）", () => {
  const held = run([empty200(2), empty200(9)], { allowWithoutL1: true }).d;
  assert.equal(held.recommendation, "WARN");
  assert.ok(held.reason_codes.includes(L1_EMPTY_2XX_SETTLEMENT_UNKNOWN));
  assert.ok(!held.reason_codes.includes("l1_waived_by_operator"), held.reason_codes.join(","));
  // 免除できる理由（L1 の証拠なし）だけなら従来どおり付いて ALLOW
  const none = run([], { allowWithoutL1: true }).d;
  assert.equal(none.recommendation, "ALLOW");
  assert.ok(none.reason_codes.includes("l1_waived_by_operator"));
});
