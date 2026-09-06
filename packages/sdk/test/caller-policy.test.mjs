// ============================================================
// 呼び手の policy を `/decision` に渡し、サーバの policy 語を結果に載せる（ETHOnline 2026・
// WINDOW_PLAN §16.3 の穴・2026-09-07）。
//
// 固定するのは 3 つ:
//   1. `payOrRefuse` / `getDecision` は `amount_usd` / `max_per_tx_usd` / `min_l1_deliveries` を
//      クエリに載せる（サーバは SDK と同じ語で `caller_policy` を返す）
//   2. サーバの `caller_policy.reason_codes` は決定行の `reason_codes` に**そのまま**載る
//   3. ローカルの関門は残る（二重防御）。ローカルとサーバの語が食い違ったら**ローカルが status を決め**、
//      語は**両方**載せる。`policy_disagreement` のような新語は作らない
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { createVouchClient, payOrRefuse, DEFAULT_MAX_PER_TX_USD } from "../dist/index.js";

const RID = "a".repeat(64);
const PAYEE = "0x36038e1d712c5e39f35952164ec58ec2b96caee7";
const RESOURCE = "https://kronossignals.com/api/v1/price/btc";
const b64 = (o) => btoa(JSON.stringify(o));
const okAccept = { scheme: "exact", network: "eip155:8453", amount: "20000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAYEE, extra: { assetTransferMethod: "eip3009" } };

function account() {
  const accessed = [];
  const acc = new Proxy(
    { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => "0xsig" },
    { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } },
  );
  return { account: acc, signAccesses: () => accessed.filter((k) => k.startsWith("sign")) };
}

const decision = (over = {}) => ({
  subject: { type: "resource", id: RID },
  role: "payer",
  recommendation: "ALLOW",
  reason_codes: ["l0_pass", "l1_delivered"],
  facts: { l0: { status: "pass" }, l1: { n_delivered: 3, n_attempts: 3 }, l2: { status: "undeclared" } },
  evidence: [{ level: "L1", source: "vet402", purchase_id: "eip155:8453:0xabc", url: "https://vet402.com/observatory/e/x" }],
  degraded: false,
  policy: "allow_only",
  rules_version: "2026-09-02.1",
  ...over,
});

/** 判定＋売り手（402 → 署名ヘッダ付きで 200）＋attest を全部答える fetch。呼び先を記録する。 */
function harness(decisionBody) {
  const calls = [];
  const fetchFn = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/decision")) return { ok: true, status: 200, json: async () => decisionBody, headers: new Map() };
    if (u.includes("kronos")) {
      const h = init?.headers ?? {};
      const raw = h["PAYMENT-SIGNATURE"] ?? h["payment-signature"];
      if (!raw) return { ok: false, status: 402, json: async () => ({}), headers: new Map([["payment-required", b64({ x402Version: 2, accepts: [okAccept] })]]) };
      return { ok: true, status: 200, json: async () => ({ data: "ok" }), headers: new Map([["PAYMENT-RESPONSE", b64({ success: true, transaction: "0xtx", network: "eip155:8453", payer: "0xDB62BD202914609830fA656F87996b91be3Aa673" })]]) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }), headers: new Map() };
  };
  return { calls, fetchFn, decisionUrl: () => new URL(calls.find((u) => u.includes("/decision"))) };
}

test("Q1 payOrRefuse は amount_usd / max_per_tx_usd をクエリに載せる（max は既定 $1 でも明示して送る）", async () => {
  const h = harness(decision());
  const r = await payOrRefuse({ payee: PAYEE, resource: RESOURCE, amountUsd: 0.02, account: account().account, fetch: h.fetchFn, resourceId: RID });
  assert.equal(r.status, "paid", JSON.stringify(r.decision.reason_codes));
  const q = h.decisionUrl().searchParams;
  assert.equal(q.get("role"), "payer");
  assert.equal(q.get("amount_usd"), "0.02");
  assert.equal(q.get("max_per_tx_usd"), String(DEFAULT_MAX_PER_TX_USD));
  assert.equal(q.get("min_l1_deliveries"), null, "床を宣言していないのに床を送らない");
});

test("Q2 evidence.minL1Deliveries（source vet402）を宣言すると min_l1_deliveries が載る", async () => {
  const h = harness(decision());
  await payOrRefuse({ payee: PAYEE, resource: RESOURCE, amountUsd: 0.02, account: account().account, fetch: h.fetchFn, resourceId: RID, policy: { maxPerTxUsd: 0.5, evidence: { minL1Deliveries: 2, source: "vet402" } } });
  const q = h.decisionUrl().searchParams;
  assert.equal(q.get("min_l1_deliveries"), "2");
  assert.equal(q.get("max_per_tx_usd"), "0.5");
});

