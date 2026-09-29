// ============================================================
// 判定規則 2026-09-29.3（監査 6 周目・判定 API の重要度 高）と、理由コードの表の一致。
//
//   1. お金が動いていない失敗で BLOCK にしない。L1 の BLOCK は「お金が動いたのに届かなかった」2 回以上だけ
//      （weather.cyberwarex.com/forecast: 502・tx なし ×3、/sellers は 3 行とも not sorted: vet402 unproven で BLOCK だった）。
//      お金が動いていない失敗は /sellers の売り手の側（確定）だけ数える（WARN まで）。unproven・once は数えない。
//   2. l2_mismatch で欠けたキーの記録が無いものは l2_mismatch_unexplained・WARN（x402.twit.sh/users/following）。
//      L2 の evidence に mismatch_kind と content_type。
//   3. 理由コードの表（src/lib/decision/reason-codes.ts）＝ /docs/api#reason-codes ＝ openapi の DecisionReasonCode。
//      rules.ts が出しうる語は表に全部ある。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assembleSellerFacts,
  l1NotCountedOf,
  l1TimelineOf,
  l2EvidenceOf,
  l2ContentTypeOf,
  notCountedReasonOf,
  unpaidNotCountedReasonOf,
  type PurchaseInput,
  type SellerFactsInput,
  type SellerRowView,
} from "@/lib/decision/seller-facts";
import { decidePayer, decidePayee, DECISION_RULES_VERSION, L2_MISMATCH_UNEXPLAINED, type PayerOptions } from "@/lib/decision/rules";
import { REASON_CODES, FIXED_REASON_CODES, reasonCodeDocOf } from "@/lib/decision/reason-codes";
import type { BuyerFacts, SellerFacts } from "@/lib/decision/types";

const NOW = new Date("2026-09-29T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const PROBES = [
  { probedAt: daysAgo(0.1), verdict: "pass", dialect: "v2", failReason: null, priceAmount: "declared", priceAsset: null, payTo: "declared" },
  { probedAt: daysAgo(1), verdict: "pass", dialect: "v2", failReason: null, priceAmount: "declared", priceAsset: null, payTo: "declared" },
];
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
  requestMeta: { requestBody: "none" },
  ...over,
});
const UNPROVEN: SellerRowView = { bucket: "unsorted", modeKey: "funds_unproven", confirmedSeller: false };
const ONCE: SellerRowView = { bucket: "unsorted", modeKey: "server_error_paid_once", confirmedSeller: false };
const CONFIRMED: SellerRowView = { bucket: "seller", modeKey: "server_error_paid", confirmedSeller: true };
/** weather.cyberwarex.com 型: settle_failed・502・tx なし（お金が動いていない）。 */
const unpaid502 = (d: number, view: SellerRowView | null) => row(d, { status: "settle_failed", httpStatusPaid: 502, txHash: null, sellerView: view });
/** cnvrt.ing 型: settled・500（お金が動いた未配達）。/sellers の分類が unproven でも数える。 */
const paid500 = (d: number, view: SellerRowView | null = UNPROVEN) => row(d, { httpStatusPaid: 500, sellerView: view });

function inputOf(purchases: PurchaseInput[], declaredSchema: unknown = null): SellerFactsInput {
  const sorted = [...purchases].sort((a, b) => (a.attemptedAt < b.attemptedAt ? 1 : -1));
  return {
    probes: PROBES,
    purchases: sorted,
    settlements30d: { raw: 46, real: 46, test: 0, uniquePayersReal: 5 },
    payees: ["eip155:8453:0xb"],
    declaredSchema,
    method: "GET",
    declaredInput: null,
    lastAttemptAt: sorted[0]?.attemptedAt ?? null,
  };
}
function run(purchases: PurchaseInput[], declaredSchema: unknown = null) {
  const input = inputOf(purchases, declaredSchema);
  const facts = assembleSellerFacts(input);
  const options: PayerOptions = { l1NotCounted: l1NotCountedOf(input), l1Timeline: l1TimelineOf(input), now: NOW };
  return { input, facts, d: decidePayer(facts, options) };
}

test("版: 2026-09-29.3", () => assert.equal(DECISION_RULES_VERSION, "2026-09-29.3"));

