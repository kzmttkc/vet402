// ============================================================
// 再試行の前に確かめるための情報が、結果にそろっていること（0.7.1）。
//
// paid / failed は売り手の申告（PAYMENT-RESPONSE）で決まる。売り手が「失敗」と返しても、署名済みの
// 支払いがチェーンに載っている・これから載ることがある。だから `signed: true` の結果には、呼び手が
// チェーンで確かめるのに要る値が全部残っていなければならない:
//   EVM    … EIP-3009 の認可（from・to・value・validAfter・validBefore・nonce）
//   Solana … memo・blockhash・送った取引（base64）
// `receipt` は SDK が既に持っていた値を載せるだけで、新しい判定も自動の再試行もしない。
//
// R6・R7 は項目 3: 送った後で応答が壊れていても、送った取引は結果から消えない。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { payOrRefuse } from "../dist/index.js";

const b64 = (o) => btoa(JSON.stringify(o));

// ---------- EVM ----------

const DECISION = "/decision";
const PAYEE = "0x36038e1d712c5e39f35952164ec58ec2b96caee7";
const PAYER = "0xDB62BD202914609830fA656F87996b91be3Aa673";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RESOURCE = "https://kronossignals.com/api/v1/price/btc";
const base = { payee: PAYEE, resource: RESOURCE, amountUsd: 0.02 };
const okAccept = { scheme: "exact", network: "eip155:8453", amount: "20000", asset: BASE_USDC, payTo: PAYEE, maxTimeoutSeconds: 60, extra: { assetTransferMethod: "eip3009" } };
const decisionBody = (over = {}) => ({
  recommendation: "ALLOW",
  reason_codes: ["l0_pass", "l1_delivered"],
  facts: { l1: { n_delivered: 3 } },
  evidence: [],
  degraded: false,
  ...over,
});

function watchedAccount() {
  const accessed = [];
  const signedMessages = [];
  const account = new Proxy(
    { address: PAYER, signTypedData: async (typed) => { signedMessages.push(typed.message); return "0xsig"; } },
    { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } },
  );
  return { account, accessed, signedMessages };
}

/**
 * `paidAnswer(init)` が、署名つきの再送への答え（応答オブジェクトそのもの）。壊れた応答を返せるように、
 * ここでは応答を包み直さない。
 */
function evmWorld({ decision = { status: 200, body: decisionBody() }, paidAnswer }) {
  const calls = [];
  const fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes(DECISION)) return { ok: decision.status < 400, status: decision.status, json: async () => decision.body, headers: new Map() };
    if (u.includes("payments/x402")) return { ok: true, status: 200, json: async () => ({ ok: true }), headers: new Map() };
    if (u.startsWith(RESOURCE)) {
      if (!(init?.headers ?? {})["PAYMENT-SIGNATURE"]) {
        return { ok: false, status: 402, json: async () => ({}), headers: new Map([["payment-required", b64({ x402Version: 2, accepts: [okAccept] })]]) };
      }
      return paidAnswer(init);
    }
    throw new Error(`forbidden call: ${u}`);
  };
  return { fetch, calls };
}

const sellerSays = (settlement, status = 200) => () => ({
  ok: status < 400,
  status,
  json: async () => ({}),
  headers: new Map([["PAYMENT-RESPONSE", b64(settlement)]]),
});

function assertAuthorization(r, w) {
  const a = r.receipt.retry.authorization;
  assert.ok(a, "EIP-3009 の認可が receipt に無い");
  assert.deepEqual(a, w.signedMessages[0], "receipt の認可は、署名器が実際に署名した message と同じ");
  assert.equal(a.nonce, r.nonce);
  assert.equal(a.from, PAYER);
  assert.equal(a.to, PAYEE);
  assert.equal(a.value, "20000");
  assert.match(a.validAfter, /^[0-9]+$/);
  assert.match(a.validBefore, /^[0-9]+$/);
  const now = Math.floor(Date.now() / 1000);
  assert.ok(Number(a.validBefore) > now && Number(a.validBefore) <= now + 120, `validBefore は 120 秒以内: ${a.validBefore}`);
  assert.equal("signature" in a, false, "署名そのものは receipt に載せない");
  assert.equal(JSON.stringify(r.receipt).includes("0xsig"), false, "署名そのものは receipt のどこにも無い");
}

