// ============================================================
// E4「届いてから確定」第1波の Must（9a）を、x402 公式 scheme `auth-capture`（delegated・escrow・sync）で固定する。
// CI で走る層。チェーンも anvil も使わない（売り手・vet402 の API・エスクローの読みは全部この中の偽物）。
// 実チェーンの同じ条件は test/integration/e4-auth-capture-anvil.test.mjs（anvil のある手元だけ）。
//
// 一次: x402-foundation/x402 d3eb19d0 specs/schemes/auth-capture/scheme_auth_capture.md L1・L27・L36、
//       scheme_auth_capture_evm.md L15・L35-41・L140-145・L369-378。
// 合格の文: ~/Takeshi_Automation/output/1110/factory/specs_3.7_3.8_9a_3.4.md の 9a（11/11 の E4_LOCK で scheme を替えた）。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";

const sdk = await import("../dist/index.js");
const { payOrRefuse, reclaimAuthCapture } = sdk;

const BUYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // Anvil の捨てアドレス（鍵はこの試験では使わない）
const SELLER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const OPERATOR = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const AUTHORIZER = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ESCROW = "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c";
const COLLECTOR = "0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88";
const RESOURCE = "https://seller.test/api/answer";
const CAPTURE_TX = "0x" + "c".repeat(64);
const VOID_TX = "0x" + "d".repeat(64);
const SIG = "0x" + "11".repeat(65);

const b64 = (o) => btoa(JSON.stringify(o));
const now = () => Math.floor(Date.now() / 1000);

function acAccept(over = {}, extraOver = {}) {
  const t = now();
  return {
    scheme: "auth-capture",
    network: "eip155:84532",
    amount: "10000",
    asset: SEPOLIA_USDC,
    payTo: SELLER,
    maxTimeoutSeconds: 60,
    extra: {
      name: "USDC",
      version: "2",
      authCaptureEscrow: ESCROW,
      captureAuthorizer: OPERATOR,
      operatorType: "delegated",
      receiverAuthorizer: AUTHORIZER,
      paymentFlow: "escrow",
      captureDeadline: t + 1200,
      refundDeadline: t + 2400,
      minFeeBps: 0,
      maxFeeBps: 0,
      feeRecipient: "0x0000000000000000000000000000000000000000",
      assetTransferMethod: "eip3009",
      ...extraOver,
    },
    ...over,
  };
}
const exactAccept = (over = {}) => ({
  scheme: "exact", network: "eip155:84532", amount: "10000", asset: SEPOLIA_USDC, payTo: SELLER, maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2", assetTransferMethod: "eip3009" }, ...over,
});

/** 署名者。呼ばれた型付きデータを全部控える（9a-8: 署名するのは引数の財布）。 */
function buyer() {
  const signed = [];
  const accessed = [];
  const target = {
    address: BUYER,
    signTypedData: async (td) => {
      signed.push(td);
      return SIG;
    },
  };
  const account = new Proxy(target, { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } });
  return { account, signed, signAccesses: () => accessed.filter((k) => k.startsWith("sign")) };
}

const ALLOW = {
  subject: { type: "resource", id: "a".repeat(64) },
  role: "payer",
  recommendation: "ALLOW",
  reason_codes: ["l0_pass", "l1_delivered"],
  facts: { l0: { status: "pass" }, l1: { n_delivered: 3, n_attempts: 3 }, l2: { status: "undeclared" } },
  evidence: [],
  degraded: false,
  policy: "allow_only",
  rules_version: "2026-09-02.1",
};

function respond(status, { body = "", headers = {}, text } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(Object.entries(headers)),
    json: async () => JSON.parse(body || "null"),
    text: text ?? (async () => body),
  };
}

/**
 * 売り手と vet402 の API の偽物。402 の壁と、支払いヘッダ付きの再送への答え（`onPaid`）を返す。
 * 再送の回数と中身を控える（9a-4 払い直し 0 回）。vet402 の attest（POST /payments/x402）は数える（呼ばれてはいけない）。
 */
