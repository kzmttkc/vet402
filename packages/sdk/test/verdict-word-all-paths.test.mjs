// ============================================================
// 判定語が読めないときは、免除（requireVet402Allow: false）の下でも払わない（0.7.1）。
//
// 0.7.0 まで、判定語の検査（ALLOW・WARN・BLOCK のどれか）は名前（ENS）経路にしか無かった。
// 名前を使わない呼び手が `requireVet402Allow: false` と床を宣言していると、`recommendation` が
// 欠けている・知らない語の 200 を WARN と同じに読み、床だけで署名していた
// （`pay-or-refuse.ts` のコメントが 2026-09-25 に既知の穴として書いていたもの）。
//
// 見るのは3経路: `/decision`（0x の payee）・404 → 受取人スコア・Solana の payee。
// 既定（requireVet402Allow を書かない）の拒否理由は 0.7.0 のまま（`payee_recommendation_not_allow`）。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { payOrRefuse } from "../dist/index.js";
import { isUnknownVerdict } from "../dist/verdict-shape.js";

const DECISION = "/decision";
const SCORE = "/payees/";
const PAYEE = "0x36038e1d712c5e39f35952164ec58ec2b96caee7";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const base = { payee: PAYEE, resource: "https://kronossignals.com/api/v1/price/btc", amountUsd: 0.02 };
const b64 = (o) => btoa(JSON.stringify(o));
const okAccept = { scheme: "exact", network: "eip155:8453", amount: "20000", asset: BASE_USDC, payTo: PAYEE, extra: { assetTransferMethod: "eip3009" } };

/** 署名者への参照を全部記録する Proxy（pay-or-refuse.test.mjs の第1層と同じ）。 */
function watchedAccount() {
  const accessed = [];
  const account = new Proxy(
    { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => "0xsig" },
    { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } },
  );
  return { account, accessed, signAccesses: () => accessed.filter((k) => k.startsWith("sign")) };
}

/** `/decision`・受取人スコア・売り手（402 → 200）・attest を1本の fetch で。呼び出しは全部記録する。 */
function world({ decision, score }) {
  const calls = [];
  const paid = [];
  const fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    const answer = (r) => ({ ok: r.status < 400, status: r.status, json: async () => r.body, headers: new Map(Object.entries(r.headers ?? {})) });
    if (u.includes(DECISION)) return answer(decision);
    if (u.includes(SCORE)) return answer(score ?? { status: 500, body: {} });
    if (u.includes("gateway.thegraph.com")) {
      return answer({ status: 200, body: { data: { x402AddressSummaries: [{ role: "RECIPIENT", totalPayments: "253" }], _meta: { block: { number: 50890586 } } } } });
    }
    if (u.includes("payments/x402")) return answer({ status: 200, body: { ok: true } });
    if (u.includes("kronossignals")) {
      const h = init?.headers ?? {};
      if (!h["PAYMENT-SIGNATURE"]) return answer({ status: 402, body: {}, headers: { "payment-required": b64({ x402Version: 2, accepts: [okAccept] }) } });
      paid.push(u);
      return answer({ status: 200, body: { data: "ok" }, headers: { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0xtx", network: "eip155:8453" }) } });
    }
    throw new Error(`forbidden call: ${u}`);
  };
  return { fetch, calls, paid, count: (part) => calls.filter((u) => u.includes(part)).length };
}

const decisionBody = (over = {}) => ({
  subject: { type: "resource", id: "a".repeat(64) },
  role: "payer",
  recommendation: "ALLOW",
  reason_codes: ["l0_pass", "l1_delivered"],
  facts: { l0: { status: "pass" }, l1: { n_delivered: 3, n_attempts: 3 }, l2: { status: "undeclared" } },
  evidence: [],
  degraded: false,
  ...over,
});
const withoutWord = () => { const b = decisionBody(); delete b.recommendation; return b; };

/** 免除 ＋ 満たされる床（自社台帳の配達 3 件）。0.7.0 はこの policy で、判定語の無い 200 に署名していた。 */
const WAIVER = { requireVet402Allow: false, evidence: { minL1Deliveries: 3, source: "vet402" } };

const UNREADABLE_WORDS = [
  ["recommendation 欄が無い", withoutWord()],
  ["recommendation: null", decisionBody({ recommendation: null })],
  ['recommendation: ""', decisionBody({ recommendation: "" })],
  ['recommendation: "MAYBE"', decisionBody({ recommendation: "MAYBE" })],
  ['recommendation: "ALLOWED"', decisionBody({ recommendation: "ALLOWED" })],
  ["recommendation: 1（数）", decisionBody({ recommendation: 1 })],
  ["recommendation: {}（object）", decisionBody({ recommendation: {} })],
  ["recommendation: true", decisionBody({ recommendation: true })],
];

for (const [name, body] of UNREADABLE_WORDS) {
  test(`K1 名前なし＋免除＋床: /decision の ${name} → 拒否（evidence_unavailable）・署名者参照 0・402 も取らない`, async () => {
    const w = watchedAccount();
    const f = world({ decision: { status: 200, body } });
    const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: WAIVER });
    assert.equal(r.status, "refused", `払った: ${JSON.stringify(r.decision.reason_codes)}`);
    assert.equal(r.decision.reason_codes.includes("evidence_unavailable"), true, r.decision.reason_codes.join(","));
    assert.equal(r.decision.reason_codes.includes("allowed_by_caller_policy"), false);
    assert.equal(r.decision.policy_override, null, "免除して通した記録が無い");
    assert.equal(r.decision.verdict_source, "decision");
    assert.equal(r.signed, false);
    assert.equal(r.nonce, null);
    assert.deepEqual(w.accessed, [], "署名者のどのプロパティにも触っていない");
    assert.equal(f.count(DECISION), 1, "判定は1回引いている");
    assert.equal(f.count("kronossignals"), 0, "402 を取りに行っていない");
    assert.equal(f.paid.length, 0);
  });
}