test("Q3 サーバの caller_policy.reason_codes は決定行の reason_codes にそのまま載る（拒否経路・ローカルの語と併記）", async () => {
  // サーバは（契約上ありえない組み合わせだが）上限超えと言い、ローカルは上限内で通し WARN で止める。
  const h = harness(decision({ recommendation: "WARN", reason_codes: ["l1_not_attempted"], caller_policy: { applied: { amount_usd: 0.02, max_per_tx_usd: 1, min_l1_deliveries: 0 }, verdict: "REFUSE", reason_codes: ["price_above_ceiling"], not_evaluated: ["min_subgraph_receipts"] } }));
  const w = account();
  const r = await payOrRefuse({ payee: PAYEE, resource: RESOURCE, amountUsd: 0.02, account: w.account, fetch: h.fetchFn, resourceId: RID });
  assert.equal(r.status, "refused");
  assert.ok(r.decision.reason_codes.includes("payee_recommendation_not_allow"), "ローカルの関門の語");
  assert.ok(r.decision.reason_codes.includes("price_above_ceiling"), "サーバの policy 語がそのまま載る");
  assert.ok(r.decision.reason_codes.includes("l1_not_attempted"), "サーバの reason_codes も従来どおり");
  assert.equal(r.decision.reason_codes.some((c) => /disagree/.test(c)), false, "新語を作らない");
  assert.deepEqual(w.signAccesses(), []);
});

test("Q4 食い違い: サーバ policy は REFUSE、ローカルの関門は通る → ローカルが status を決め（paid）、サーバの語も残る", async () => {
  const h = harness(decision({ caller_policy: { applied: { amount_usd: 0.02, max_per_tx_usd: 1, min_l1_deliveries: 5 }, verdict: "REFUSE", reason_codes: ["insufficient_delivery_evidence"], not_evaluated: ["min_subgraph_receipts"] } }));
  const w = account();
  const r = await payOrRefuse({ payee: PAYEE, resource: RESOURCE, amountUsd: 0.02, account: w.account, fetch: h.fetchFn, resourceId: RID });
  assert.equal(r.status, "paid", "ローカルには床が無いので通る（ローカル優先）");
  assert.ok(r.decision.reason_codes.includes("insufficient_delivery_evidence"), "サーバの語を隠さない");
  assert.equal(w.signAccesses().length, 1);
  assert.equal(r.decision.decision.caller_policy.verdict, "REFUSE", "サーバの応答は decision にそのまま残る");
});

test("Q5 両者が同じ語で一致したら 1 回だけ（重複させない・順序はローカルが先）", async () => {
  const h = harness(decision({ caller_policy: { applied: { amount_usd: 0.02, max_per_tx_usd: 1, min_l1_deliveries: 5 }, verdict: "REFUSE", reason_codes: ["insufficient_delivery_evidence"], not_evaluated: ["min_subgraph_receipts"] } }));
  const r = await payOrRefuse({ payee: PAYEE, resource: RESOURCE, amountUsd: 0.02, account: account().account, fetch: h.fetchFn, resourceId: RID, policy: { evidence: { minL1Deliveries: 5, source: "vet402" } } });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.filter((c) => c === "insufficient_delivery_evidence").length, 1);
});

test("Q6 getDecision も同じ 3 つをクエリに載せる", async () => {
  const calls = [];
  const fetchFn = async (url) => { calls.push(url); return new Response(JSON.stringify(decision()), { status: 200, headers: { "content-type": "application/json" } }); };
  const vouch = createVouchClient({ fetch: fetchFn });
  await vouch.getDecision(RID, { amountUsd: 1.5, maxPerTxUsd: 1, minL1Deliveries: 3 });
  const q = new URL(calls[0]).searchParams;
  assert.equal(q.get("amount_usd"), "1.5");
  assert.equal(q.get("max_per_tx_usd"), "1");
  assert.equal(q.get("min_l1_deliveries"), "3");
  // 書かなければ送らない（クエリ無しの応答は従来と同一、という契約を壊さない）
  await vouch.getDecision(RID);
  assert.equal(new URL(calls[1]).searchParams.has("amount_usd"), false);
});