function world(accepts, onPaid, { x402Version = 2 } = {}) {
  const paid = [];
  const attests = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/decision")) return respond(200, { body: JSON.stringify(ALLOW) });
    if (u.includes("/payments/x402")) { attests.push(u); return respond(200, { body: "{}" }); }
    if (!u.startsWith(RESOURCE)) throw new Error(`unexpected call ${u}`);
    const h = init.headers ?? {};
    const raw = h["PAYMENT-SIGNATURE"] ?? h["payment-signature"] ?? h["X-PAYMENT"];
    if (!raw) return respond(402, { headers: { "payment-required": b64({ x402Version, accepts }) } });
    const decoded = JSON.parse(atob(raw));
    paid.push(decoded);
    return onPaid(decoded, init);
  };
  return { fetch, paid, attests };
}

const receiptHeader = (tx, success = true) => ({ "PAYMENT-RESPONSE": b64({ success, transaction: tx, network: "eip155:84532", payer: BUYER }) });

/** エスクローの状態の偽物。`paymentState(hash)` だけに答える。 */
function escrowState(collected, capturable, refundable) {
  const reads = [];
  return {
    reads,
    reader: {
      readContract: async (args) => {
        reads.push(args);
        assert.equal(args.functionName, "paymentState");
        assert.equal(args.address.toLowerCase(), ESCROW.toLowerCase());
        return [collected, BigInt(capturable), BigInt(refundable)];
      },
    },
  };
}

const base = { payee: SELLER, resource: RESOURCE, amountUsd: 0.01, network: "base-sepolia" };

// ---------- 9a-1 届いた例は確定する ----------

test("9a-1 auth-capture: 空でない 200 が届き、売り手が capture を返す → paid・確定 tx は capture の 1 つ・署名は ReceiveWithAuthorization の 1 つ", async () => {
  const b = buyer();
  const w = world([exactAccept(), acAccept()], () => respond(200, { body: '{"answer":42}', headers: receiptHeader(CAPTURE_TX) }));
  const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch });
  assert.equal(r.status, "paid");
  assert.equal(r.txHash, CAPTURE_TX);
  assert.equal(r.challenge.scheme, "auth-capture", "auth-capture を出す売り手には auth-capture を選ぶ（exact が先頭でも）");
  assert.equal(w.paid.length, 1, "売り手への支払いつき再送は 1 回");
  assert.equal(b.signed.length, 1, "署名は 1 つ");
  const td = b.signed[0];
  assert.equal(td.primaryType, "ReceiveWithAuthorization");
  assert.equal(td.message.to.toLowerCase(), COLLECTOR.toLowerCase(), "宛先は v1.1 の token collector（売り手ではない）");
  assert.equal(String(td.message.value), "10000");
  assert.equal(td.domain.verifyingContract.toLowerCase(), SEPOLIA_USDC.toLowerCase());
  assert.equal(Number(td.domain.chainId), 84532);
  assert.equal(w.paid[0].accepted.scheme, "auth-capture");
  assert.equal(w.paid[0].payload.authorization.to.toLowerCase(), COLLECTOR.toLowerCase());
  const ac = r.authCapture;
  assert.ok(ac, "auth-capture の控えがある");
  assert.equal(ac.delivered, true);
  assert.equal(ac.outcome, "captured");
  assert.equal(ac.captureTx, CAPTURE_TX);
  assert.equal(ac.recovery, null);
  assert.equal(ac.signatures, 1);
  assert.equal(r.attested, false);
  assert.equal(w.attests.length, 0, "testnet の支払いを本番の台帳へ attest しない");
});

test("9a-1 chain の読みを渡すと、capture の確定はエスクローで確かめる（refundable > 0 のときだけ paid）", async () => {
  const b = buyer();
  const s = escrowState(true, 0, 10000);
  const w = world([acAccept()], () => respond(200, { body: "ok", headers: receiptHeader(CAPTURE_TX) }));
  const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch, authCapture: { stateReader: s.reader } });
  assert.equal(r.status, "paid");
  assert.equal(r.authCapture.state.source, "chain");
  assert.equal(s.reads.length, 1);
  assert.equal(s.reads[0].args[0], r.authCapture.paymentInfoHash, "読むのは控えた paymentInfoHash");
});