test("R1 EVM: 売り手が失敗と返した（署名は実在）→ receipt に認可・売り手の申告・払った先がそろう", async () => {
  const w = watchedAccount();
  const f = evmWorld({ paidAnswer: sellerSays({ success: false, transaction: "", errorReason: "insufficient_funds", network: "eip155:8453", payer: PAYER }, 402) });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch });
  assert.equal(r.status, "failed");
  assert.equal(r.signed, true);
  assert.ok(r.receipt, "receipt が無い");
  assert.equal(r.receipt.endpoint, RESOURCE);
  assert.equal(r.receipt.method, "GET");
  assert.equal(r.receipt.network, "eip155:8453");
  assert.equal(r.receipt.asset, BASE_USDC);
  assert.equal(r.receipt.payTo, PAYEE);
  assert.equal(r.receipt.amount, "20000");
  assert.equal(r.receipt.maxPerTxUsd, 1);
  assert.equal(r.receipt.payer, PAYER);
  assert.deepEqual(r.receipt.reason_codes, r.decision.reason_codes);
  assert.equal(r.receipt.reason_codes.includes("settle_failed"), true);
  assert.deepEqual(r.receipt.settlement, { success: false, transaction: null, network: "eip155:8453", payer: PAYER, errorReason: "insufficient_funds" });
  assert.equal(r.receipt.responseStatus, 402);
  assert.equal(r.receipt.retry.signed, true);
  assert.equal(r.receipt.retry.svm, null);
  assertAuthorization(r, w);
});

test("R2 EVM: 署名の後で応答を読めず例外になった → それでも receipt に認可が残る（売り手の申告は null）", async () => {
  const w = watchedAccount();
  const f = evmWorld({ paidAnswer: () => ({ ok: true, status: 200, json: async () => ({}), get headers() { throw new Error("response headers unreadable"); } }) });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch });
  assert.equal(r.status, "failed");
  assert.equal(r.signed, true);
  assert.equal(r.receipt.settlement, null);
  assert.equal(r.receipt.responseStatus, null);
  assert.equal(r.receipt.payer, PAYER);
  assertAuthorization(r, w);
});

test("R2b EVM: 再送の fetch が reject した → receipt に認可が残る", async () => {
  const w = watchedAccount();
  const f = evmWorld({ paidAnswer: () => { throw new Error("ECONNRESET"); } });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch });
  assert.equal(r.status, "failed");
  assert.equal(r.receipt.settlement, null);
  assertAuthorization(r, w);
});

test("R3 EVM: 払えた → receipt の settlement は売り手の申告そのまま、認可も残る", async () => {
  const w = watchedAccount();
  const f = evmWorld({ paidAnswer: sellerSays({ success: true, transaction: "0xtx", network: "eip155:8453", payer: PAYER }) });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, policy: { maxPerTxUsd: 0.5 } });
  assert.equal(r.status, "paid");
  assert.equal(r.receipt.maxPerTxUsd, 0.5);
  assert.deepEqual(r.receipt.settlement, { success: true, transaction: "0xtx", network: "eip155:8453", payer: PAYER, errorReason: null });
  assert.equal(r.receipt.settlement.transaction, r.txHash);
  assert.equal(r.receipt.responseStatus, 200);
  assert.deepEqual(r.receipt.reason_codes, r.decision.reason_codes);
  assertAuthorization(r, w);
});

test("R4 拒否（判定で止まった）→ receipt は「署名していない」と言い、署名者には一度も触らない", async () => {
  const w = watchedAccount();
  const f = evmWorld({ decision: { status: 200, body: decisionBody({ recommendation: "BLOCK", reason_codes: ["l0_fail"] }) }, paidAnswer: () => { throw new Error("must not be reached"); } });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch });
  assert.equal(r.status, "refused");
  assert.deepEqual(r.receipt, {
    endpoint: RESOURCE,
    method: "GET",
    network: null,
    asset: null,
    payTo: null,
    amount: null,
    maxPerTxUsd: 1,
    payer: null,
    reason_codes: ["l0_fail", "payee_recommendation_block"],
    settlement: null,
    responseStatus: null,
    retry: { signed: false, authorization: null, svm: null },
  });
  assert.deepEqual(w.accessed, [], "receipt を作るために署名者（address を含む）へ触っていない");
});

test("R4b 拒否（402 を読んだ後で止まった）→ receipt に 402 が提示した network・asset・payTo・amount が残る", async () => {
  const w = watchedAccount();
  const f = evmWorld({ paidAnswer: () => { throw new Error("must not be reached"); } });
  // 名乗りは $0.01、402 は 20000（$0.02）→ price_above_declared。
  const r = await payOrRefuse({ ...base, amountUsd: 0.01, account: w.account, fetch: f.fetch });
  assert.equal(r.status, "refused");
  assert.equal(r.receipt.reason_codes.includes("price_above_declared"), true);
  assert.equal(r.receipt.network, "eip155:8453");
  assert.equal(r.receipt.asset, BASE_USDC);
  assert.equal(r.receipt.payTo, PAYEE);
  assert.equal(r.receipt.amount, "20000");
  assert.equal(r.receipt.payer, null);
  assert.deepEqual(r.receipt.retry, { signed: false, authorization: null, svm: null });
  assert.deepEqual(w.accessed, []);
});

