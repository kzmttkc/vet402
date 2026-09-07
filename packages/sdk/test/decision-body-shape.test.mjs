// ============================================================
// /decision の**本文の形**を関門にする（2026-09-07 第三者監査 A1 / A4 / 追加1）。
//
// 監査が一次データで確かめた欠陥（HEAD 0ebec74・pay-or-refuse.ts :561-573, :633）:
//   A1   HTTP 200 で JSON `null` / `false` / `0` / `""` → `if (decision)` が偽になり
//        ALLOW 検査ごと飛び、既定 policy のまま **paid**（実測: 4 値とも signTypedData 1 回）
//   A4   HTTP 200 で本文が非 JSON → `{}` 扱い → requireVet402Allow:false ＋ subgraph の床だけなら
//        払い、決定行に `waived.recommendation: "undefined"` が残る
//   追加1 `degraded` が文字列 `"true"` でも払う（`=== true` の比較だけ）
//
// 規則: 判定本文は **非 null の plain object** でなければ読めなかったのと同じ（`evidence_unavailable`）。
// `degraded` は **boolean** でなければ止める側に倒す（型が違う＝測れたと言えない）。
// どれも 402 を取りに行く前・署名器へ触る前に止まる。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { payOrRefuse } from "../dist/index.js";

const PAYEE = "0x36038e1d712c5e39f35952164ec58ec2b96caee7";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RESOURCE = "https://kronossignals.com/api/v1/price/btc";
const b64 = (o) => btoa(JSON.stringify(o));
const okAccept = { scheme: "exact", network: "eip155:8453", amount: "20000", asset: USDC, payTo: PAYEE, extra: { assetTransferMethod: "eip3009" } };

function watchedAccount() {
  const accessed = [];
  const account = new Proxy(
    { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => "0xsig" },
    { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } },
  );
  return { account, signAccesses: () => accessed.filter((k) => k.startsWith("sign")) };
}

/**
 * /decision は `decisionResponse` をそのまま返し、売り手は 402 → 署名ヘッダ付きで 200 と答える。
 * `subgraphReceipts` を与えると The Graph の問い合わせにも答える（A4 の再現に要る）。
 */
function harness({ decisionResponse, subgraphReceipts = null }) {
  const calls = [];
  const paid = [];
  const fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/decision")) return decisionResponse;
    if (String(init?.body ?? "").includes("x402AddressSummaries")) {
      return {
        ok: true, status: 200, headers: new Map(),
        json: async () => ({ data: { x402AddressSummaries: [{ role: "RECIPIENT", totalPayments: String(subgraphReceipts) }], _meta: { block: { number: 50898704 }, deployment: "Qm" } } }),
      };
    }
    if (u.includes("kronos")) {
      const h = init?.headers ?? {};
      const raw = h["PAYMENT-SIGNATURE"] ?? h["payment-signature"];
      if (!raw) return { ok: false, status: 402, json: async () => ({}), headers: new Map([["payment-required", b64({ x402Version: 2, accepts: [okAccept] })]]) };
      paid.push(u);
      return { ok: true, status: 200, json: async () => ({ data: "ok" }), headers: new Map([["PAYMENT-RESPONSE", b64({ success: true, transaction: "0xtx", network: "eip155:8453" })]]) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }), headers: new Map() };
  };
  return { calls, paid, fetch, sellerCalls: () => calls.filter((u) => u.includes("kronos")) };
}

const base = { payee: PAYEE, resource: RESOURCE, amountUsd: 0.02 };
const ok200 = (body) => ({ ok: true, status: 200, json: async () => body, headers: new Map() });

// ---------- A1: object でない JSON ----------

for (const body of [null, false, 0, "", [], "ALLOW", 1]) {
  test(`S1 /decision が 200 で JSON ${JSON.stringify(body)}（object でない）→ evidence_unavailable・402 を取りに行かない・署名器に触らない`, async () => {
    const w = watchedAccount();
    const h = harness({ decisionResponse: ok200(body) });
    const r = await payOrRefuse({ ...base, account: w.account, fetch: h.fetch });
    assert.equal(r.status, "refused");
    assert.ok(r.decision.reason_codes.includes("evidence_unavailable"), r.decision.reason_codes.join(","));
    assert.equal(r.decision.verdict_source, "decision");
    assert.equal(r.decision.decision, null, "読めなかった本文を判定として記帳しない");
    assert.equal(h.sellerCalls().length, 0, "判定が読めていないのに 402 を取りに行っている");
    assert.deepEqual(w.signAccesses(), []);
  });
}