test("9a-1 届いても、エスクローに hold が残ったまま（capture されていない）なら paid にしない", async () => {
  const b = buyer();
  const s = escrowState(true, 10000, 0);
  const w = world([acAccept()], () => respond(200, { body: "ok", headers: receiptHeader(CAPTURE_TX) }));
  const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch, authCapture: { stateReader: s.reader } });
  assert.equal(r.status, "failed");
  assert.equal(r.txHash, null);
  assert.equal(r.authCapture.outcome, "held");
  assert.equal(r.decision.reason_codes.includes("settle_failed"), true);
  assert.equal(r.authCapture.recovery.reclaim.availableAt, r.authCapture.paymentInfo.authorizationExpiry);
});

// ---------- 9a-2 届かなかった例は確定せず、買い手へ戻る ----------

const NOT_DELIVERED = [
  ["HTTP 500（売り手が void を返す）", () => respond(500, { body: '{"error":"x"}', headers: receiptHeader(VOID_TX) }), "http_status"],
  ["HTTP 400", () => respond(400, { body: "bad" }), "http_status"],
  ["空の 200", () => respond(200, { body: "  ", headers: receiptHeader(VOID_TX) }), "empty_body"],
  ["202 で本文なし", () => respond(202, { body: "", headers: receiptHeader(VOID_TX) }), "accepted_202"],
];

for (const [label, answer, failure] of NOT_DELIVERED) {
  test(`9a-2 ${label} → 確定しない（failed・txHash null・not_delivered）・戻り道は void と期限後の reclaim`, async () => {
    const b = buyer();
    const w = world([acAccept()], answer);
    const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch });
    assert.equal(r.status, "failed");
    assert.equal(r.signed, true, "署名は隠さない");
    assert.equal(r.txHash, null, "確定の tx として何も返さない");
    assert.equal(r.decision.reason_codes.includes("not_delivered"), true);
    assert.equal(w.paid.length, 1, "払い直さない");
    assert.equal(b.signed.length, 1);
    const ac = r.authCapture;
    assert.equal(ac.delivered, false);
    assert.equal(ac.deliveryFailure, failure);
    assert.notEqual(ac.outcome, "captured", "売り手の申告だけで capture とは言わない");
    assert.equal(ac.captureTx, null);
    assert.ok(ac.recovery, "戻り道がある");
    assert.equal(ac.recovery.reclaim.by, "payer");
    assert.equal(ac.recovery.reclaim.fn, "reclaim");
    assert.equal(ac.recovery.reclaim.escrow.toLowerCase(), ESCROW.toLowerCase());
    assert.equal(ac.recovery.reclaim.availableAt, ac.paymentInfo.authorizationExpiry, "reclaim は captureDeadline から");
    assert.ok(Math.abs(ac.paymentInfo.authorizationExpiry - (now() + 1200)) <= 5, "captureDeadline は 402 の値そのまま");
    assert.equal(ac.paymentInfo.payer.toLowerCase(), BUYER.toLowerCase(), "reclaim に渡す PaymentInfo の payer は買い手");
    assert.equal(ac.recovery.void.by, "operator");
  });
}

test("9a-2 時間切れ（応答が来ない）→ 届かなかった・確定しない・払い直さない", async () => {
  const b = buyer();
  const w = world([acAccept()], (_d, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch, authCapture: { deliveryTimeoutMs: 50 } });
  assert.equal(r.status, "failed");
  assert.equal(r.txHash, null);
  assert.equal(r.authCapture.deliveryFailure, "timeout");
  assert.equal(r.authCapture.delivered, false);
  assert.equal(w.paid.length, 1);
});

test("9a-2 時間切れ（ヘッダだけ返して本文を流さない）→ 届かなかった", async () => {
  const b = buyer();
  const w = world([acAccept()], () => respond(200, { headers: receiptHeader(CAPTURE_TX), text: () => new Promise(() => {}) }));
  const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch, authCapture: { deliveryTimeoutMs: 50 } });
  assert.equal(r.status, "failed");
  assert.equal(r.txHash, null);
  assert.equal(r.authCapture.deliveryFailure, "timeout");
});

test("9a-2 chain の読みで void を確かめる → outcome voided（買い手の差分 0）", async () => {
  const b = buyer();
  const s = escrowState(true, 0, 0);
  const w = world([acAccept()], () => respond(500, { body: "x", headers: receiptHeader(VOID_TX) }));
  const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch, authCapture: { stateReader: s.reader } });
  assert.equal(r.status, "failed");
  assert.equal(r.authCapture.outcome, "voided");
  assert.equal(r.authCapture.recovery.void.reportedTx, VOID_TX);
  assert.equal(r.authCapture.recovery.refund, null, "capture されていないので refund は要らない");
});

