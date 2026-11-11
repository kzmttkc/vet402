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

/**
 * 偽のエスクロー（残高の台帳つき）と、それを使う売り手。売り手は x402 の escrow・sync と同じ順で動く:
 * 支払いヘッダを受けたら authorize（買い手 → エスクロー）→ handler → 規則に従い capture（エスクロー → 売り手）か void（→ 買い手）。
 * 規則は 3 つ。
 *   - "delivery" … 試験用の売り手の決まり（vet402 の届いた規則）: 空でない 2xx（202 を除く）だけ capture、それ以外は void
 *   - "official" … 公式 Express ミドルウェア（x402-foundation/x402 d3eb19d0 typescript/packages/http/express/src/index.ts）の門:
 *                  handler の後 status >= 400 なら cancel（void）、400 未満は capture
 *   - "vanish" … authorize のあと何もしない（capture も void もしない・operator が消えた形）
 * 買い手の SDK が本文を読んだ時刻とエスクローを読んだ時刻を、同じ events に積む（9a-1 の順序の断言に使う）。
 */
function escrowWorld(accepts, { rule = "delivery", status = 200, body = '{"answer":42}', hang = false } = {}) {
  const events = [];
  const ledger = { buyer: 10_000_000n, seller: 0n, escrow: 0n, collected: false, capturable: 0n, refundable: 0n };
  const paid = [];
  const fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes("/decision")) return respond(200, { body: JSON.stringify(ALLOW) });
    if (u.includes("/payments/x402")) return respond(200, { body: "{}" });
    const h = init.headers ?? {};
    const raw = h["PAYMENT-SIGNATURE"] ?? h["payment-signature"];
    if (!raw) return respond(402, { headers: { "payment-required": b64({ x402Version: 2, accepts }) } });
    const decoded = JSON.parse(atob(raw));
    paid.push(decoded);
    if (decoded.accepted.scheme !== "auth-capture") {
      // auth-capture を使わない買い手（直す前のコード）: exact として即時に送金される。
      events.push("seller:exact_settle");
      ledger.buyer -= 10000n; ledger.seller += 10000n;
      return respond(200, { body, headers: receiptHeader("0x" + "e".repeat(64)), text: async () => { events.push("buyer:body_read"); return body; } });
    }
    const amount = BigInt(decoded.payload.authorization.value);
    ledger.buyer -= amount; ledger.escrow += amount; ledger.collected = true; ledger.capturable = amount;
    events.push("seller:authorize");
    events.push("seller:handler");
    if (hang || rule === "vanish") {
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    const capture =
      rule === "official" ? status < 400
      : status >= 200 && status < 300 && status !== 202 && body.trim().length > 0;
    let tx;
    if (capture) {
      ledger.escrow -= amount; ledger.seller += amount; ledger.capturable = 0n; ledger.refundable = amount;
      events.push("seller:capture"); tx = CAPTURE_TX;
    } else {
      ledger.escrow -= amount; ledger.buyer += amount; ledger.capturable = 0n;
      events.push("seller:void"); tx = VOID_TX;
    }
    return respond(status, { body, headers: receiptHeader(tx), text: async () => { events.push("buyer:body_read"); return body; } });
  };
  const reader = {
    readContract: async (args) => {
      events.push("buyer:state_read");
      assert.equal(args.functionName, "paymentState");
      return [ledger.collected, ledger.capturable, ledger.refundable];
    },
  };
  return { fetch, paid, events, ledger, reader };
}

// ---------- 9a-1 届いた例は確定する ----------

test("9a-1 順序: authorize → 売り手の handler → capture のあとで、SDK が本文を読み、エスクローを読んでから paid と言う", async () => {
  const b = buyer();
  // exact を先頭に置く（auth-capture を選ばない実装は exact で払ってしまい、ここで振る舞いの理由で落ちる）。
  const w = escrowWorld([exactAccept(), acAccept()], { rule: "delivery" });
  const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch, authCapture: { stateReader: w.reader } });
  assert.ok(w.events.includes("buyer:body_read"), "SDK は本文を読んでから判定する（読まずに paid と言わない）");
  assert.ok(w.events.includes("seller:authorize"), "資金はまず hold（authorize）になる。即時の送金ではない");
  assert.equal(w.events.includes("seller:exact_settle"), false, "exact の即時送金を使っていない");
  assert.deepEqual(w.events, ["seller:authorize", "seller:handler", "seller:capture", "buyer:body_read", "buyer:state_read"]);
  assert.equal(r.status, "paid");
  assert.equal(r.txHash, CAPTURE_TX);
  assert.equal(r.authCapture.state.source, "chain");
  assert.equal(w.ledger.seller, 10000n);
  assert.equal(w.ledger.buyer, 10_000_000n - 10000n);
});