// ------------------------------------------------------------------
// 1. お金が動いていない失敗
// ------------------------------------------------------------------
test("weather.cyberwarex.com 型: お金の動いていない 502 ×3（/sellers で vet402 unproven）は数えない → WARN・l1_inconclusive・l1_not_counted_unproven", () => {
  const { d, input } = run([unpaid502(2, UNPROVEN), unpaid502(9, UNPROVEN), unpaid502(17, UNPROVEN)]);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_inconclusive"), d.reason_codes.join(","));
  assert.ok(d.reason_codes.includes("l1_not_counted_unproven"));
  assert.ok(!d.reason_codes.includes("l1_never_delivered"));
  assert.deepEqual(l1NotCountedOf(input).by, { vet402_side: 0, held: 0, no_charge: 0, unproven: 3, unconfirmed: 0, settlement_unknown: 0 });
});

test("お金の動いていない失敗が /sellers で売り手の側（確定）でも、単独では BLOCK にしない（WARN・l1_never_delivered）", () => {
  const { d } = run([unpaid502(2, CONFIRMED), unpaid502(9, CONFIRMED), unpaid502(17, CONFIRMED), unpaid502(20, CONFIRMED)]);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_never_delivered"));
  assert.ok(!d.reason_codes.includes("l1_paid_not_delivered"));
});

test("売り手の側だが 1 日だけ（once）は数えない → l1_not_counted_unconfirmed", () => {
  const { d } = run([unpaid502(2, ONCE)]);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_not_counted_unconfirmed"));
  assert.ok(d.reason_codes.includes("l1_inconclusive"));
});

test("分類が読めない（sellerView なし）お金の動いていない失敗は数える側に倒すが、WARN まで", () => {
  const { d } = run([unpaid502(2, null), unpaid502(9, null), unpaid502(17, null)]);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_never_delivered"));
});

test("cnvrt.ing 型: お金が動いた未配達 2 回は /sellers の分類が unproven でも BLOCK のまま", () => {
  const { d } = run([paid500(13), paid500(28)]);
  assert.equal(d.recommendation, "BLOCK");
  assert.ok(d.reason_codes.includes("l1_paid_not_delivered"));
});

test("配達の後にお金の動いていない失敗（unproven）が最新でも l1_latest_failed にしない（数えない）", () => {
  const { d } = run([row(10, {}), unpaid502(1, UNPROVEN)]);
  assert.equal(d.recommendation, "ALLOW");
  assert.ok(!d.reason_codes.includes("l1_latest_failed"));
  const confirmed = run([row(10, {}), unpaid502(1, CONFIRMED)]).d;
  assert.equal(confirmed.recommendation, "WARN");
  assert.ok(confirmed.reason_codes.includes("l1_latest_failed"));
});

test("unpaidNotCountedReasonOf: /sellers の分類 → 判定の除外理由", () => {
  assert.equal(unpaidNotCountedReasonOf(null), null);
  assert.equal(unpaidNotCountedReasonOf(CONFIRMED), null);
  assert.equal(unpaidNotCountedReasonOf(ONCE), "unconfirmed");
  assert.equal(unpaidNotCountedReasonOf(UNPROVEN), "unproven");
  assert.equal(unpaidNotCountedReasonOf({ bucket: "unsorted", modeKey: "stopped_waiting", confirmedSeller: false }), "unproven");
  assert.equal(unpaidNotCountedReasonOf({ bucket: "unsorted", modeKey: "other", confirmedSeller: false }), "unproven");
  assert.equal(unpaidNotCountedReasonOf({ bucket: "vet402", modeKey: "payer_unfunded", confirmedSeller: false }), "vet402_side");
  assert.equal(unpaidNotCountedReasonOf({ bucket: "pending", modeKey: null, confirmedSeller: false }), "held");
  // お金が動いた行には当てない（paid の扱いは変えない）
  assert.equal(notCountedReasonOf(paid500(1, UNPROVEN), { method: "GET", declaredSchema: null }), null);
});

// ------------------------------------------------------------------
// 2. L2 の不一致の中身
// ------------------------------------------------------------------
const SCHEMA_REQ = { properties: { output: { properties: { example: { required: ["price"], properties: { price: {} } } } } } };
const l2 = (missing: string[], contentType = "application/json; charset=utf-8") =>
  row(1, { l2Schema: "mismatch", l2Detail: { missing, declarationHash: "d", responseHash: "r" }, contentType });