test("R4c 決定行の JSONL には receipt を足さない（0.7.0 の行の形のまま）", async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const store = join(mkdtempSync(join(tmpdir(), "vet402-receipt-")), "decisions.jsonl");
  const w = watchedAccount();
  const f = evmWorld({ paidAnswer: sellerSays({ success: true, transaction: "0xtx", network: "eip155:8453" }) });
  const r = await payOrRefuse({ ...base, account: w.account, fetch: f.fetch, decisionStore: store });
  assert.equal(r.stored, true);
  assert.ok(r.receipt, "結果には receipt がある");
  const row = JSON.parse(readFileSync(store, "utf8").trim());
  assert.equal("receipt" in row, false);
});

// ---------- Solana ----------

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const kp = (n) => Keypair.fromSeed(new Uint8Array(32).fill(n));
const SVM_PAYER = kp(1);
const SVM_PAYEE = kp(7).publicKey.toBase58();
const FEE_PAYER = kp(9).publicKey.toBase58();
const BLOCKHASH = kp(3).publicKey.toBase58();
const SVM_RESOURCE = "https://sol-seller.example/api/v1/price/sol";
const RPC_URL = "https://rpc.solana.example/";
const solAccept = { scheme: "exact", network: SOLANA_MAINNET, amount: "20000", asset: SOLANA_USDC, payTo: SVM_PAYEE, maxTimeoutSeconds: 60, extra: { feePayer: FEE_PAYER } };

function svmWorld({ paidAnswer }) {
  const calls = [];
  const sent = [];
  const fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.includes(DECISION)) return { ok: true, status: 200, json: async () => decisionBody(), headers: new Map() };
    if (u === RPC_URL) {
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } } }), headers: new Map() };
    }
    if (u.startsWith(SVM_RESOURCE)) {
      const raw = (init?.headers ?? {})["PAYMENT-SIGNATURE"];
      if (!raw) return { ok: false, status: 402, json: async () => ({}), headers: new Map([["payment-required", b64({ x402Version: 2, accepts: [solAccept] })]]) };
      sent.push(JSON.parse(atob(raw)).payload.transaction);
      return paidAnswer(init);
    }
    throw new Error(`forbidden call: ${u}`);
  };
  return { fetch, calls, sent };
}

function svmSigner() {
  const accessed = [];
  const account = new Proxy(
    { address: SVM_PAYER.publicKey.toBase58(), signTransaction: async (tx) => { tx.sign([SVM_PAYER]); return tx; } },
    { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } },
  );
  return { account, accessed };
}

const svmInput = (w, f) => ({ payee: SVM_PAYEE, resource: SVM_RESOURCE, amountUsd: 0.02, svm: { account: w.account, rpcUrl: RPC_URL }, fetch: f.fetch });

/** 送った取引が結果に残っていること。memo と blockhash が、その取引に実際に入っている値であること。 */
function assertSentTransactionKept(r, f) {
  assert.equal(f.sent.length, 1, "売り手へ署名つきで1回送っている");
  assert.equal(r.svmTransaction, f.sent[0], "送った取引そのものが結果に残る");
  assert.match(r.nonce, /^[0-9a-f]{32}$/);
  assert.deepEqual(r.receipt.retry.svm, { memo: r.nonce, recentBlockhash: BLOCKHASH, transaction: f.sent[0] });
  const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(r.svmTransaction), (c) => c.charCodeAt(0)));
  assert.equal(tx.message.recentBlockhash, r.receipt.retry.svm.recentBlockhash, "receipt の blockhash は取引の blockhash");
  const memoIx = tx.message.compiledInstructions.at(-1);
  assert.equal(new TextDecoder().decode(memoIx.data), r.nonce, "receipt の memo は取引の Memo 命令の中身");
  assert.equal(r.receipt.payer, SVM_PAYER.publicKey.toBase58());
  assert.equal(r.receipt.retry.signed, true);
  assert.equal(r.receipt.retry.authorization, null);
}