test("S1b 404 の本文が `{\"error\":\"not_found\"}` でない object 以外なら、カタログ外扱いにもせず evidence_unavailable", async () => {
  const w = watchedAccount();
  const h = harness({ decisionResponse: { ok: false, status: 404, json: async () => null, headers: new Map() } });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: h.fetch });
  assert.equal(r.status, "refused");
  assert.ok(r.decision.reason_codes.includes("evidence_unavailable"));
  assert.equal(r.decision.reason_codes.includes("resource_uncatalogued"), false, "null の 404 をカタログ外に化かさない");
  assert.deepEqual(w.signAccesses(), []);
});

// ---------- A4: 非 JSON の本文 ----------

const nonJson200 = { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); }, headers: new Map() };

test("S2 /decision が 200 で本文が JSON でない → evidence_unavailable（既定 policy）", async () => {
  const w = watchedAccount();
  const h = harness({ decisionResponse: nonJson200 });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: h.fetch });
  assert.equal(r.status, "refused");
  assert.ok(r.decision.reason_codes.includes("evidence_unavailable"));
  assert.equal(r.decision.decision, null);
  assert.equal(h.sellerCalls().length, 0);
  assert.deepEqual(w.signAccesses(), []);
});

test("S2b 非 JSON の本文は requireVet402Allow:false ＋ subgraph の床を満たしていても払わない（{} 扱いで waived.recommendation:\"undefined\" にしない）", async () => {
  const w = watchedAccount();
  const h = harness({ decisionResponse: nonJson200, subgraphReceipts: 259 });
  const r = await payOrRefuse({
    ...base, account: w.account, fetch: h.fetch,
    policy: { requireVet402Allow: false, evidence: { source: "subgraph", minSubgraphReceipts: 1, graphApiKey: "k".repeat(32) } },
  });
  assert.equal(r.status, "refused");
  assert.ok(r.decision.reason_codes.includes("evidence_unavailable"), r.decision.reason_codes.join(","));
  assert.equal(r.decision.policy_override, null, "免除は起きていない（免除する判定が存在しない）");
  assert.equal(h.paid.length, 0);
  assert.deepEqual(w.signAccesses(), []);
});

// ---------- 追加1: degraded の型 ----------

for (const degraded of ["true", "false", 1, 0, null, undefined, {}]) {
  test(`S3 degraded が boolean でない（${JSON.stringify(degraded) ?? "undefined"}）→ evidence_unavailable・署名器に触らない`, async () => {
    const w = watchedAccount();
    const body = {
      recommendation: "ALLOW", reason_codes: ["l0_pass", "l1_delivered"],
      facts: { l0: { status: "pass" }, l1: { n_delivered: 3, n_attempts: 3 } },
      evidence: [], rules_version: "2026-09-02.1",
    };
    if (degraded !== undefined) body.degraded = degraded;
    const h = harness({ decisionResponse: ok200(body) });
    const r = await payOrRefuse({ ...base, account: w.account, fetch: h.fetch });
    assert.equal(r.status, "refused");
    assert.ok(r.decision.reason_codes.includes("evidence_unavailable"), r.decision.reason_codes.join(","));
    assert.equal(h.sellerCalls().length, 0);
    assert.deepEqual(w.signAccesses(), []);
  });
}

test("S3b degraded: false（boolean）の ALLOW は従来どおり払う（ネガティブコントロール）", async () => {
  const w = watchedAccount();
  const h = harness({ decisionResponse: ok200({ recommendation: "ALLOW", reason_codes: ["l0_pass"], facts: {}, evidence: [], degraded: false, rules_version: "t" }) });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: h.fetch });
  assert.equal(r.status, "paid", r.decision.reason_codes.join(","));
  assert.equal(w.signAccesses().length, 1);
  assert.equal(h.paid.length, 1);
});