test("K2 対照: 同じ policy で WARN は今までどおり払う（免除は読めた判定にだけ効く）", async () => {
  const w = watchedAccount();
  const f = world({ decision: { status: 200, body: decisionBody({ recommendation: "WARN", reason_codes: ["l1_not_attempted"] }) } });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: WAIVER });
  assert.equal(r.status, "paid", r.decision.reason_codes.join(","));
  assert.equal(r.decision.verdict_source, "caller_policy");
  assert.equal(r.decision.policy_override?.waived.recommendation, "WARN");
  assert.equal(w.signAccesses().length, 1);
});

for (const word of ["warn", " WARN ", "allow", " ALLOW "]) {
  test(`K2b 対照: 綴りの違う既知の語 ${JSON.stringify(word)} の扱いは 0.7.0 と同じ（ALLOW とは読まず、免除で通す）`, async () => {
    const w = watchedAccount();
    const f = world({ decision: { status: 200, body: decisionBody({ recommendation: word }) } });
    const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: WAIVER });
    assert.equal(r.status, "paid", r.decision.reason_codes.join(","));
    assert.equal(r.decision.verdict_source, "caller_policy", "ALLOW と読んだのではなく、呼び手の規則で通した");
    assert.equal(r.decision.policy_override?.waived.recommendation, word);
  });
}

for (const [name, body] of UNREADABLE_WORDS) {
  test(`K3 既定（requireVet402Allow を書かない）: /decision の ${name} → 0.7.0 と同じ語（payee_recommendation_not_allow）で拒否`, async () => {
    const w = watchedAccount();
    const f = world({ decision: { status: 200, body } });
    const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch });
    assert.equal(r.status, "refused");
    assert.deepEqual(r.decision.reason_codes, ["l0_pass", "l1_delivered", "payee_recommendation_not_allow"]);
    assert.deepEqual(w.accessed, []);
  });
}

// ---------- 404 → 受取人スコアの経路 ----------

const notFound = { status: 404, body: { error: "not_found" } };
const payeeScore = (over = {}) => ({
  status: 200,
  body: { payee: PAYEE, score: 69, recommendation: "WARN", dataDepth: "thin", degraded: false, signalsUnavailable: [], ...over },
});
const scoreWithoutWord = () => { const s = payeeScore(); delete s.body.recommendation; return s; };
/** カタログ外で満たせる床は subgraph（自社台帳の配達はカタログ外では 0 件）。 */
const WAIVER_SUBGRAPH = { requireVet402Allow: false, evidence: { source: "subgraph", minSubgraphReceipts: 1, graphApiKey: "graphkey" } };

