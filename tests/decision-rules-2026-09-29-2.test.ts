// ============================================================
// 判定規則 2026-09-29.2（敵対的監査 4 周目・競合エンジニアの実測）。
//
//   1. 支払い済み・未配達（settled／tx の付いた settle_failed で、非空の 2xx が届かない）を強く数える:
//      最後の配達より後に 2 回以上 → BLOCK、1 回 → WARN（cnvrt.ing/api/analyze-image: settled・500 ×2 が WARN だった）
//   2. 数えた最新の試行が失敗なら ALLOW にしない（spark-solana: 1 回届いた後に最新が失敗で ALLOW だった）
//   3. 署名した試行が 30 日の窓の外だけ → l1_stale（api.sirenic.eu …/dirigeants が l1_not_attempted だった）
//   4. L0 は公開規則（2 回連続の fail で公表）にそろえる: 1 回の fail は WARN、2 回連続で BLOCK（agent402.tools）
//   5. l1_inconclusive の数は l1_basis.n_not_counted（surf.cascade.fyi: n_inconclusive 0 で l1_inconclusive）
//   6. 鮮度: ALLOW は最新の配達が 30 日以内のときだけ（それ以外は WARN・l1_stale）。30 日は配達済みの売り手の
//      買い直しの間隔で、窓（30 日）と同じ長さ——本番では窓から外れた配達は l1_stale（窓の外）として読まれる
// 2026-09-29.4（監査 7 周目）で意味を変えた点: 行の分類は classifySellerRow の 1 本（/sellers と同じ）。BLOCK は
// 売り手の側（確定）の「払ったのに届かない」2 回以上だけ（not sorted は WARN）。L0 の unverified は WARN・degraded。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assembleSellerFacts,
  l0UnverifiedCauseOf,
  l1NotCountedOf,
  l1TimelineOf,
  notCountedReasonOf,
  rowViewOf,
  type ProbeInput,
  type PurchaseInput,
  type SellerFactsInput,
  type SellerRowView,
} from "@/lib/decision/seller-facts";
import {
  decidePayer,
  l1BasisOf,
  DECISION_RULES_VERSION,
  L1_FRESH_DAYS,
  L1_PAID_UNDELIVERED_BLOCK,
  L1_WINDOW_DAYS,
  type PayerOptions,
} from "@/lib/decision/rules";
import { buildDecision, type DecisionSubject } from "@/lib/decision/decide";
import { BASE_USDC_ADDRESS, moneyOf } from "@/lib/sellers/fix-modes";

