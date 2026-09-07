// ============================================================
// L1 inconclusive（2026-09-08・ETHOnline）。
//
// 欠陥: api.exa.ai（observatory 521e929e…）は /purchases で
//   attemptCount 10 / settledCount 10 / inconclusiveCount 10
// と出るのに、/facts は n_attempts 0 / n_settled 0 / n_probe_error 10、
// /decision は `l1_not_attempted`——同じ 10 行を 2 つの語彙で数え、
// 「金が 10 回動いた」相手を「未試行」と公開していた（2026-09-08 本番実測）。
//
// 単純に attempts へ数え直すと rules.ts の「n_attempts ≥ 3 ∧ n_delivered = 0 → BLOCK」で
// 我々のプローブ起因の 4xx が売り手の BLOCK になる（09-05 決定「n_probe_error を根拠に
// 売り手が悪いと読める語を作らない」に抵触）。だから:
//   - facts: n_attempts / n_settled は purchases と同じ集合。n_inconclusive を新設
//   - rules: conclusive = n_attempts − n_inconclusive。BLOCK / never_delivered は conclusive で読む。
//            試行はあるが結論が 1 件も無い相手は新語 `l1_inconclusive`（WARN・中立）
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleSellerFacts, type ProbeInput, type PurchaseInput } from "@/lib/decision/seller-facts";
import { decidePayer, DECISION_RULES_VERSION } from "@/lib/decision/rules";

const probes: ProbeInput[] = [
  { probedAt: "2026-09-07T00:00:00Z", verdict: "pass", dialect: "v2", failReason: null, priceAmount: "declared", priceAsset: null, payTo: "declared" },
  { probedAt: "2026-09-06T00:00:00Z", verdict: "pass", dialect: "v2", failReason: null, priceAmount: "declared", priceAsset: null, payTo: "declared" },
];

/** exa 型: settled・HTTP 400。金は動いた、応答は我々の要求の形で 4xx。 */
const inconclusiveRow = (i: number): PurchaseInput => ({
  attemptedAt: `2026-08-${String(10 + i).padStart(2, "0")}T12:00:00Z`,
  status: "settled",
  latencyMs: 200 + i,
  httpStatusPaid: 400,
  payloadNonEmpty: true,
  l2Schema: "not_checked",
  txHash: `0x${i.toString(16).padStart(4, "0")}`,
  network: "eip155:8453",
});
/** 結論のある未配達: settled・HTTP 500（売り手側の障害）。 */
const undeliveredRow = (i: number): PurchaseInput => ({ ...inconclusiveRow(i), httpStatusPaid: 500, payloadNonEmpty: false });
/** 配達: settled・200・非空。 */
const deliveredRow = (i: number): PurchaseInput => ({ ...inconclusiveRow(i), httpStatusPaid: 200, payloadNonEmpty: true, l2Schema: "match" });

const factsOf = (purchases: PurchaseInput[]) =>
  assembleSellerFacts({
    probes,
    purchases: [...purchases].sort((a, b) => (a.attemptedAt < b.attemptedAt ? 1 : -1)),
    settlements30d: { raw: purchases.length, real: 0, test: purchases.length, uniquePayersReal: 0 },
    payees: ["eip155:8453:0xb"],
    declaredSchema: null,
    lastAttemptAt: purchases[0]?.attemptedAt ?? null,
  });

test("版: 判定の意味が変わったので DECISION_RULES_VERSION を上げる", () => {
  assert.equal(DECISION_RULES_VERSION, "2026-09-08.1");
});