for (const [name, score] of [
  ["recommendation 欄が無い", scoreWithoutWord()],
  ["recommendation: null", payeeScore({ recommendation: null })],
  ['recommendation: "MAYBE"', payeeScore({ recommendation: "MAYBE" })],
  ['recommendation: ""', payeeScore({ recommendation: "" })],
]) {
  test(`K4 カタログ外＋免除＋床: 受取人スコアの ${name} → 拒否（evidence_unavailable）・署名者参照 0`, async () => {
    const w = watchedAccount();
    const f = world({ decision: notFound, score });
    const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: WAIVER_SUBGRAPH });
    assert.equal(r.status, "refused", `払った: ${JSON.stringify(r.decision.reason_codes)}`);
    assert.deepEqual(r.decision.reason_codes, ["resource_uncatalogued", "evidence_unavailable"]);
    assert.equal(r.decision.verdict_source, "payee_score");
    assert.equal(r.decision.policy_override, null);
    assert.equal(f.count(SCORE), 1, "受取人スコアは引いたうえで拒んでいる");
    assert.deepEqual(w.accessed, []);
    assert.equal(f.paid.length, 0);
  });
}

test("K5 対照: カタログ外＋免除＋床で、受取人スコアが WARN なら今までどおり払う", async () => {
  const w = watchedAccount();
  const f = world({ decision: notFound, score: payeeScore() });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: WAIVER_SUBGRAPH });
  assert.equal(r.status, "paid", r.decision.reason_codes.join(","));
  assert.equal(r.decision.policy_override?.waived.source, "payee_score");
  assert.equal(w.signAccesses().length, 1);
});

test("K6 既定: カタログ外で受取人スコアに判定語が無い → 0.7.0 と同じ語（payee_recommendation_not_allow）で拒否", async () => {
  const w = watchedAccount();
  const f = world({ decision: notFound, score: scoreWithoutWord() });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch });
  assert.equal(r.status, "refused");
  assert.deepEqual(r.decision.reason_codes, ["resource_uncatalogued", "payee_recommendation_not_allow"]);
  assert.deepEqual(w.accessed, []);
});

// ---------- Solana の payee ----------

test("K7 Solana の payee＋免除＋床: 判定語の無い 200 → 拒否・署名者参照 0・RPC 0・402 も取らない", async () => {
  const kp = (n) => Keypair.fromSeed(new Uint8Array(32).fill(n));
  const accessed = [];
  const account = new Proxy(
    { address: kp(1).publicKey.toBase58(), signTransaction: async (tx) => tx },
    { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } },
  );
  const calls = [];
  const fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes(DECISION)) return { ok: true, status: 200, json: async () => withoutWord(), headers: new Map() };
    throw new Error(`forbidden call: ${u}`);
  };
  const r = await payOrRefuse({
    payee: kp(7).publicKey.toBase58(),
    resource: "https://sol-seller.example/api/v1/price/sol",
    amountUsd: 0.02,
    svm: { account, rpcUrl: "https://rpc.solana.example/" },
    fetch,
    policy: { requireVet402Allow: false, evidence: { minL1Deliveries: 1 } },
  });
  assert.equal(r.status, "refused");
  assert.equal(r.rail, "svm");
  assert.equal(r.decision.reason_codes.includes("evidence_unavailable"), true, r.decision.reason_codes.join(","));
  assert.deepEqual(accessed, [], "Solana の署名者に触っていない");
  assert.deepEqual(calls.filter((u) => !u.includes(DECISION)), [], "判定のほかには何も引いていない");
  assert.equal(r.svmTransaction, null);
});

// ---------- 共有の規則（verdict-shape）----------

test("K8 isUnknownVerdict: ALLOW・WARN・BLOCK は前後の空白と大小を畳んで読み、それ以外は全部「読めない」", () => {
  for (const known of ["ALLOW", "WARN", "BLOCK", "allow", " warn ", "\tBlock\n"]) {
    assert.equal(isUnknownVerdict(known), false, JSON.stringify(known));
  }
  for (const unknown of [undefined, null, "", " ", "MAYBE", "ALLOWED", "ALLOW WARN", 0, 1, true, false, {}, [], ["ALLOW"]]) {
    assert.equal(isUnknownVerdict(unknown), true, JSON.stringify(unknown));
  }
});