test("9a-2 chain の読みで hold が残る（売り手が消えた）→ outcome held・期限後に reclaim", async () => {
  const b = buyer();
  const s = escrowState(true, 10000, 0);
  const w = world([acAccept()], () => respond(202, { body: "" }));
  const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch, authCapture: { stateReader: s.reader } });
  assert.equal(r.status, "failed");
  assert.equal(r.authCapture.outcome, "held");
  assert.equal(r.authCapture.recovery.reclaim.availableAt, r.authCapture.paymentInfo.authorizationExpiry);
});

test("9a-2 届かないのに capture された（chain で確かめた）→ paid にせず、戻すのは operator の refund と書く", async () => {
  const b = buyer();
  const s = escrowState(true, 0, 10000);
  const w = world([acAccept()], () => respond(202, { body: "", headers: receiptHeader(CAPTURE_TX) }));
  const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch, authCapture: { stateReader: s.reader } });
  assert.equal(r.status, "failed");
  assert.equal(r.txHash, null);
  assert.equal(r.authCapture.outcome, "captured");
  assert.deepEqual(r.authCapture.recovery.refund, { by: "operator" });
});

// ---------- 9a-3 上限超えは払わない ----------

test("9a-3 402 の額が上限を超える → 署名前に refused・signed false・nonce null・price_above_ceiling", async () => {
  const b = buyer();
  const w = world([acAccept({ amount: "2000000" })], () => { throw new Error("must not resend"); });
  const r = await payOrRefuse({ ...base, amountUsd: 0.01, account: b.account, fetch: w.fetch, policy: { maxPerTxUsd: 1 } });
  assert.equal(r.status, "refused");
  assert.equal(r.signed, false);
  assert.equal(r.nonce, null);
  assert.equal(r.decision.reason_codes.includes("price_above_ceiling"), true);
  assert.deepEqual(b.signAccesses(), [], "署名者に触れていない");
  assert.equal(w.paid.length, 0);
  assert.equal(r.authCapture, undefined);
});

test("9a-3 402 の額が名乗りを超える → price_above_declared（上限の関門とは別）", async () => {
  const b = buyer();
  const w = world([acAccept({ amount: "20000" })], () => { throw new Error("must not resend"); });
  const r = await payOrRefuse({ ...base, amountUsd: 0.01, account: b.account, fetch: w.fetch });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("price_above_declared"), true);
  assert.deepEqual(b.signAccesses(), []);
});

// ---------- 9a-4 払い直し 0 回 ----------

test("9a-4 失敗のあと SDK は 2 回目を送らない（署名 1・再送 1）", async () => {
  const b = buyer();
  let calls = 0;
  const w = world([acAccept()], () => { calls += 1; throw new Error("ECONNRESET"); });
  const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch });
  assert.equal(r.status, "failed");
  assert.equal(calls, 1);
  assert.equal(b.signed.length, 1);
  assert.equal(r.authCapture.deliveryFailure, "network_error");
});

// ---------- 主張を広げない: exact だけの売り手・本番 Base ----------

test("exact しか出さない売り手（Base Sepolia）→ 今までどおり exact の TransferWithAuthorization・authCapture のキーは無い", async () => {
  const b = buyer();
  const w = world([exactAccept()], () => respond(200, { body: "ok", headers: receiptHeader("0x" + "e".repeat(64)) }));
  const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch });
  assert.equal(r.status, "paid");
  assert.equal(r.challenge.scheme, "exact");
  assert.equal("authCapture" in r, false);
  assert.equal(b.signed[0].primaryType, "TransferWithAuthorization");
  assert.equal(b.signed[0].message.to.toLowerCase(), SELLER.toLowerCase());
});

const baseAc = () => acAccept({ network: "eip155:8453", asset: BASE_USDC }, { name: "USD Coin", version: "2" });
const baseExact = () => exactAccept({ network: "eip155:8453", asset: BASE_USDC, extra: { assetTransferMethod: "eip3009" } });
const mainnet = { payee: SELLER, resource: RESOURCE, amountUsd: 0.01 };