test("R5 Solana: 売り手が失敗と返した → receipt に memo・blockhash・送った取引・売り手の申告がそろう", async () => {
  const w = svmSigner();
  const f = svmWorld({ paidAnswer: () => ({ ok: false, status: 402, json: async () => ({}), headers: new Map([["PAYMENT-RESPONSE", b64({ success: false, errorReason: "insufficient_funds", network: SOLANA_MAINNET })]]) }) });
  const r = await payOrRefuse(svmInput(w, f));
  assert.equal(r.status, "failed");
  assert.equal(r.signed, true);
  assert.equal(r.receipt.endpoint, SVM_RESOURCE);
  assert.equal(r.receipt.network, SOLANA_MAINNET);
  assert.equal(r.receipt.asset, SOLANA_USDC);
  assert.equal(r.receipt.payTo, SVM_PAYEE);
  assert.equal(r.receipt.amount, "20000");
  assert.deepEqual(r.receipt.settlement, { success: false, transaction: null, network: SOLANA_MAINNET, payer: null, errorReason: "insufficient_funds" });
  assert.equal(r.receipt.responseStatus, 402);
  assertSentTransactionKept(r, f);
  assert.deepEqual(w.accessed.filter((k) => k.startsWith("sign")), ["signTransaction"], "署名者の sign* への参照は今までどおり1回");
});

test("R6 Solana: 送った後で fetch が undefined を返した（壊れた応答）→ failed・signed:true・送った取引が結果に残る", async () => {
  const w = svmSigner();
  const f = svmWorld({ paidAnswer: () => undefined });
  const r = await payOrRefuse(svmInput(w, f));
  assert.equal(r.status, "failed");
  assert.equal(r.signed, true);
  assert.equal(r.attested, false);
  assert.equal(r.txHash, null);
  assert.equal(r.decision.reason_codes.includes("settle_failed"), true);
  assert.notEqual(r.svmTransaction, null, "送った取引が結果から消えている");
  assertSentTransactionKept(r, f);
  assert.equal(r.receipt.settlement, null);
});

test("R7 Solana: 送った後で応答の headers を読むと throw する → failed・送った取引が結果に残る", async () => {
  const w = svmSigner();
  const f = svmWorld({ paidAnswer: () => ({ ok: true, status: 200, json: async () => ({}), get headers() { throw new Error("response headers unreadable"); } }) });
  const r = await payOrRefuse(svmInput(w, f));
  assert.equal(r.status, "failed");
  assert.equal(r.signed, true);
  assertSentTransactionKept(r, f);
});

test("R8 Solana: 再送の fetch が reject した → failed・送った取引が結果に残る（0.7.0 と同じ）", async () => {
  const w = svmSigner();
  const f = svmWorld({ paidAnswer: () => { throw new Error("ECONNRESET"); } });
  const r = await payOrRefuse(svmInput(w, f));
  assert.equal(r.status, "failed");
  assertSentTransactionKept(r, f);
});

test("R9 Solana: 署名者が別の取引を返した（送らない）→ svmTransaction は null のまま、receipt の transaction も null", async () => {
  const account = {
    address: SVM_PAYER.publicKey.toBase58(),
    // 最後の1バイトを変えた別物を返す（message は元のまま、serialize だけ別のバイト列）。
    signTransaction: async (tx) => {
      tx.sign([SVM_PAYER]);
      const bytes = tx.serialize();
      bytes[bytes.length - 1] ^= 0xff;
      return { serialize: () => bytes, message: tx.message };
    },
  };
  const f = svmWorld({ paidAnswer: () => { throw new Error("must not be reached"); } });
  const r = await payOrRefuse(svmInput({ account }, f));
  assert.equal(r.status, "failed");
  assert.equal(r.signed, true);
  assert.equal(f.sent.length, 0, "売り手へ送っていない");
  assert.equal(r.svmTransaction, null);
  assert.deepEqual(r.receipt.retry.svm, { memo: r.nonce, recentBlockhash: BLOCKHASH, transaction: null });
});

test("R10 Solana: 払えた → receipt の settlement は売り手の申告そのまま", async () => {
  const w = svmSigner();
  const sig = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
  const f = svmWorld({ paidAnswer: () => ({ ok: true, status: 200, json: async () => ({}), headers: new Map([["PAYMENT-RESPONSE", b64({ success: true, transaction: sig, network: SOLANA_MAINNET })]]) }) });
  const r = await payOrRefuse(svmInput(w, f));
  assert.equal(r.status, "paid");
  assert.equal(r.receipt.settlement.transaction, sig);
  assert.equal(r.receipt.settlement.success, true);
  assertSentTransactionKept(r, f);
});
