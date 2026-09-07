// ============================================================
// 402 の `amount` の**形**を関門にする（2026-09-07 第三者監査 A6）。
//
// 監査（HEAD 0ebec74・pay-or-refuse.ts :870 / x402-pay.ts :302）: 金銭ゲートは `Number(accept.amount)`
// で比べ、署名は**生文字列**の `value` を EIP-3009 の uint256 に載せる。`"0x10"`（=16）、
// `"1e4"`（=10000）、`"20000.5"`、`" 20000 "` はどれも Number では上限内に見えて関門を通り、
// 署名には Number が読んだ額と違う文字列が入る。
//
// 規則: `amount` は `/^[0-9]+$/` に一致する文字列だけ受理する。それ以外は「いくら払うのか読めない」
// （`evidence_unavailable`・402 そのものが読めないときと同じ語）で**署名の前**に拒否する。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { payOrRefuse } from "../dist/index.js";

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

const base = { payee: PAYEE, resource: RESOURCE, amountUsd: 0.02 };

// Number() では全部 0.02 USD 以下に読める（＝旧関門を通る）が、uint256 の 10 進表記ではない。
for (const amount of ["0x10", "1e4", "20000.5", " 20000 ", "+20000", "20_000", "", "-1", "１２３"]) {
  test(`M1 402 の amount ${JSON.stringify(amount)} は 10 進の整数文字列でない → 署名前に拒否（evidence_unavailable）`, async () => {
    const w = watchedAccount();
    const h = harness(amount);
    const r = await payOrRefuse({ ...base, account: w.account, fetch: h.fetch });
    assert.equal(r.status, "refused", `status=${r.status} reasons=${r.decision.reason_codes.join(",")}`);
    assert.ok(r.decision.reason_codes.includes("evidence_unavailable"), r.decision.reason_codes.join(","));
    assert.equal(h.sellerCalls().length, 1, "402 は実際に読んだ上で落としている");
    assert.equal(h.paid.length, 0, "署名付きの再送は出ていない");
    assert.deepEqual(w.signAccesses(), []);
  });
}

test("M2 amount \"20000\"（10 進整数）は従来どおり払い、署名した value はその文字列そのもの（ネガティブコントロール）", async () => {
  const w = watchedAccount();
  const h = harness("20000");
  const r = await payOrRefuse({ ...base, account: w.account, fetch: h.fetch });
  assert.equal(r.status, "paid", r.decision.reason_codes.join(","));
  assert.equal(w.signAccesses().length, 1);
  assert.equal(h.paid.length, 1);
  assert.equal(h.paid[0].payload.authorization.value, "20000");
});