const NOW = new Date("2026-09-29T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

const pass = (d: number): ProbeInput => ({ probedAt: daysAgo(d), verdict: "pass", dialect: "v2", failReason: null, priceAmount: "declared", priceAsset: null, payTo: "declared" });
const fail = (d: number): ProbeInput => ({ ...pass(d), verdict: "fail", failReason: "no_402" });
const PROBES_OK = [pass(0.1), pass(1)];

let seq = 0;
const row = (d: number, over: Partial<PurchaseInput>): PurchaseInput => ({
  attemptedAt: daysAgo(d),
  status: "settled",
  latencyMs: 300,
  httpStatusPaid: 200,
  payloadNonEmpty: true,
  l2Schema: "no_declaration",
  txHash: `0x${(++seq).toString(16).padStart(64, "0")}`,
  network: "eip155:8453",
  requestMeta: {},
  ...over,
});
/** 配達（settled・200・非空）。 */
const delivered = (d: number) => row(d, {});
/** 支払い済み・未配達（cnvrt.ing 型: settled・HTTP 500）。 */
const paid500 = (d: number) => row(d, { httpStatusPaid: 500 });
/** 支払い済み・空の 200。 */
const paidEmpty200 = (d: number) => row(d, { payloadNonEmpty: false });
/** 決済されていない失敗（settle_failed・500・tx なし・資金切れ期間の外）。 */
const unpaid500 = (d: number) => row(d, { status: "settle_failed", httpStatusPaid: 500, txHash: null, payloadNonEmpty: false });
/** 判定保留（settled・400: 我々の要求の形で説明がつく）。 */
const held400 = (d: number) => row(d, { httpStatusPaid: 400 });
/** 課金なしで中身が届いた（delivered_no_receipt・tx なし・非空）＝ surf.cascade.fyi 型。 */
const noCharge = (d: number) => row(d, { status: "delivered_no_receipt", txHash: null });
/**
 * /sellers が売り手の側（確定）に置いた行（本番は readRecordSides の分類が sellerView に載る）。PurchaseInput だけの行は
 * 署名した条件（pay_to・asset）を持たないので、同じ分類関数でも not sorted（other）になる。
 */
const sellerSide = (p: PurchaseInput, modeKey = "server_error_paid"): PurchaseInput => {
  const v = rowViewOf(p, { method: "GET", declaredSchema: null }, NOW.getTime());
  const view: SellerRowView = { ...v, bucket: "seller", modeKey, held: null };
  return { ...p, sellerView: view };
};

type Setup = {
  probes?: ProbeInput[];
  purchases: PurchaseInput[];
  lastSignedAttemptAt?: string | null;
  lastDeliveredAt?: string | null;
  /** x402_endpoints.status（既定 active）。 */
  listing?: string;
};

function inputOf(s: Setup): SellerFactsInput {
  const purchases = [...s.purchases].sort((a, b) => (a.attemptedAt < b.attemptedAt ? 1 : -1));
  return {
    probes: s.probes ?? PROBES_OK,
    purchases,
    settlements30d: { raw: 0, real: 0, test: 0, uniquePayersReal: 0 },
    payees: ["eip155:8453:0xb"],
    declaredSchema: null,
    method: "GET",
    declaredInput: null,
    lastAttemptAt: purchases[0]?.attemptedAt ?? s.lastSignedAttemptAt ?? null,
    lastSignedAttemptAt: s.lastSignedAttemptAt ?? null,
    lastDeliveredAt: s.lastDeliveredAt ?? null,
  };
}

/** 本番（decide.ts）と同じ材料で判定する。 */
function run(s: Setup, extra: PayerOptions = {}) {
  const input = inputOf(s);
  const facts = assembleSellerFacts(input);
  const options: PayerOptions = {
    l1NotCounted: l1NotCountedOf(input, NOW.getTime()),
    l0UnverifiedCause: l0UnverifiedCauseOf(input.probes),
    l1Timeline: l1TimelineOf(input, NOW.getTime()),
    now: NOW,
    ...extra,
  };
  return { facts, options, d: decidePayer(facts, options), basis: l1BasisOf(facts, options) };
}

test("版: 2026-09-29.2 で上げ、2026-09-29.3・2026-09-29.4（売り手の側（確定）だけ BLOCK・unverified は WARN）でも上げた", () => {
  assert.equal(DECISION_RULES_VERSION, "2026-09-29.4");
  assert.equal(L1_PAID_UNDELIVERED_BLOCK, 2);
  assert.equal(L1_FRESH_DAYS, 30);
});

// ------------------------------------------------------------------
// 1. 支払い済み・未配達
// ------------------------------------------------------------------
test("支払い済み・未配達 1 回（売り手の側）→ WARN・l1_paid_not_delivered", () => {
  const { d, basis } = run({ purchases: [sellerSide(paid500(3))] });
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_paid_not_delivered"));
  assert.ok(d.reason_codes.includes("l1_never_delivered"));
  assert.equal(basis.n_paid_undelivered_since_last_delivery, 1);
  assert.equal(basis.n_paid_undelivered_seller_side_since_last_delivery, 1);
});

test("支払い済み・未配達 2 回が売り手の側（確定）→ BLOCK", () => {
  const { d, basis } = run({ purchases: [sellerSide(paid500(13)), sellerSide(paid500(28))] });
  assert.equal(d.recommendation, "BLOCK");
  assert.ok(d.reason_codes.includes("l1_paid_not_delivered"));
  assert.equal(basis.n_paid_undelivered, 2);
  assert.equal(basis.n_paid_undelivered_seller_side_since_last_delivery, 2);
});

test("2026-09-29.4 cnvrt.ing 型: 支払い済み・未配達 2 回でも /sellers が not sorted（誰の側か示せない）なら WARN", () => {
  const { d, basis } = run({ purchases: [paid500(13), paid500(28)] });
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_paid_not_delivered"));
  assert.ok(d.reason_codes.includes("l1_not_counted_unproven"));
  assert.equal(basis.n_paid_undelivered_since_last_delivery, 2);
  assert.equal(basis.n_paid_undelivered_seller_side_since_last_delivery, 0);
});

test("空の 200・202 Accepted（settled）は配達に数えない: お金は動いた未配達（WARN・not sorted）", () => {
  const accepted = row(2, { httpStatusPaid: 202 });
  const r = run({ purchases: [paidEmpty200(9), accepted] });
  assert.equal(r.facts.l1.n_delivered, 0);
  assert.equal(r.d.recommendation, "WARN");
  assert.equal(r.basis.n_paid_undelivered, 2);
  assert.equal(rowViewOf(accepted, { method: "GET", declaredSchema: null }, NOW.getTime()).modeKey, "accepted_not_delivered");
});

test("tx の付いた settle_failed は、決済の索引に在るか照合で settled になったときだけお金が動いた（moneyOf）", () => {
  const late = row(2, { status: "settle_failed", httpStatusPaid: 504, payloadNonEmpty: false, settlementConfirmed: true });
  assert.equal(moneyOf(late), "moved");
  // 売り手が success:false と一緒に返しただけの tx（索引に無い・未照合）は数えない
  assert.equal(moneyOf({ ...late, settlementConfirmed: false }), "unknown");
  assert.equal(moneyOf({ ...late, settlementConfirmed: null }), "unknown");
  assert.equal(moneyOf({ ...late, settlementConfirmed: undefined }), "unknown");
  assert.equal(run({ purchases: [sellerSide({ ...late, settlementConfirmed: false }), sellerSide(paid500(5))] }).d.recommendation, "WARN");
  assert.equal(moneyOf(unpaid500(2)), "unknown");
  assert.equal(run({ purchases: [sellerSide(late), sellerSide(paid500(5))] }).d.recommendation, "BLOCK");
});

test("決済されていない失敗 2 回は支払い済みではない → BLOCK にしない（WARN・l1_never_delivered）", () => {
  const { d, basis } = run({ purchases: [unpaid500(2), unpaid500(5)] });
  assert.equal(d.recommendation, "WARN");
  assert.equal(d.reason_codes.includes("l1_paid_not_delivered"), false);
  assert.equal(basis.n_paid_undelivered, 0);
});

test("未配達 2 回の後に配達があれば BLOCK にしない（その後に配達があった）", () => {
  const { d, basis } = run({ purchases: [delivered(1), sellerSide(paid500(5)), sellerSide(paid500(9))] });
  assert.notEqual(d.recommendation, "BLOCK");
  assert.equal(d.recommendation, "ALLOW");
  assert.equal(basis.n_paid_undelivered, 2);
  assert.equal(basis.n_paid_undelivered_since_last_delivery, 0);
});

test("配達の後に支払い済み・未配達 2 回（売り手の側）→ 配達があっても BLOCK", () => {
  const { d } = run({ purchases: [sellerSide(paid500(1)), sellerSide(paid500(3)), delivered(6)] });
  assert.equal(d.recommendation, "BLOCK");
  assert.ok(d.reason_codes.includes("l1_delivered"));
  assert.ok(d.reason_codes.includes("l1_paid_not_delivered"));
});

test("配達の後に支払い済み・未配達 1 回 → WARN（売り手の側なら l1_latest_failed も立つ）", () => {
  assert.equal(run({ purchases: [paid500(1), delivered(6)] }).d.recommendation, "WARN", "not sorted でも払ったのに届かなければ WARN");
  const { d } = run({ purchases: [sellerSide(paid500(1)), delivered(6)] });
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_paid_not_delivered"));
  assert.ok(d.reason_codes.includes("l1_latest_failed"));
});

test("除くのは vet402 の落ち度を示せる行・保留・課金なしだけ: settled・400 ×2（保留）は BLOCK にしない", () => {
  const { d, basis } = run({ purchases: [held400(2), held400(5)] });
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_inconclusive"));
  assert.equal(basis.n_paid_undelivered, 0);
});

test("vet402 の落ち度を示せる行（残高不足の期間の 502・後から tx が載った）は支払い済みでも数えない", () => {
  // seller-attribution.test.ts の payer_short の行に tx を付けたもの（支払いはチェーンに載った）。
  const short = {
    ...row(17, { status: "settle_failed", httpStatusPaid: 502, payloadNonEmpty: false, settlementConfirmed: true }),
    attemptedAt: "2026-09-12T18:02:18Z",
    requestMeta: { requestBody: true },
    amountUnits: "1000000",
    payer: "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670",
    payTo: `0x${"11".repeat(20)}`,
    asset: BASE_USDC_ADDRESS,
  } as PurchaseInput;
  const decl = { method: "POST", declaredSchema: null, declaredInput: { query: "empty", body: "empty" } };
  assert.equal(moneyOf(short), "moved");
  assert.equal(notCountedReasonOf(rowViewOf(short, decl, NOW.getTime()), short), "vet402_side");
  const base = inputOf({ purchases: [] });
  // 数える支払い済み・未配達（500）1 回と並べても、vet402 の側の行は足さない → 1 回＝WARN（2 回＝BLOCK にならない）。
  const two = { ...base, ...decl, purchases: [sellerSide(row(3, { httpStatusPaid: 500 })), short] };
  const t = l1TimelineOf(two, NOW.getTime());
  assert.equal(t.n_paid_undelivered, 1);
  const facts = assembleSellerFacts(two);
  const d = decidePayer(facts, { l1NotCounted: l1NotCountedOf(two, NOW.getTime()), l1Timeline: t, now: NOW });
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_not_counted_vet402_side"));
});

// ------------------------------------------------------------------
// 2. 最新の試行
// ------------------------------------------------------------------
test("30 日で 1 回届いても、数えた最新の試行（売り手の側）が失敗なら ALLOW にしない（spark-solana 型）", () => {
  const { d, basis } = run({ purchases: [sellerSide(unpaid500(0.5)), delivered(3)] });
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_latest_failed"));
  assert.equal(basis.latest_counted_delivered, false);
});

test("最新が保留（数えない行）で、その前が配達なら ALLOW（最新の『数えた』試行は配達）", () => {
  const { d, basis } = run({ purchases: [held400(0.5), delivered(3)] });
  assert.equal(d.recommendation, "ALLOW");
  assert.equal(basis.latest_counted_delivered, true);
  assert.equal(basis.n_not_counted, 1);
});

// ------------------------------------------------------------------
// 3. 窓の外（l1_stale と l1_not_attempted の区別）
// ------------------------------------------------------------------
test("署名した試行が 30 日の窓の外だけ → l1_stale（l1_not_attempted ではない）・WARN・not_attempted_reason は null", () => {
  const signedAt = daysAgo(35);
  const { d, basis, facts, options } = run({ purchases: [], lastSignedAttemptAt: signedAt });
  assert.equal(facts.l1.n_attempts, 0);
  assert.ok(d.reason_codes.includes("l1_stale"));
  assert.equal(d.reason_codes.includes("l1_not_attempted"), false);
  assert.equal(d.recommendation, "WARN");
  assert.equal(basis.last_signed_attempt_at, signedAt);
  const subject: DecisionSubject = { type: "resource", id: null, endpoint_id: "e", observatory_id: "00000000-0000-0000-0000-000000000001", canonical_url: "https://e.com/x", method: "GET" };
  const b = buildDecision({ role: "payer", subject, facts, options, score: null, registry: { status: "off", tx_hash: null }, notAttemptedReason: "no_eligible_accept", now: NOW });
  assert.equal(b.not_attempted_reason, null, "下位コードは l1_not_attempted のときだけ");
});

test("一度も署名していない → l1_not_attempted（従来どおり）", () => {
  const { d } = run({ purchases: [] });
  assert.ok(d.reason_codes.includes("l1_not_attempted"));
  assert.equal(d.reason_codes.includes("l1_stale"), false);
  assert.equal(d.recommendation, "WARN");
});

test("窓の外だけ + L0 unverified（not_probed）は WARN（2026-09-29.4・sirenic 型）・語は l1_stale", () => {
  const { d } = run({ probes: [], purchases: [], lastSignedAttemptAt: daysAgo(35) });
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l0_unverified_not_probed"));
  assert.ok(d.reason_codes.includes("l1_stale"));
});

// ------------------------------------------------------------------
// 4. L0 を公開規則にそろえる
// ------------------------------------------------------------------
const SUBJECT: DecisionSubject = { type: "resource", id: null, endpoint_id: "e", observatory_id: "00000000-0000-0000-0000-000000000001", canonical_url: "https://e.com/x", method: "GET" };
const build = (r: ReturnType<typeof run>) =>
  buildDecision({ role: "payer", subject: SUBJECT, facts: r.facts, options: r.options, score: null, registry: { status: "off", tx_hash: null }, now: NOW });
const hours = (h: number) => h / 24;

test("2026-09-29.4 L0: 1 回の fail は掲載・時刻・直前の判定を問わず WARN・degraded true（BLOCK は l0_fail だけ）", () => {
  for (const r of [
    run({ probes: [fail(hours(18)), pass(hours(36))], purchases: [delivered(1)] }),
    run({ probes: [fail(hours(18)), pass(hours(36))], purchases: [delivered(1)], listing: "delisted" }),
    run({ probes: [fail(hours(200)), pass(hours(240))], purchases: [delivered(1)] }),
    run({ probes: [fail(hours(6))], purchases: [delivered(1)] }),
  ]) {
    assert.equal(r.facts.l0.status, "unverified");
    assert.ok(r.d.reason_codes.includes("l0_unverified_single_fail"));
    assert.equal(r.d.reason_codes.includes("l0_unverified_single_fail_unconfirmed"), false, "消した語");
    assert.equal(r.d.recommendation, "WARN");
    assert.equal(build(r).degraded, true);
  }
});

test("L0 2 回連続の fail → l0_fail・BLOCK", () => {
  const r = run({ probes: [fail(0.1), fail(1), pass(2)], purchases: [delivered(1)] });
  assert.equal(r.facts.l0.status, "fail");
  assert.equal(r.d.recommendation, "BLOCK");
});

test("1 回の fail でも、売り手の側の支払い済み・未配達 2 回があれば BLOCK（agent402.tools 型の 2 回目）", () => {
  assert.equal(run({ probes: [fail(0.1), pass(1)], purchases: [sellerSide(paid500(1)), sellerSide(paid500(4))] }).d.recommendation, "BLOCK");
});

test("1 回の fail + 支払い済み・未配達 1 回 → WARN（agent402.tools 型）", () => {
  const { d } = run({ probes: [fail(0.1), pass(1)], purchases: [paid500(5)] });
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_paid_not_delivered"));
});

test("その他の unverified（tls・未プローブ・path_template）・原因なしの unverified は WARN・degraded（BLOCK にしない）", () => {
  const tls: ProbeInput = { ...pass(0.1), verdict: "unverified", failReason: "tls" };
  const r = run({ probes: [tls], purchases: [delivered(1)] });
  assert.equal(r.d.recommendation, "WARN");
  assert.ok(r.d.reason_codes.includes("l0_unverified_tls"));
  assert.equal(build(r).degraded, true);
  const noCause = decidePayer({ ...r.facts }, { ...r.options, l0UnverifiedCause: null });
  assert.equal(noCause.recommendation, "WARN");
  const pt: ProbeInput = { ...pass(0.1), verdict: "unverified", failReason: "path_template" };
  const p = run({ probes: [pt], purchases: [] });
  assert.equal(p.d.recommendation, "WARN");
  assert.ok(p.d.reason_codes.includes("l0_unverified_path_template"));
  const np = run({ probes: [], purchases: [] });
  assert.equal(np.d.recommendation, "WARN");
  assert.ok(np.d.reason_codes.includes("l0_unverified_not_probed"));
});

// ------------------------------------------------------------------
// 5. l1_inconclusive と数の定義
// ------------------------------------------------------------------
test("l1_inconclusive のとき l1_basis.n_not_counted = n_attempts（n_inconclusive は 0 でもよい: surf.cascade.fyi 型）", () => {
  const { d, basis, facts } = run({ purchases: [noCharge(9)] });
  assert.ok(d.reason_codes.includes("l1_inconclusive"));
  assert.equal(facts.l1.n_inconclusive, 0, "facts の n_inconclusive は /purchases と同じ保留の部分集合のまま");
  assert.equal(basis.n_not_counted, facts.l1.n_attempts);
  assert.equal(basis.n_counted, 0);
});

test("不変条件: l1_inconclusive ⇔ n_attempts > 0 ∧ n_not_counted = n_attempts ∧ 配達 0（組み合わせを総当たり）", () => {
  const kinds = [delivered, paid500, paidEmpty200, unpaid500, held400, noCharge];
  for (let a = 0; a < kinds.length; a++) {
    for (let b = 0; b < kinds.length; b++) {
      const { d, basis, facts } = run({ purchases: [kinds[a](2), kinds[b](6)] });
      const inc = d.reason_codes.includes("l1_inconclusive");
      assert.equal(inc, facts.l1.n_attempts > 0 && basis.n_not_counted === facts.l1.n_attempts && facts.l1.n_delivered === 0, `${a},${b}`);
      assert.ok(basis.n_not_counted >= facts.l1.n_inconclusive, "保留は必ず数えない側に入る");
      assert.equal(basis.n_counted + basis.n_not_counted, facts.l1.n_attempts);
      // BLOCK は売り手の側（確定）の支払い済み・未配達 2 以上のときだけ（ここの行は分類が not sorted なので BLOCK にならない）、
      // ALLOW は最新の数えた試行が配達のときだけ
      assert.equal(d.recommendation === "BLOCK", basis.n_paid_undelivered_seller_side_since_last_delivery >= 2, `${a},${b}`);
      if (basis.n_paid_undelivered_since_last_delivery >= 1) assert.notEqual(d.recommendation, "ALLOW", `${a},${b}`);
      if (d.recommendation === "ALLOW") assert.equal(basis.latest_counted_delivered, true, `${a},${b}`);
    }
  }
});

// ------------------------------------------------------------------
// 6. 鮮度
// ------------------------------------------------------------------
test("鮮度: 最新の配達が 30 日ちょうどなら ALLOW、30 日を超えたら WARN・l1_stale", () => {
  const ok = run({ purchases: [delivered(30)] });
  assert.equal(ok.d.recommendation, "ALLOW");
  assert.equal(ok.basis.days_since_last_delivery, 30);
  // 窓の中として渡された行でも、30 日を超えていれば ALLOW にしない（呼び手が窓で切らなかった場合の守り）。
  const stale = run({ purchases: [delivered(30.5)] });
  assert.equal(stale.d.recommendation, "WARN");
  assert.ok(stale.d.reason_codes.includes("l1_stale"));
  assert.ok(stale.d.reason_codes.includes("l1_delivered"));
});

test("鮮度と窓の関係: 上限（30 日）は窓（30 日）を超えない。窓から外れた配達は l1_stale（窓の外）で WARN", () => {
  assert.equal(L1_FRESH_DAYS, 30);
  assert.equal(L1_WINDOW_DAYS, 30);
  assert.ok(L1_FRESH_DAYS <= L1_WINDOW_DAYS, "鮮度の上限が窓より長いと、窓の外の配達で ALLOW を出す経路ができる");
  // 本番（loadSellerFacts）は 30 日の窓で行を読むので、30.5 日前の配達は purchases に来ない。全履歴の時刻だけが残る。
  const at = daysAgo(30.5);
  const { d, facts, basis } = run({ purchases: [], lastSignedAttemptAt: at, lastDeliveredAt: at });
  assert.equal(facts.l1.n_attempts, 0);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_stale"));
  assert.equal(d.reason_codes.includes("l1_not_attempted"), false);
  assert.equal(basis.last_delivered_at, at);
  assert.equal(basis.days_since_last_delivery, 30.5);
});

test("鮮度: allow_without_l1 は古い配達を免除する（l1_waived_by_operator）。失敗は免除しない", () => {
  const waived = run({ purchases: [delivered(31)] }, { allowWithoutL1: true });
  assert.equal(waived.d.recommendation, "ALLOW");
  assert.ok(waived.d.reason_codes.includes("l1_waived_by_operator"));
  // 窓の外だけ（本番の読み方）も同じく免除される
  const outside = run({ purchases: [], lastSignedAttemptAt: daysAgo(31), lastDeliveredAt: daysAgo(31) }, { allowWithoutL1: true });
  assert.equal(outside.d.recommendation, "ALLOW");
  assert.ok(outside.d.reason_codes.includes("l1_waived_by_operator"));
  const failed = run({ purchases: [sellerSide(unpaid500(1)), delivered(3)] }, { allowWithoutL1: true });
  assert.equal(failed.d.recommendation, "WARN");
  const paid2 = run({ purchases: [sellerSide(paid500(1)), sellerSide(paid500(2))] }, { allowWithoutL1: true });
  assert.equal(paid2.d.recommendation, "BLOCK");
});

test("l1_basis は ISO8601 UTC の時刻と経過日数を出す（Postgres の ::text をそのまま出さない）", () => {
  const input = inputOf({ purchases: [] });
  const t = l1TimelineOf({ ...input, purchases: [{ ...delivered(0), attemptedAt: "2026-09-26 00:00:00.123456+00" }] }, NOW.getTime());
  assert.equal(t.last_delivered_at, "2026-09-26T00:00:00.123Z");
  assert.equal(t.latest_counted?.at, "2026-09-26T00:00:00.123Z");
  const { basis } = run({ purchases: [delivered(3)] });
  assert.equal(basis.days_since_last_delivery, 3);
  assert.equal(basis.window_days, 30);
  assert.equal(basis.fresh_days, 30);
});

test("Postgres の ::text が UTC 以外（+09）でも同じ瞬間として数える（手元の DB で未配達を 0 と数えた不具合）", () => {
  const jst = (d: number) => {
    const t = new Date(NOW.getTime() - d * 86_400_000 + 9 * 3_600_000).toISOString();
    return `${t.slice(0, 10)} ${t.slice(11, 23)}+09`;
  };
  const rows = [sellerSide(row(3, { httpStatusPaid: 500, attemptedAt: jst(3) })), sellerSide(row(10, { httpStatusPaid: 500, attemptedAt: jst(10) }))];
  const r = run({ purchases: rows });
  assert.equal(r.basis.n_paid_undelivered_since_last_delivery, 2);
  assert.equal(r.d.recommendation, "BLOCK");
  const fresh = run({ purchases: [row(3, { attemptedAt: jst(3) })] });
  assert.equal(fresh.basis.days_since_last_delivery, 3);
  assert.equal(fresh.d.recommendation, "ALLOW");
});

test("l1Timeline を渡さない呼び手（旧フィクスチャ）は facts から保守的に: 最後に署名した時刻が古ければ ALLOW にしない", () => {
  const { facts } = run({ purchases: [delivered(31)] });
  assert.equal(decidePayer(facts, { now: NOW }).recommendation, "WARN");
  const edge = run({ purchases: [delivered(30)] });
  assert.equal(decidePayer(edge.facts, { now: NOW }).recommendation, "ALLOW");
  const fresh = run({ purchases: [delivered(2)] });
  assert.equal(decidePayer(fresh.facts, { now: NOW }).recommendation, "ALLOW");
});

// ------------------------------------------------------------------
// 本番経路と SDK
// ------------------------------------------------------------------
const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

test("本番経路（decide.ts）は l1Timeline を判定へ渡し、loadSellerFacts が作る", () => {
  const decide = read("src/lib/decision/decide.ts");
  assert.match(decide, /l1Timeline: loaded\.l1Timeline/);
  assert.match(decide, /l1_basis: l1BasisOf\(f, options\)/);
  const facts = read("src/lib/decision/seller-facts.ts");
  assert.match(facts, /l1Timeline: l1TimelineOf\(factsInput/);
});

test("SDK（凍結）は /decision の reason_codes を文字列のまま透過する（新しい語を落とさない）", () => {
  const sdk = read("packages/sdk/src/pay-or-refuse.ts");
  assert.match(sdk, /function serverReasonCodes\(words: string\[\]\): ServerReasonCode\[\] \{\s*return words as ServerReasonCode\[\];/);
  assert.match(sdk, /Array\.isArray\(decision\.reason_codes\) \? decision\.reason_codes : \[\]/);
  // 許可リストで語を絞っていない（l1_ の語をリテラルで持っていない）
  assert.equal(/"l1_(never_delivered|inconclusive|stale|paid_not_delivered|latest_failed)"/.test(sdk), false);
});