test("本番 Base は既定で auth-capture を使わない（exact と並んでいても exact を選ぶ）", async () => {
  const b = buyer();
  const w = world([baseAc(), baseExact()], () => respond(200, { body: "ok", headers: receiptHeader("0x" + "e".repeat(64)) }));
  const r = await payOrRefuse({ ...mainnet, account: b.account, fetch: w.fetch });
  assert.equal(r.challenge.scheme, "exact");
  assert.equal(b.signed[0].primaryType, "TransferWithAuthorization");
  assert.equal("authCapture" in r, false);
});

test("本番 Base で auth-capture だけを出す売り手 → 既定では払わない（署名前に chain_or_asset_mismatch）", async () => {
  const b = buyer();
  const w = world([baseAc()], () => { throw new Error("must not resend"); });
  const r = await payOrRefuse({ ...mainnet, account: b.account, fetch: w.fetch });
  assert.equal(r.status, "refused");
  assert.equal(r.decision.reason_codes.includes("chain_or_asset_mismatch"), true);
  assert.deepEqual(b.signAccesses(), []);
});

test("本番 Base は authCapture.onBase: true を渡したときだけ auth-capture を使う", async () => {
  const b = buyer();
  const w = world([baseAc()], () => respond(200, { body: "ok", headers: receiptHeader(CAPTURE_TX) }));
  const r = await payOrRefuse({ ...mainnet, account: b.account, fetch: w.fetch, authCapture: { onBase: true } });
  assert.equal(r.status, "paid");
  assert.equal(r.challenge.scheme, "auth-capture");
  assert.equal(b.signed[0].domain.name, "USD Coin");
  assert.equal(Number(b.signed[0].domain.chainId), 8453);
  assert.equal(r.attested, false, "auth-capture の capture は本番の台帳へ attest しない");
  assert.equal(w.attests.length, 0);
});

test("Base Sepolia でも authCapture.enabled: false なら exact に戻る", async () => {
  const b = buyer();
  const w = world([acAccept(), exactAccept()], () => respond(200, { body: "ok", headers: receiptHeader("0x" + "e".repeat(64)) }));
  const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch, authCapture: { enabled: false } });
  assert.equal(r.challenge.scheme, "exact");
});

// ---------- 払える形は 1 つだけ（ほかの auth-capture は払わない） ----------

const t0 = now();
const INELIGIBLE = [
  ["captureMode deferred", {}, { captureMode: "deferred" }],
  ["operatorType custom", {}, { operatorType: "custom" }],
  ["paymentFlow authorization", {}, { paymentFlow: "authorization" }],
  ["permit2", {}, { assetTransferMethod: "permit2" }],
  ["v1.0 や別のエスクロー", {}, { authCaptureEscrow: "0xBdEA0D1bcC5966192B070Fdf62aB4EF5b4420cff" }],
  ["receiverAuthorizer が無い sync（capture も void もできない）", {}, { receiverAuthorizer: "0x0000000000000000000000000000000000000000" }],
  ["capture の期限が 1 時間より先", {}, { captureDeadline: t0 + 7200, refundDeadline: t0 + 9000 }],
  ["capture の期限が過去", {}, { captureDeadline: t0 - 1, refundDeadline: t0 + 100 }],
  ["売り手が別の EIP-712 ドメインを名乗る", {}, { name: "Fake USDC" }],
  ["policy あり", {}, { policy: "0x00000000000000000000000000000000000000aa" }],
  ["x402 v1 の壁", { __v1: true }, {}],
];
for (const [label, over, extraOver] of INELIGIBLE) {
  test(`払わない auth-capture: ${label} → 署名前に拒否`, async () => {
    const b = buyer();
    const { __v1, ...rest } = over;
    const w = world([acAccept(rest, extraOver)], () => { throw new Error("must not resend"); }, { x402Version: __v1 ? 1 : 2 });
    const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch });
    assert.equal(r.status, "refused");
    assert.equal(r.signed, false);
    assert.deepEqual(b.signAccesses(), []);
    assert.equal(w.paid.length, 0);
  });
}

// ---------- 9a-8 預からない・期限後の reclaim は買い手の財布 ----------