test("再現（exa 型・10 行 settled/4xx）: facts は purchases と同じ集合で数え、n_inconclusive 10 / n_delivered 0", () => {
  const f = factsOf(Array.from({ length: 10 }, (_, i) => inconclusiveRow(i)));
  assert.equal(f.l1.n_attempts, 10, "金が 10 回動いた相手を未試行と数えない");
  assert.equal(f.l1.n_settled, 10, "/purchases の settledCount と同じ");
  assert.equal(f.l1.n_inconclusive, 10);
  assert.equal(f.l1.n_probe_error, 10, "互換のため同値で残す");
  assert.equal(f.l1.n_delivered, 0);
  assert.equal(f.l1.observed_at, "2026-08-19T12:00:00Z", "払った事実があるので観測時刻が立つ");
  assert.equal(f.l1.last_purchase_id, "eip155:8453:0x0009", "決済のレシートは在る");
  assert.equal(f.l1.p50_ms, null, "4xx の往復は配達の遅延ではないので遅延の分母に入れない");
});

test("再現（exa 型）: /decision は WARN・l1_inconclusive。BLOCK でも l1_not_attempted でも l1_never_delivered でもない", () => {
  const d = decidePayer(factsOf(Array.from({ length: 10 }, (_, i) => inconclusiveRow(i))));
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_inconclusive"), d.reason_codes.join(","));
  assert.equal(d.reason_codes.includes("l1_not_attempted"), false);
  assert.equal(d.reason_codes.includes("l1_never_delivered"), false);
});

test("0x.org 型（1 行 settled/4xx）: l1_inconclusive・WARN", () => {
  const f = factsOf([inconclusiveRow(0)]);
  assert.deepEqual([f.l1.n_attempts, f.l1.n_settled, f.l1.n_inconclusive, f.l1.n_delivered], [1, 1, 1, 0]);
  const d = decidePayer(f);
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_inconclusive"));
});

test("結論のある未配達 3 件（settled/5xx）: 従来どおり BLOCK・l1_never_delivered", () => {
  const d = decidePayer(factsOf([undeliveredRow(0), undeliveredRow(1), undeliveredRow(2)]));
  assert.equal(d.recommendation, "BLOCK");
  assert.ok(d.reason_codes.includes("l1_never_delivered"));
});

test("結論 2 件＋inconclusive 8 件: conclusive は 2 なので BLOCK にならない（WARN・l1_never_delivered）", () => {
  const rows = [undeliveredRow(0), undeliveredRow(1), ...Array.from({ length: 8 }, (_, i) => inconclusiveRow(i + 2))];
  const f = factsOf(rows);
  assert.equal(f.l1.n_attempts, 10);
  assert.equal(f.l1.n_inconclusive, 8);
  const d = decidePayer(f);
  assert.equal(d.recommendation, "WARN", "我々の 4xx を売り手の未配達に足さない");
  assert.ok(d.reason_codes.includes("l1_never_delivered"));
  assert.equal(d.reason_codes.includes("l1_inconclusive"), false, "結論が 1 件でもあれば inconclusive の語は出さない");
});

test("配達 1 件＋inconclusive 9 件: ALLOW・l1_delivered（inconclusive は配達の反証ではない）", () => {
  const d = decidePayer(factsOf([deliveredRow(0), ...Array.from({ length: 9 }, (_, i) => inconclusiveRow(i + 1))]));
  assert.equal(d.recommendation, "ALLOW");
  assert.ok(d.reason_codes.includes("l1_delivered"));
});

test("試行 0: 従来どおり l1_not_attempted（inconclusive の語は出ない）", () => {
  const d = decidePayer(factsOf([]));
  assert.equal(d.recommendation, "WARN");
  assert.ok(d.reason_codes.includes("l1_not_attempted"));
  assert.equal(d.reason_codes.includes("l1_inconclusive"), false);
});

test("オプトイン（allowWithoutL1）は conclusive で読む: inconclusive だけの相手も L1 無しと同じく waived → ALLOW", () => {
  const d = decidePayer(factsOf([inconclusiveRow(0)]), { allowWithoutL1: true });
  assert.equal(d.recommendation, "ALLOW");
  assert.ok(d.reason_codes.includes("l1_waived_by_operator"));
  assert.ok(d.reason_codes.includes("l1_inconclusive"));
});