test("twit.sh 型: l2 mismatch で missing_keys が空 → WARN・l2_mismatch_unexplained、evidence は mismatch_kind unexplained と content_type", () => {
  const { d, facts, input } = run([l2([])], SCHEMA_REQ);
  assert.equal(facts.l2.status, "mismatch");
  assert.deepEqual(facts.l2.missing_keys, []);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l2_mismatch"));
  assert.ok(d.reason_codes.includes(L2_MISMATCH_UNEXPLAINED));
  const ev = l2EvidenceOf(facts, "obs", l2ContentTypeOf(input.purchases, facts));
  assert.equal(ev?.mismatch_kind, "unexplained");
  assert.equal(ev?.content_type, "application/json; charset=utf-8");
});

test("l2 mismatch で欠けたキーを記録 → BLOCK、evidence は mismatch_kind missing_keys", () => {
  const { d, facts, input } = run([l2(["price"])], SCHEMA_REQ);
  assert.equal(d.recommendation, "BLOCK");
  assert.ok(!d.reason_codes.includes(L2_MISMATCH_UNEXPLAINED));
  const ev = l2EvidenceOf(facts, "obs", l2ContentTypeOf(input.purchases, facts));
  assert.equal(ev?.mismatch_kind, "missing_keys");
  assert.deepEqual(ev?.missing_keys, ["price"]);
});

test("詳細の記録が無い旧行の mismatch（missing_keys null）も unexplained・WARN", () => {
  const { d } = run([row(1, { l2Schema: "mismatch", l2Detail: null })], SCHEMA_REQ);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes(L2_MISMATCH_UNEXPLAINED));
});

test("l2 が conform / undeclared の evidence には mismatch_kind・content_type を載せない", () => {
  const ok = run([row(1, { l2Schema: "match", l2Detail: { missing: [], declarationHash: "d", responseHash: "r" } })], SCHEMA_REQ);
  const ev = l2EvidenceOf(ok.facts, "obs", l2ContentTypeOf(ok.input.purchases, ok.facts));
  assert.equal(ok.facts.l2.status, "conform");
  assert.equal(ev && "mismatch_kind" in ev, false);
  assert.equal(ev && "content_type" in ev, false);
});

test("16,000 バイトの読み取り上限（docs と表の文）は l1-runner の実物と一致する", () => {
  const src = readFileSync("src/lib/observatory/l1-runner.ts", "utf8");
  assert.match(src, /paidBody = await readBodyCapped\(paid, 16_000\)/);
  const doc = REASON_CODES.find((r) => r.code === L2_MISMATCH_UNEXPLAINED)!;
  assert.match(doc.meaning, /16,000 bytes/);
});

// ------------------------------------------------------------------
// 3. 理由コードの表の一致（表 ＝ docs ＝ openapi、rules の出力 ⊂ 表）
// ------------------------------------------------------------------
test("openapi の DecisionReasonCode は表と同じ語（enum）とパターン", () => {
  // 依存を足さずに読む: components.schemas の DecisionReasonCode ブロックの enum と x-vet402-patterns の 1 行ずつ。
  const spec = readFileSync("docs/openapi.yaml", "utf8");
  const start = spec.indexOf("\n    DecisionReasonCode:\n");
  assert.ok(start > 0, "DecisionReasonCode が無い");
  const next = spec.slice(start + 1).search(/\n    [A-Za-z]/);
  const block = spec.slice(start, start + 1 + next);
  const enumLine = /\n      enum: \[([^\]]*)\]/.exec(block);
  const patLine = /\n      x-vet402-patterns: (\[.*\])/.exec(block);
  assert.ok(enumLine && patLine, "enum / x-vet402-patterns が読めない");
  const specEnum = enumLine[1].split(",").map((x) => x.trim()).filter(Boolean);
  assert.deepEqual([...specEnum].sort(), [...FIXED_REASON_CODES].sort());
  assert.deepEqual(
    (JSON.parse(patLine[1]) as string[]).sort(),
    REASON_CODES.filter((r) => r.pattern).map((r) => r.pattern!.source).sort(),
  );
  assert.equal(new Set(FIXED_REASON_CODES).size, FIXED_REASON_CODES.length, "語の重複");
});