test("9a-1 auth-capture: 空でない 200 が届き、売り手が capture を返す → paid・確定 tx は capture の 1 つ・署名は ReceiveWithAuthorization の 1 つ", async () => {
  const b = buyer();
  const w = world([exactAccept(), acAccept()], () => respond(200, { body: '{"answer":42}', headers: receiptHeader(CAPTURE_TX) }));
  const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch });
  assert.equal(r.challenge.scheme, "auth-capture", "auth-capture を出す売り手には auth-capture を選ぶ（exact が先頭でも）");
  assert.equal(w.paid.length, 1, "売り手への支払いつき再送は 1 回");
  assert.equal(b.signed.length, 1, "署名は 1 つ");
  const td = b.signed[0];
  assert.equal(td.primaryType, "ReceiveWithAuthorization");
  assert.equal(td.message.to.toLowerCase(), COLLECTOR.toLowerCase(), "宛先は v1.1 の token collector（売り手ではない）");
  assert.equal(String(td.message.value), "10000");
  assert.equal(td.domain.verifyingContract.toLowerCase(), SEPOLIA_USDC.toLowerCase());
  assert.equal(Number(td.domain.chainId), 84532);
  assert.equal(w.paid[0].payload.authorization.to.toLowerCase(), COLLECTOR.toLowerCase());
  assert.equal(r.status, "paid");
  assert.equal(r.txHash, CAPTURE_TX);
  const ac = r.authCapture;
  assert.equal(ac.delivered, true);
  assert.equal(ac.outcome, "captured");
  assert.equal(ac.state.source, "seller_header", "chain を読まないときは売り手の申告だと書く");
  assert.equal(ac.captureTx, CAPTURE_TX);
  assert.equal(ac.recovery, null);
  assert.equal(r.attested, false);
  assert.equal(w.attests.length, 0, "testnet の支払いを本番の台帳へ attest しない");
});

test("9a-1 届いても、エスクローに hold が残ったまま（capture されていない）なら paid にしない・戻り道は void か期限後の reclaim", async () => {
  const b = buyer();
  const s = escrowState(true, 10000, 0);
  const w = world([acAccept()], () => respond(200, { body: "ok", headers: receiptHeader(CAPTURE_TX) }));
  const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch, authCapture: { stateReader: s.reader } });
  assert.equal(r.status, "failed");
  assert.equal(r.txHash, null);
  assert.equal(r.authCapture.outcome, "held");
  assert.equal(r.decision.reason_codes.includes("settle_failed"), true);
  assert.equal(r.authCapture.recovery.state, "uncaptured");
  assert.equal(r.authCapture.recovery.reclaim.availableAt, r.authCapture.paymentInfo.authorizationExpiry);
});

// ---------- 9a-2 届かなかった例は確定せず、買い手へ戻る ----------
// 合格の主張は「正直な operator（届かなければ void する売り手）か、hold が残り期限後に reclaim できる場合に限る」。
// 公式 Express ミドルウェアは 400 未満を capture するので、202 と空の 200 で void するのは試験用の売り手の決まり（rule "delivery"）。
// 届かずに capture された例は 9a-2 の合格に数えない（下の「9a-2 の外」）。SDK はそれを paid にせず、印を付けて失敗で返す。

const NOT_DELIVERED = [
  ["HTTP 500（公式の門でも void）", { status: 500, body: '{"error":"x"}', rule: "official" }, "http_status"],
  ["HTTP 400（公式の門でも void）", { status: 400, body: "bad", rule: "official" }, "http_status"],
  ["空の 200（試験用の売り手の決まりで void）", { status: 200, body: "  ", rule: "delivery" }, "empty_body"],
  ["202 で本文なし（試験用の売り手の決まりで void）", { status: 202, body: "", rule: "delivery" }, "accepted_202"],
];

for (const [label, opts, failure] of NOT_DELIVERED) {
  test(`9a-2 ${label} → 確定しない・capture なし・買い手の残高は呼ぶ前と同じ（chain で確かめる）`, async () => {
    const b = buyer();
    const w = escrowWorld([acAccept()], opts);
    const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch, authCapture: { stateReader: w.reader } });
    assert.equal(r.status, "failed");
    assert.equal(r.signed, true, "署名は隠さない");
    assert.equal(r.txHash, null, "確定の tx として何も返さない");
    assert.equal(r.decision.reason_codes.includes("not_delivered"), true);
    assert.equal(r.decision.reason_codes.includes("operator_captured_undelivered"), false);
    assert.equal(w.paid.length, 1, "払い直さない");
    assert.equal(b.signed.length, 1);
    assert.equal(w.events.includes("seller:capture"), false, "capture の tx が無い");
    assert.equal(w.ledger.buyer, 10_000_000n, "買い手の残高は呼ぶ前と同じ");
    assert.equal(w.ledger.seller, 0n);
    const ac = r.authCapture;
    assert.equal(ac.delivered, false);
    assert.equal(ac.deliveryFailure, failure);
    assert.equal(ac.outcome, "voided");
    assert.equal(ac.capturedUndelivered, false);
    assert.deepEqual(ac.recovery, { state: "uncaptured", fundsWithBuyer: true, void: null, reclaim: null });
    assert.equal(ac.paymentInfo.payer.toLowerCase(), BUYER.toLowerCase(), "PaymentInfo の payer は買い手");
  });
}

