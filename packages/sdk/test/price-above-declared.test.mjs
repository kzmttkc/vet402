// ============================================================
// 402 の金額を、呼び手が名乗った `amountUsd` と照合する（2026-09-07 第三者監査 A3）。
//
// 監査（HEAD 0ebec74・pay-or-refuse.ts :711, :862-873）: ファイル冒頭の注釈（:16）は「金額を照合」と
// 言うが、金銭ゲートが当てるのは `maxPerTxUsd` だけで、呼び手が `amountUsd: 0.01` と名乗っても
// 402 が $1 なら上限（既定 $1）内として **paid** になっていた。「これは 1 セントの買い物だ」という
// 呼び手の申告は、上限とは別の関門である。
//
// 規則: 402 の `amount`（USDC 6 桁）が `amountUsd` を超えたら署名の前に `price_above_declared` で拒否。
// 上限（`price_above_ceiling`）が先に当たるときはその語が先（既存の順序を変えない）。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { PAY_REFUSE_REASONS, payOrRefuse } from "../dist/index.js";

const PAYEE = "0x36038e1d712c5e39f35952164ec58ec2b96caee7";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RESOURCE = "https://kronossignals.com/api/v1/price/btc";
const b64 = (o) => btoa(JSON.stringify(o));
const accept = (amount) => ({ scheme: "exact", network: "eip155:8453", amount, asset: USDC, payTo: PAYEE, extra: { assetTransferMethod: "eip3009" } });
const decision = {
  recommendation: "ALLOW", reason_codes: ["l0_pass", "l1_delivered"],
  facts: { l0: { status: "pass" }, l1: { n_delivered: 3, n_attempts: 3 } },
  evidence: [], degraded: false, rules_version: "2026-09-02.1",
};

function watchedAccount() {
  const accessed = [];
  const account = new Proxy(
    { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => "0xsig" },
    { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } },
  );
  return { account, signAccesses: () => accessed.filter((k) => k.startsWith("sign")) };
}

function harness(amount) {
  const calls = [];
  const paid = [];
  const fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/decision")) return { ok: true, status: 200, json: async () => decision, headers: new Map() };
    if (u.includes("kronos")) {
      const h = init?.headers ?? {};
      const raw = h["PAYMENT-SIGNATURE"] ?? h["payment-signature"];
      if (!raw) return { ok: false, status: 402, json: async () => ({}), headers: new Map([["payment-required", b64({ x402Version: 2, accepts: [accept(amount)] })]]) };
      paid.push(JSON.parse(atob(raw)));
      return { ok: true, status: 200, json: async () => ({ data: "ok" }), headers: new Map([["PAYMENT-RESPONSE", b64({ success: true, transaction: "0xtx", network: "eip155:8453" })]]) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }), headers: new Map() };
  };
  return { calls, paid, fetch, sellerCalls: () => calls.filter((u) => u.includes("kronos")) };
}

const base = { payee: PAYEE, resource: RESOURCE };

test("P0 price_above_declared は PayRefuseReason の語彙にある", () => {
  assert.ok(PAY_REFUSE_REASONS.includes("price_above_declared"));
});

test("P1 amountUsd 0.01 で 402 が $1（上限の既定 $1 以内）→ 署名前に price_above_declared で拒否", async () => {
  const w = watchedAccount();
  const h = harness("1000000");
  const r = await payOrRefuse({ ...base, amountUsd: 0.01, account: w.account, fetch: h.fetch });
  assert.equal(r.status, "refused", `status=${r.status} reasons=${r.decision.reason_codes.join(",")}`);
  assert.ok(r.decision.reason_codes.includes("price_above_declared"), r.decision.reason_codes.join(","));
  assert.equal(r.decision.reason_codes.includes("price_above_ceiling"), false, "上限内なので上限の語は出ない");
  assert.equal(h.sellerCalls().length, 1, "402 は実際に読んだ上で落としている");
  assert.equal(h.paid.length, 0, "署名付きの再送は出ていない");
  assert.equal(r.challenge?.amount, "1000000", "何を提示されて拒否したかを残す");
  assert.deepEqual(w.signAccesses(), []);
});

test("P2 402 が名乗りより 1 単位（0.000001 USD）高いだけでも拒否（浮動小数で丸めて通さない）", async () => {
  const w = watchedAccount();
  const h = harness("20001");
  const r = await payOrRefuse({ ...base, amountUsd: 0.02, account: w.account, fetch: h.fetch });
  assert.equal(r.status, "refused");
  assert.ok(r.decision.reason_codes.includes("price_above_declared"));
  assert.deepEqual(w.signAccesses(), []);
});

test("P3 402 が名乗りとちょうど同額なら払う（境界値・ネガティブコントロール）", async () => {
  const w = watchedAccount();
  const h = harness("20000");
  const r = await payOrRefuse({ ...base, amountUsd: 0.02, account: w.account, fetch: h.fetch });
  assert.equal(r.status, "paid", r.decision.reason_codes.join(","));
  assert.equal(w.signAccesses().length, 1);
  assert.equal(h.paid[0].payload.authorization.value, "20000");
});

test("P4 402 が名乗りより安いのは通す（名乗りは上限であって固定額ではない）", async () => {
  const w = watchedAccount();
  const h = harness("10000");
  const r = await payOrRefuse({ ...base, amountUsd: 0.02, account: w.account, fetch: h.fetch });
  assert.equal(r.status, "paid", r.decision.reason_codes.join(","));
  assert.equal(h.paid[0].payload.authorization.value, "10000");
});

test("P5 上限も名乗りも超える 402 は price_above_ceiling が先（既存の順序を変えない）", async () => {
  const w = watchedAccount();
  const h = harness("1500000"); // $1.50 > 既定上限 $1 > 名乗り $0.02
  const r = await payOrRefuse({ ...base, amountUsd: 0.02, account: w.account, fetch: h.fetch });
  assert.equal(r.status, "refused");
  const i = r.decision.reason_codes.indexOf("price_above_ceiling");
  assert.ok(i >= 0, r.decision.reason_codes.join(","));
  assert.equal(r.decision.reason_codes.includes("price_above_declared"), false, "上限で落ちたときは上限の語だけ");
  assert.deepEqual(w.signAccesses(), []);
});

test("P6 カタログ外（/decision 404）でも同じ関門が効く", async () => {
  const w = watchedAccount();
  const h = harness("1000000");
  const fetch = async (url, init) => {
    if (String(url).includes("/decision")) return { ok: false, status: 404, json: async () => ({ error: "not_found" }), headers: new Map() };
    return h.fetch(url, init);
  };
  const r = await payOrRefuse({ ...base, amountUsd: 0.01, account: w.account, fetch });
  assert.equal(r.status, "refused");
  assert.ok(r.decision.reason_codes.includes("resource_uncatalogued"));
  assert.ok(r.decision.reason_codes.includes("price_above_declared"), r.decision.reason_codes.join(","));
  assert.equal(r.decision.verdict_source, "payee_score");
  assert.deepEqual(w.signAccesses(), []);
});