test("/docs/api は表をそのまま描く（#verdicts と #reason-codes・旧スコア帯は #score-bands）", () => {
  const src = readFileSync("src/app/docs/api/page.tsx", "utf8");
  assert.match(src, /from "@\/lib\/decision\/reason-codes"/);
  assert.match(src, /REASON_CODES\.map\(/);
  assert.match(src, /<section id="verdicts"/);
  assert.match(src, /id="reason-codes"/);
  assert.match(src, /<section id="score-bands"/);
  assert.equal((src.match(/id="verdicts"/g) ?? []).length, 1);
  // 冒頭の認証の行（2026-09-29.3）: 判定と resolve は鍵不要
  assert.doesNotMatch(src, /Auth: <span className="text-signal">Bearer API key<\/span>/);
  assert.match(src, /TryItPanel\s+path="\/api\/v1\/resources\/[0-9a-f]{64}\/decision\?role=payer"/);
});

const SELLER_BASE: SellerFacts = {
  l0: { status: "pass", observed_at: daysAgo(0.1), dialect: "v2", fail_reason: null },
  l1: { n_delivered: 1, n_settled: 1, n_attempts: 1, n_inconclusive: 0, n_probe_error: 0, p50_ms: 1, p95_ms: 1, last_purchase_id: null, observed_at: daysAgo(1), last_attempt_at: daysAgo(1) },
  l2: { status: "undeclared", declaration_hash: null, response_hash: null, diff_hash: null, missing_keys: null, observed_at: null },
  availability_7d: 1,
  availability_30d: 1,
  offer_stability: "stable",
  payees: [],
  settlement_30d_real: 0,
  settlement_30d_raw: 0,
  settlement_30d_test: 0,
  unique_payers_30d_real: 0,
  wash_dominated: false,
};

test("rules.ts（payer）が出しうる語は全部、表にある", () => {
  const seen = new Set<string>();
  const l0s = ["pass", "fail", "unverified"] as const;
  const causes = [null, "single_fail", "tls", "not_probed", "request_shape"];
  const l1s: Partial<SellerFacts["l1"]>[] = [
    { n_attempts: 0, n_delivered: 0, n_settled: 0 },
    { n_attempts: 3, n_delivered: 0, n_settled: 0 },
    { n_attempts: 3, n_delivered: 0, n_settled: 3 },
    { n_attempts: 3, n_delivered: 1, n_settled: 1 },
  ];
  const l2s: SellerFacts["l2"][] = [
    SELLER_BASE.l2,
    { ...SELLER_BASE.l2, status: "conform" },
    { ...SELLER_BASE.l2, status: "mismatch", missing_keys: [] },
    { ...SELLER_BASE.l2, status: "mismatch", missing_keys: ["a"] },
  ];
  const nc = [undefined, { total: 3, by: { vet402_side: 1, held: 1, no_charge: 1, unproven: 1, unconfirmed: 1, settlement_unknown: 1 } }];
  for (const l0 of l0s)
    for (const cause of causes)
      for (const l1 of l1s)
        for (const l2v of l2s)
          for (const notCounted of nc)
            for (const extra of [
              {},
              { l0SingleFailContext: null },
              { allowWithoutL1: true, operatorBlacklist: true, dataDepth: "thin" as const, callerDialect: "v1" as const },
              { l1Timeline: { n_counted: 2, n_paid_undelivered: 1, n_paid_undelivered_since_delivery: 1, latest_counted: { at: daysAgo(1), delivered: false }, last_delivered_at: daysAgo(40), last_signed_attempt_at: daysAgo(40) } },
            ]) {
              const f: SellerFacts = {
                ...SELLER_BASE,
                l0: { ...SELLER_BASE.l0, status: l0 },
                l1: { ...SELLER_BASE.l1, ...l1 },
                l2: l2v,
                offer_stability: "drifting",
                wash_dominated: true,
              };
              const d = decidePayer(f, {
                l0UnverifiedCause: cause,
                l0SingleFailContext: { listing_active: true, latest_probe_at: daysAgo(0.1), previous_verdict: "pass" },
                l1NotCounted: notCounted,
                now: NOW,
                ...extra,
              });
              for (const c of d.reason_codes) seen.add(c);
              // 窓の外だけの署名（l1_stale）
              const stale = decidePayer({ ...f, l1: { ...f.l1, n_attempts: 0, n_delivered: 0 } }, { l1Timeline: { n_counted: 0, n_paid_undelivered: 0, n_paid_undelivered_since_delivery: 0, latest_counted: null, last_delivered_at: null, last_signed_attempt_at: daysAgo(40) }, now: NOW });
              for (const c of stale.reason_codes) seen.add(c);
            }
  const missing = [...seen].filter((c) => reasonCodeDocOf(c) === null);
  assert.deepEqual(missing, [], `表に無い語: ${missing.join(", ")}`);
  // 表の payer の語は、どれも実際に出る（死んだ行を載せない）。パターンは代表で確かめる。
  const payerFixed = REASON_CODES.filter((r) => !r.pattern && r.role !== "payee").map((r) => r.code);
  const neverSeen = payerFixed.filter((c) => !seen.has(c));
  assert.deepEqual(neverSeen, [], `表にあるが出ない語: ${neverSeen.join(", ")}`);
});

test("rules.ts（payee）が出しうる語は全部、表にある", () => {
  const base: BuyerFacts = {
    settled_count_30d: 12,
    unique_payees_30d: 4,
    retry_burst_rate: 0.05,
    sybil: { multi_agent_owner: false, shared_funder: false, cluster_id: null, unavailable: [] },
    erc8004: { agent_id: null, feedback_with_payment_proof_ratio: null },
    first_seen: "2026-07-01T00:00:00Z",
    last_seen: "2026-09-01T00:00:00Z",
  };
  const seen = new Set<string>();
  const variants: BuyerFacts[] = [
    base,
    { ...base, erc8004: { agent_id: "1", feedback_with_payment_proof_ratio: null } },
    { ...base, settled_count_30d: 1, first_seen: daysAgo(1), sybil: { ...base.sybil, shared_funder: true } },
    { ...base, sybil: { multi_agent_owner: true, shared_funder: true, cluster_id: "c", unavailable: ["settlements", "funder_index", "erc8004"] }, retry_burst_rate: 0.9 },
  ];
  for (const v of variants) for (const bl of [false, true]) for (const c of decidePayee(v, { now: NOW, operatorBlacklist: bl }).reason_codes) seen.add(c);
  const missing = [...seen].filter((c) => reasonCodeDocOf(c) === null);
  assert.deepEqual(missing, [], `表に無い語: ${missing.join(", ")}`);
  const payeeFixed = REASON_CODES.filter((r) => !r.pattern && r.role === "payee").map((r) => r.code);
  assert.deepEqual(payeeFixed.filter((c) => !seen.has(c)), []);
});

test("表の効果の語は判定と食い違わない（BLOCK の語は単独で BLOCK、WARN の語は BLOCK にしない）", () => {
  const ok = { ...SELLER_BASE };
  // l2_mismatch_unexplained は WARN（BLOCK ではない）
  const un = decidePayer({ ...ok, l2: { ...ok.l2, status: "mismatch", missing_keys: [] } }, { now: NOW });
  assert.equal(un.recommendation, "WARN");
  assert.equal(reasonCodeDocOf(L2_MISMATCH_UNEXPLAINED)?.effect, "WARN");
  // l1_never_delivered は WARN
  const nd = decidePayer({ ...ok, l1: { ...ok.l1, n_delivered: 0, n_settled: 0, n_attempts: 5 } }, { now: NOW });
  assert.equal(nd.recommendation, "WARN");
  assert.equal(reasonCodeDocOf("l1_never_delivered")?.effect, "WARN");
  // wash_dominated・l0_fail・operator_blacklist は BLOCK
  for (const [f, o, code] of [
    [{ ...ok, wash_dominated: true }, {}, "wash_dominated"],
    [{ ...ok, l0: { ...ok.l0, status: "fail" as const } }, {}, "l0_fail"],
    [ok, { operatorBlacklist: true }, "operator_blacklist"],
  ] as const) {
    assert.equal(decidePayer(f, { now: NOW, ...o }).recommendation, "BLOCK", code);
    assert.equal(reasonCodeDocOf(code)?.effect, "BLOCK");
  }
});