test("9a-2 時間切れ（売り手が消えた・hold が残る）→ 確定しない・戻り道は operator の void か、期限後の買い手の reclaim", async () => {
  const b = buyer();
  const w = escrowWorld([acAccept()], { rule: "vanish" });
  const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch, authCapture: { deliveryTimeoutMs: 50, stateReader: w.reader } });
  assert.equal(r.status, "failed");
  assert.equal(r.txHash, null);
  assert.equal(r.authCapture.deliveryFailure, "timeout");
  assert.equal(r.authCapture.outcome, "held");
  assert.equal(w.paid.length, 1);
  const rec = r.authCapture.recovery;
  assert.equal(rec.state, "uncaptured");
  assert.equal(rec.fundsWithBuyer, false);
  assert.equal(rec.void.by, "operator");
  assert.equal(rec.reclaim.by, "payer");
  assert.equal(rec.reclaim.fn, "reclaim");
  assert.equal(rec.reclaim.escrow.toLowerCase(), ESCROW.toLowerCase());
  assert.equal(rec.reclaim.availableAt, r.authCapture.paymentInfo.authorizationExpiry, "reclaim は captureDeadline から");
  assert.ok(Math.abs(r.authCapture.paymentInfo.authorizationExpiry - (now() + 1200)) <= 5, "captureDeadline は 402 の値そのまま");
});

test("9a-2 時間切れ（ヘッダだけ返して本文を流さない）→ 届かなかった", async () => {
  const b = buyer();
  const w = world([acAccept()], () => respond(200, { headers: receiptHeader(CAPTURE_TX), text: () => new Promise(() => {}) }));
  const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch, authCapture: { deliveryTimeoutMs: 50 } });
  assert.equal(r.status, "failed");
  assert.equal(r.txHash, null);
  assert.equal(r.authCapture.deliveryFailure, "timeout");
  assert.equal(r.authCapture.recovery.state, "unknown", "売り手が capture したかもしれないので判定しない");
});

// chain を読まないとき: 届かなかった支払いは「不明」。reclaim を勧めない（capture 済みなら reclaim では戻らない）。
const UNKNOWN_CASES = [
  ["HTTP 500", () => respond(500, { body: "x", headers: receiptHeader(VOID_TX) }), "http_status", VOID_TX],
  ["空の 200", () => respond(200, { body: "", headers: receiptHeader(CAPTURE_TX) }), "empty_body", CAPTURE_TX],
  ["202", () => respond(202, { body: "", headers: receiptHeader(CAPTURE_TX) }), "accepted_202", CAPTURE_TX],
  ["ヘッダなしの 400", () => respond(400, { body: "bad" }), "http_status", null],
];
for (const [label, answer, failure, reported] of UNKNOWN_CASES) {
  test(`chain を読まない ${label} → failed・outcome unknown・戻り道は「不明（chain を読むまで判定しない）」・reclaim を勧めない`, async () => {
    const b = buyer();
    const w = world([acAccept()], answer);
    const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch });
    assert.equal(r.status, "failed");
    assert.equal(r.txHash, null);
    assert.equal(r.decision.reason_codes.includes("not_delivered"), true);
    const ac = r.authCapture;
    assert.equal(ac.deliveryFailure, failure);
    assert.equal(ac.outcome, "unknown");
    assert.equal(ac.state.source, "seller_header");
    assert.equal(ac.capturedUndelivered, false, "chain を読まずに capture 済みとも言わない");
    assert.deepEqual(ac.recovery, {
      state: "unknown",
      readState: { fn: "paymentState", escrow: ESCROW, paymentInfoHash: ac.paymentInfoHash },
      reportedTx: reported,
    });
    assert.equal("reclaim" in ac.recovery, false);
  });
}

// ---------- 9a-2 の外: 届かずに capture された（正直でない operator、または公式の 400 未満 capture） ----------

for (const [label, opts] of [
  ["公式の門で 202（400 未満なので capture される）", { status: 202, body: "", rule: "official" }],
  ["公式の門で空の 200", { status: 200, body: "", rule: "official" }],
]) {
  test(`9a-2 の外: ${label} → paid にしない・operator_captured_undelivered・戻すのは operator の refund だけ`, async () => {
    const b = buyer();
    const w = escrowWorld([acAccept()], opts);
    const r = await payOrRefuse({ ...base, account: b.account, fetch: w.fetch, authCapture: { stateReader: w.reader } });
    assert.equal(w.events.includes("seller:capture"), true, "この形では売り手側で capture が起きる（9a-2 の合格ではない）");
    assert.equal(w.ledger.buyer, 10_000_000n - 10000n, "買い手の差分は 0 にならない（隠さない）");
    assert.equal(r.status, "failed");
    assert.equal(r.txHash, null, "届かなかった capture を確定の tx として返さない");
    assert.equal(r.decision.reason_codes.includes("not_delivered"), true);
    assert.equal(r.decision.reason_codes.includes("operator_captured_undelivered"), true);
    assert.equal(r.authCapture.outcome, "captured");
    assert.equal(r.authCapture.capturedUndelivered, true);
    assert.deepEqual(r.authCapture.recovery, { state: "captured", refund: { by: "operator" } });
  });
}

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