test("9a-8 署名は引数の財布・資金の行き先は売り手かエスクロー（vet402 の財布は PaymentInfo のどこにも無い）", async () => {
  const b = buyer();
  const w = world([acAccept()], () => respond(200, { body: "ok", headers: receiptHeader(CAPTURE_TX) }));
  const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch });
  assert.deepEqual(b.signAccesses(), ["signTypedData"], "署名者の signTypedData に 1 回だけ触れる");
  const pi = r.authCapture.paymentInfo;
  assert.equal(pi.payer.toLowerCase(), BUYER.toLowerCase());
  assert.equal(pi.receiver.toLowerCase(), SELLER.toLowerCase());
  assert.equal(pi.operator.toLowerCase(), OPERATOR.toLowerCase());
  assert.equal(r.authCapture.escrow.toLowerCase(), ESCROW.toLowerCase());
  assert.equal(r.receipt.payer.toLowerCase(), BUYER.toLowerCase());
});

test("reclaim: 買い手の財布から escrow.reclaim(paymentInfo) を送る・期限前と他人の財布は送る前に止める", async () => {
  const b = buyer();
  const w = world([acAccept()], () => respond(202, { body: "" }));
  const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch });
  const pi = r.authCapture.paymentInfo;
  const writes = [];
  const wallet = { account: { address: BUYER }, writeContract: async (a) => { writes.push(a); return "0x" + "f".repeat(64); } };
  await assert.rejects(
    reclaimAuthCapture({ wallet, paymentInfo: pi, nowSec: pi.authorizationExpiry - 1 }),
    /reclaim_before_deadline/,
  );
  await assert.rejects(
    reclaimAuthCapture({ wallet: { ...wallet, account: { address: SELLER } }, paymentInfo: pi, nowSec: pi.authorizationExpiry + 1 }),
    /reclaim_not_payer/,
  );
  assert.equal(writes.length, 0);
  const out = await reclaimAuthCapture({ wallet, paymentInfo: pi, nowSec: pi.authorizationExpiry + 1 });
  assert.equal(out.txHash, "0x" + "f".repeat(64));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].functionName, "reclaim");
  assert.equal(writes[0].address.toLowerCase(), ESCROW.toLowerCase());
  assert.equal(writes[0].args[0].payer, pi.payer);
  assert.equal(writes[0].args[0].maxAmount, 10000n);
  assert.equal(writes[0].args[0].salt, BigInt(pi.salt));
});

test("設定の誤りは通信の前に throw（authCapture.onBase が真偽値でない等）", async () => {
  const b = buyer();
  const w = world([acAccept()], () => respond(200, { body: "ok" }));
  await assert.rejects(payOrRefuse({ ...base, account: b.account, fetch: w.fetch, authCapture: { onBase: "yes" } }), /invalid_auth_capture/);
  await assert.rejects(payOrRefuse({ ...base, account: b.account, fetch: w.fetch, authCapture: { deliveryTimeoutMs: 0 } }), /invalid_auth_capture/);
  assert.equal(w.paid.length, 0);
});

// ---------- 第3層: auth-capture の署名と @x402/evm は拒否経路の静的グラフに無い ----------

test("第3層: dist/index.js の静的グラフに auth-capture-pay.js と @x402/evm と viem が現れない", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { dirname, resolve } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
  const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const re = /(?:^|[;}\n])\s*(?:import|export)\b(?!\s*\()(?:[^;]*?\bfrom)?\s*["']([^"']+)["']\s*;?/g;
  const seen = new Set();
  const external = new Set();
  const queue = [resolve(dist, "index.js")];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const m of strip(readFileSync(file, "utf8")).matchAll(re)) {
      if (m[1].startsWith(".")) queue.push(resolve(dirname(file), m[1]));
      else external.add(m[1]);
    }
  }
  assert.ok(seen.has(resolve(dist, "auth-capture.js")), "定数のモジュールは静的グラフに居る（検査が空振りしていない）");
  assert.equal(seen.has(resolve(dist, "auth-capture-pay.js")), false);
  assert.ok(existsSync(resolve(dist, "auth-capture-pay.js")), "検査対象が実在する");
  assert.deepEqual([...external].filter((s) => s.startsWith("@x402/") || s === "viem" || s.startsWith("viem/")), []);
  assert.match(readFileSync(resolve(dist, "pay-or-refuse.js"), "utf8"), /await import\("\.\/auth-capture-pay\.js"\)/);
});
