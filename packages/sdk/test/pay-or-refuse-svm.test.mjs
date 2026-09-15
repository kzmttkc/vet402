// ============================================================
// payOrRefuse on Solana — 「払う前に確かめる」ゲートの Solana 版（2026-09-15）。
//
// 主張は EVM と同じ形で、数え方も同じ（pay-or-refuse.test.mjs の第1層・第2層）:
//   第1層: 署名者を Proxy で包み、`sign` で始まるプロパティ参照を数える。拒否では 0
//   第2層: fetch を許可リスト方式にし、RPC（blockhash）・attest・/payees/ への呼び出しを数える
//   第4層: ネガティブコントロール——同じハーネスで ALLOW を 1 本通し、signTransaction が
//          「ちょうど 1 回」、RPC が「ちょうど 1 回」出ることを示す（0 回が配線ミスでない証明）
// ALLOW で作った取引は @solana/web3.js で逆デシリアライズし、spec の MUST（命令 4 つ・宛先が
// ATA(payTo)・memo が nonce）を機械で見る。@solana/spl-token は正解の役（devDependency）。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as sdk from "../dist/index.js";

const { payOrRefuse, svmAccountFromKeypair } = sdk;

const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** 決定的な鍵（テストの再現性）。どれも曲線上の普通のウォレット。 */
const kp = (n) => Keypair.fromSeed(new Uint8Array(32).fill(n));
const PAYER = kp(1);
const PAYEE_KP = kp(7);
const FEE_PAYER_KP = kp(9);
const PAYEE = PAYEE_KP.publicKey.toBase58();
const FEE_PAYER = FEE_PAYER_KP.publicKey.toBase58();
const RESOURCE = "https://sol-seller.example/api/v1/price/sol";
const RPC_URL = "https://rpc.solana.example/";
const BLOCKHASH = kp(3).publicKey.toBase58();
const b64 = (o) => btoa(JSON.stringify(o));

/** 大文字小文字だけを 1 文字入れ替えた、base58 として正しい形のままの別文字列。 */
function caseFlipped(address) {
  const B58 = /[1-9A-HJ-NP-Za-km-z]/;
  for (let i = 0; i < address.length; i++) {
    const c = address[i];
    const flipped = c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase();
    if (flipped !== c && B58.test(flipped)) return address.slice(0, i) + flipped + address.slice(i + 1);
  }
  throw new Error("no flippable character");
}

const solAccept = (over = {}) => ({
  scheme: "exact",
  network: SOLANA_MAINNET,
  amount: "20000",
  asset: SOLANA_USDC,
  payTo: PAYEE,
  maxTimeoutSeconds: 60,
  extra: { feePayer: FEE_PAYER },
  ...over,
});
const baseAccept = { scheme: "exact", network: "eip155:8453", amount: "20000", asset: BASE_USDC, payTo: "0x36038e1d712c5e39f35952164ec58ec2b96caee7", extra: { assetTransferMethod: "eip3009" } };

const decisionBody = (over = {}) => ({
  subject: { type: "resource", id: "a".repeat(64) },
  role: "payer",
  recommendation: "ALLOW",
  reason_codes: ["l0_pass", "l1_delivered"],
  facts: { l0: { status: "pass" }, l1: { n_delivered: 3, n_attempts: 3 }, l2: { status: "undeclared" } },
  evidence: [{ level: "L1", source: "vet402", purchase_id: "solana:x", url: "https://vet402.com/observatory/e/x" }],
  degraded: false,
  policy: "allow_only",
  rules_version: "2026-09-02.1",
  ...over,
});

/** 署名者。`sign*` への参照を数える Proxy（第1層）。`returnTx` で「別の取引を返す」署名者を作れる。 */
function watchedSvmAccount({ keypair = PAYER, returnTx } = {}) {
  const accessed = [];
  const signedTxs = [];
  const target = {
    address: keypair.publicKey.toBase58(),
    signTransaction: async (tx) => {
      signedTxs.push(tx);
      if (returnTx) return returnTx(tx);
      tx.sign([keypair]);
      return tx;
    },
  };
  const account = new Proxy(target, { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } });
  return { account, signedTxs, signAccesses: () => accessed.filter((k) => k.startsWith("sign")) };
}

/**
 * 売り手・判定・RPC を 1 本の fetch で。**呼び出しは全部記録する**（許可されていない所へ出たら throw）。
 * 売り手は PAYMENT-SIGNATURE の有無で 402 と 200 を返し分ける。
 */
function harness({ decision = { status: 200, body: decisionBody() }, wall = { x402Version: 2, accepts: [solAccept()] }, settlement = { success: true, transaction: "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW", network: SOLANA_MAINNET }, rpc } = {}) {
  const calls = [];
  const paid = [];
  const fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? "GET" });
    if (u.includes("/decision")) {
      const d = typeof decision === "function" ? decision() : decision;
      return { ok: d.status < 400, status: d.status, json: async () => { if (d.nonJson) throw new SyntaxError("bad json"); return d.body; }, headers: new Map() };
    }
    if (u === RPC_URL) {
      if (rpc) return rpc(u, init);
      const req = JSON.parse(init.body);
      assert.equal(req.method, "getLatestBlockhash");
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: req.id, result: { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } } }), headers: new Map() };
    }
    if (u.startsWith(RESOURCE)) {
      const raw = (init?.headers ?? {})["PAYMENT-SIGNATURE"];
      if (!raw) return { ok: false, status: 402, json: async () => ({}), headers: new Map([["payment-required", b64(wall)]]) };
      paid.push(JSON.parse(atob(raw)));
      return { ok: true, status: 200, json: async () => ({ data: "ok" }), headers: new Map([["PAYMENT-RESPONSE", b64(settlement)]]) };
    }
    throw new Error(`forbidden call: ${u}`);
  };
  const count = (pred) => calls.filter(pred).length;
  return {
    fetch,
    calls,
    paid,
    rpcCalls: () => count((c) => c.url === RPC_URL),
    wallFetches: () => count((c) => c.url.startsWith(RESOURCE)),
    decisionCalls: () => count((c) => c.url.includes("/decision")),
    attestCalls: () => count((c) => c.url.includes("/payments/")),
    payeeScoreCalls: () => count((c) => c.url.includes("/payees/")),
  };
}

const svmInput = (w, h, over = {}) => ({
  payee: PAYEE,
  resource: RESOURCE,
  amountUsd: 0.02,
  svm: { account: w.account, rpcUrl: RPC_URL },
  fetch: h.fetch,
  ...over,
});

/** 拒否の共通検査: 署名参照 0・RPC 0・署名済み取引なし・nonce なし。 */
function assertRefusedBeforeSigning(r, w, h, label) {
  assert.equal(r.status, "refused", `${label}: ${JSON.stringify(r.decision.reason_codes)}`);
  assert.deepEqual(w.signAccesses(), [], `${label}: 署名者に触った`);
  assert.equal(h.rpcCalls(), 0, `${label}: RPC を引いた`);
  assert.equal(h.paid.length, 0, `${label}: 売り手へ再送した`);
  assert.equal(r.signed, false);
  assert.equal(r.nonce, null);
  assert.equal(r.svmTransaction, null);
  assert.equal(r.rail, "svm");
}

// ---------- S1〜S2: 判定 ----------

test("S1 /decision が BLOCK → payee_recommendation_block・署名参照 0・RPC 0・402 も取得しない", async () => {
  const w = watchedSvmAccount();
  const h = harness({ decision: { status: 200, body: decisionBody({ recommendation: "BLOCK", reason_codes: ["l1_never_delivered"] }) } });
  const r = await payOrRefuse(svmInput(w, h));
  assertRefusedBeforeSigning(r, w, h, "BLOCK");
  assert.ok(r.decision.reason_codes.includes("payee_recommendation_block"), r.decision.reason_codes.join(","));
  assert.ok(r.decision.reason_codes.includes("l1_never_delivered"), "サーバの語をそのまま通す");
  assert.equal(h.decisionCalls(), 1, "判定を 1 回引いている（配線の証明）");
  assert.equal(h.wallFetches(), 0, "402 を取得していない");
});

test("S1b BLOCK は requireVet402Allow:false ＋床を満たしていても拒否（免除の対象外）", async () => {
  const w = watchedSvmAccount();
  const h = harness({ decision: { status: 200, body: decisionBody({ recommendation: "BLOCK", reason_codes: [] }) } });
  const r = await payOrRefuse(svmInput(w, h, { policy: { requireVet402Allow: false, evidence: { minL1Deliveries: 1 } } }));
  assertRefusedBeforeSigning(r, w, h, "BLOCK waived");
  assert.ok(r.decision.reason_codes.includes("payee_recommendation_block"));
});

for (const [name, decision, word] of [
  ["WARN", { status: 200, body: decisionBody({ recommendation: "WARN", reason_codes: ["l1_not_attempted"] }) }, "payee_recommendation_not_allow"],
  ["degraded", { status: 200, body: decisionBody({ degraded: true }) }, "evidence_unavailable"],
  ["判定が読めない（非 JSON）", { status: 200, nonJson: true, body: null }, "evidence_unavailable"],
  ["判定が読めない（503）", { status: 503, body: { error: "unavailable" } }, "evidence_unavailable"],
]) {
  test(`S2 /decision が ${name} → 署名参照 0・RPC 0`, async () => {
    const w = watchedSvmAccount();
    const h = harness({ decision });
    const r = await payOrRefuse(svmInput(w, h));
    assertRefusedBeforeSigning(r, w, h, name);
    assert.ok(r.decision.reason_codes.includes(word), `${name}: ${r.decision.reason_codes.join(",")}`);
    assert.equal(h.wallFetches(), 0);
  });
}

// ---------- S3〜S6: 402 の照合 ----------

test("S3 402 の payTo が payee と大文字小文字だけ違う → payee_mismatch（base58 は大小を区別する）", async () => {
  const w = watchedSvmAccount();
  const flipped = caseFlipped(PAYEE);
  assert.notEqual(flipped, PAYEE);
  assert.equal(flipped.toLowerCase(), PAYEE.toLowerCase(), "違いは大文字小文字だけ");
  const h = harness({ wall: { x402Version: 2, accepts: [solAccept({ payTo: flipped })] } });
  const r = await payOrRefuse(svmInput(w, h));
  assertRefusedBeforeSigning(r, w, h, "case-flip");
  assert.ok(r.decision.reason_codes.includes("payee_mismatch"), r.decision.reason_codes.join(","));
  assert.equal(h.wallFetches(), 1, "402 を実際に読んだ上で落としている");
});

test("S4a Base が先頭・Solana が 2 番目でも Solana を選んで払う", async () => {
  const w = watchedSvmAccount();
  const h = harness({ wall: { x402Version: 2, accepts: [baseAccept, solAccept()] } });
  const r = await payOrRefuse(svmInput(w, h));
  assert.equal(r.status, "paid", r.decision.reason_codes.join(","));
  assert.equal(r.challenge.network, SOLANA_MAINNET);
  assert.equal(h.paid.length, 1);
  assert.equal(h.paid[0].accepted.network, SOLANA_MAINNET);
  assert.equal(w.signAccesses().length, 1);
});

test("S4b Base だけの 402 → no_eligible_accept ＋ chain_or_asset_mismatch・署名 0", async () => {
  const w = watchedSvmAccount();
  const h = harness({ wall: { x402Version: 2, accepts: [baseAccept] } });
  const r = await payOrRefuse(svmInput(w, h));
  assertRefusedBeforeSigning(r, w, h, "base-only");
  const words = r.decision.reason_codes;
  assert.ok(words.includes("no_eligible_accept") && words.includes("chain_or_asset_mismatch"), words.join(","));
  assert.ok(words.indexOf("no_eligible_accept") < words.indexOf("chain_or_asset_mismatch"), "一次の所見が先");
  assert.equal(words.includes("payee_mismatch"), false, "別レールの accept の payTo を照合しない");
});

test("S4c EVM の payee では、Solana が先頭でも従来どおり Base を選ぶ（レールは payee の形で決まる）", async () => {
  const evmPayee = baseAccept.payTo;
  const accessed = [];
  const account = new Proxy({ address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => "0xsig" }, { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } });
  const paid = [];
  const fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/decision")) return { ok: true, status: 200, json: async () => decisionBody(), headers: new Map() };
    if (u.startsWith(RESOURCE)) {
      const raw = (init?.headers ?? {})["PAYMENT-SIGNATURE"];
      if (!raw) return { ok: false, status: 402, json: async () => ({}), headers: new Map([["payment-required", b64({ x402Version: 2, accepts: [solAccept({ payTo: evmPayee }), baseAccept] })]]) };
      paid.push(JSON.parse(atob(raw)));
      return { ok: true, status: 200, json: async () => ({}), headers: new Map([["PAYMENT-RESPONSE", b64({ success: true, transaction: "0xtx", network: "eip155:8453" })]]) };
    }
    if (u.includes("/payments/")) return { ok: true, status: 200, json: async () => ({}), headers: new Map() };
    throw new Error(`forbidden: ${u}`);
  };
  const r = await payOrRefuse({ payee: evmPayee, resource: RESOURCE, amountUsd: 0.02, account, fetch });
  assert.equal(r.status, "paid");
  assert.equal(r.rail, "evm");
  assert.equal(r.svmTransaction, null);
  assert.equal(paid[0].accepted.network, "eip155:8453");
  assert.equal(accessed.filter((k) => k.startsWith("sign")).length, 1);
});

for (const [name, accept, version] of [
  ["mint 違い（Base USDC の 0x）", solAccept({ asset: BASE_USDC }), 2],
  ["mint 違い（別の base58 mint）", solAccept({ asset: kp(11).publicKey.toBase58() }), 2],
  ["network 違い（devnet）", solAccept({ network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" }), 2],
  ["feePayer なし", solAccept({ extra: {} }), 2],
  ["extra なし", (() => { const a = solAccept(); delete a.extra; return a; })(), 2],
  ["feePayer が base58 でない", solAccept({ extra: { feePayer: "0xDB62BD202914609830fA656F87996b91be3Aa673" } }), 2],
  ["feePayer が payTo と同じ", solAccept({ extra: { feePayer: PAYEE } }), 2],
  ["scheme が exact でない", solAccept({ scheme: "upto" }), 2],
  ["x402 v1 の壁", solAccept(), 1],
]) {
  test(`S5 ${name} → chain_or_asset_mismatch・署名 0・RPC 0`, async () => {
    const w = watchedSvmAccount();
    const h = harness({ wall: { x402Version: version, accepts: [accept] } });
    const r = await payOrRefuse(svmInput(w, h));
    assertRefusedBeforeSigning(r, w, h, name);
    assert.ok(r.decision.reason_codes.includes("chain_or_asset_mismatch"), `${name}: ${r.decision.reason_codes.join(",")}`);
    assert.equal(h.wallFetches(), 1, "402 を読んだ上で落としている");
  });
}

test("S5b v1 の \"solana\" スラグは CAIP-2 に正規化して読む（v1 なので払わないが、見た network は正規形）", async () => {
  const w = watchedSvmAccount();
  const h = harness({ wall: { x402Version: 1, accepts: [{ ...solAccept({ network: "solana" }), maxAmountRequired: "20000", amount: undefined }] } });
  const r = await payOrRefuse(svmInput(w, h));
  assertRefusedBeforeSigning(r, w, h, "v1 slug");
  assert.equal(r.challenge?.network, SOLANA_MAINNET);
});

test("S6a 402 の額が上限を超える → price_above_ceiling・署名 0", async () => {
  const w = watchedSvmAccount();
  const h = harness({ wall: { x402Version: 2, accepts: [solAccept({ amount: "1000001" })] } });
  const r = await payOrRefuse(svmInput(w, h, { amountUsd: 0.5 }));
  assertRefusedBeforeSigning(r, w, h, "ceiling");
  assert.ok(r.decision.reason_codes.includes("price_above_ceiling"), r.decision.reason_codes.join(","));
});

test("S6b 402 の額が名乗りを 1 単位超える → price_above_declared・署名 0", async () => {
  const w = watchedSvmAccount();
  const h = harness({ wall: { x402Version: 2, accepts: [solAccept({ amount: "20001" })] } });
  const r = await payOrRefuse(svmInput(w, h));
  assertRefusedBeforeSigning(r, w, h, "declared");
  assert.ok(r.decision.reason_codes.includes("price_above_declared"), r.decision.reason_codes.join(","));
});

test("S6c 名乗りが上限を超える → 判定も引かずに price_above_ceiling", async () => {
  const w = watchedSvmAccount();
  const h = harness();
  const r = await payOrRefuse(svmInput(w, h, { amountUsd: 2 }));
  assertRefusedBeforeSigning(r, w, h, "declared>ceiling");
  assert.ok(r.decision.reason_codes.includes("price_above_ceiling"));
  assert.equal(h.decisionCalls(), 0);
});

// ---------- S7〜S8 ----------

test("S7 /decision 404（カタログ外）→ resource_uncatalogued ＋ evidence_unavailable・402 も受取人スコアも引かない", async () => {
  const w = watchedSvmAccount();
  const h = harness({ decision: { status: 404, body: { error: "not_found" } } });
  const r = await payOrRefuse(svmInput(w, h));
  assertRefusedBeforeSigning(r, w, h, "uncatalogued");
  assert.ok(r.decision.reason_codes.includes("resource_uncatalogued"), r.decision.reason_codes.join(","));
  assert.ok(r.decision.reason_codes.includes("evidence_unavailable"));
  assert.equal(h.wallFetches(), 0);
  assert.equal(h.payeeScoreCalls(), 0, "受取人スコア API は base58 を 400 で返すので引かない");
});

for (const [name, over, pattern] of [
  ["evidence.source subgraph", { policy: { evidence: { source: "subgraph", minSubgraphReceipts: 1, graphApiKey: "k".repeat(32) } } }, /^invalid_evidence_policy:/],
  ["evidence.source both", { policy: { evidence: { source: "both", minL1Deliveries: 1, graphApiKey: "k".repeat(32) } } }, /^invalid_evidence_policy:/],
  ["svm 欠落（EVM の account だけ）", { svm: undefined, account: { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => "0x" } }, /^invalid_payer:/],
  ["svm も account も無い", { svm: undefined }, /^invalid_payer:/],
  ["svm.rpcUrl 欠落", "no-rpc", /^invalid_payer:/],
]) {
  test(`S8 Solana payee で ${name} → 通信 0 で throw`, async () => {
    const w = watchedSvmAccount();
    const h = harness();
    const input = over === "no-rpc" ? svmInput(w, h, { svm: { account: w.account } }) : svmInput(w, h, over);
    await assert.rejects(() => payOrRefuse(input), (e) => pattern.test(String(e?.message)));
    assert.equal(h.calls.length, 0, "通信していない");
    assert.deepEqual(w.signAccesses(), []);
  });
}

test("S8b 0x の payee に svm だけを渡す → 通信 0 で throw（EVM の経路に Solana の署名者を持ち込まない）", async () => {
  const w = watchedSvmAccount();
  const h = harness();
  await assert.rejects(
    () => payOrRefuse(svmInput(w, h, { payee: baseAccept.payTo })),
    (e) => /^invalid_payer:/.test(String(e?.message)),
  );
  assert.equal(h.calls.length, 0);
  assert.deepEqual(w.signAccesses(), []);
});

// ---------- S9: ALLOW ブランチ内の、署名前の拒否 ----------

test("S9 feePayer が署名者と同じ → ALLOW ブランチ内で拒否・署名 0・RPC 0", async () => {
  const w = watchedSvmAccount();
  const h = harness({ wall: { x402Version: 2, accepts: [solAccept({ extra: { feePayer: PAYER.publicKey.toBase58() } })] } });
  const r = await payOrRefuse(svmInput(w, h));
  assertRefusedBeforeSigning(r, w, h, "feePayer=signer");
  assert.ok(r.decision.reason_codes.includes("chain_or_asset_mismatch"), r.decision.reason_codes.join(","));
  assert.equal(h.wallFetches(), 1);
});

test("S9b payTo が曲線外（ATA を payTo に書いた壁）→ 署名 0・RPC 0", async () => {
  const w = watchedSvmAccount();
  const ata = getAssociatedTokenAddressSync(new PublicKey(SOLANA_USDC), PAYEE_KP.publicKey).toBase58();
  const h = harness({ wall: { x402Version: 2, accepts: [solAccept({ payTo: ata })] } });
  const r = await payOrRefuse(svmInput(w, h, { payee: ata }));
  assertRefusedBeforeSigning(r, w, h, "off-curve payTo");
  assert.ok(r.decision.reason_codes.includes("chain_or_asset_mismatch"), r.decision.reason_codes.join(","));
});

// ---------- S10: ネガティブコントロール ----------

test("S10 ALLOW → signTransaction ちょうど 1 回・RPC ちょうど 1 回・spec どおりの取引を売り手へ再送", async () => {
  const w = watchedSvmAccount();
  const h = harness();
  const r = await payOrRefuse(svmInput(w, h));
  assert.equal(r.status, "paid", r.decision.reason_codes.join(","));
  assert.equal(r.rail, "svm");
  assert.equal(w.signAccesses().length, 1, "sign* への参照がちょうど 1 回");
  assert.deepEqual(w.signAccesses(), ["signTransaction"]);
  assert.equal(h.rpcCalls(), 1, "blockhash の RPC がちょうど 1 回");
  assert.equal(h.paid.length, 1, "PAYMENT-SIGNATURE 付きの再送が 1 回");
  assert.equal(h.attestCalls(), 0, "attest の POST は 0（attest API は 0x の txHash しか受けない）");
  assert.equal(r.attested, false);
  assert.equal(r.signed, true);
  assert.equal(r.txHash, "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW");

  const envelope = h.paid[0];
  assert.equal(envelope.x402Version, 2);
  assert.equal(envelope.resource.url, RESOURCE);
  assert.equal(envelope.accepted.payTo, PAYEE);
  assert.equal(envelope.accepted.asset, SOLANA_USDC);
  assert.equal(r.svmTransaction, envelope.payload.transaction, "svmTransaction は再送した payload そのもの");

  const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(envelope.payload.transaction), (c) => c.charCodeAt(0)));
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  assert.equal(keys[0], FEE_PAYER, "feePayer は extra.feePayer");
  assert.equal(tx.message.recentBlockhash, BLOCKHASH, "RPC で引いた blockhash");
  const ix = tx.message.compiledInstructions;
  assert.equal(ix.length, 4, "命令は 4 つ");
  const program = (i) => keys[ix[i].programIdIndex];
  assert.equal(program(0), ComputeBudgetProgram.programId.toBase58());
  assert.equal(ix[0].data[0], 2, "SetComputeUnitLimit");
  assert.equal(program(1), ComputeBudgetProgram.programId.toBase58());
  assert.equal(ix[1].data[0], 3, "SetComputeUnitPrice");
  const price = new DataView(Uint8Array.from(ix[1].data).buffer).getBigUint64(1, true);
  assert.ok(price >= 1n && price <= 5n, `CU 価格は spec の ≤5: ${price}`);
  assert.equal(program(2), TOKEN_PROGRAM_ID.toBase58());
  assert.equal(ix[2].data[0], 12, "TransferChecked");
  const data = Uint8Array.from(ix[2].data);
  assert.equal(new DataView(data.buffer).getBigUint64(1, true), 20000n, "額は 402 の amount");
  assert.equal(data[9], 6, "decimals 6");
  const mint = new PublicKey(SOLANA_USDC);
  const [src, mintKey, dest, owner] = ix[2].accountKeyIndexes.map((i) => keys[i]);
  assert.equal(src, getAssociatedTokenAddressSync(mint, PAYER.publicKey).toBase58(), "送り元は ATA(payer)");
  assert.equal(mintKey, SOLANA_USDC);
  assert.equal(dest, getAssociatedTokenAddressSync(mint, PAYEE_KP.publicKey).toBase58(), "宛先は ATA(payTo)");
  assert.equal(owner, PAYER.publicKey.toBase58());
  assert.equal(program(3), MEMO_PROGRAM);
  const memo = new TextDecoder().decode(Uint8Array.from(ix[3].data));
  assert.match(memo, /^[0-9a-f]{32}$/, "memo は我々が作った 16 バイト");
  assert.equal(memo, r.nonce, "memo が nonce と一致");
  for (const i of ix) {
    assert.equal(i.accountKeyIndexes.includes(0), false, "feePayer はどの命令の accounts にも現れない");
  }
  const payerIndex = keys.indexOf(PAYER.publicKey.toBase58());
  assert.ok(payerIndex > 0 && payerIndex < tx.message.header.numRequiredSignatures, "payer は署名者");
  assert.ok(tx.signatures[payerIndex].some((b) => b !== 0), "payer の署名が入っている");
  assert.ok(tx.signatures[0].every((b) => b === 0), "feePayer の署名は空（ファシリテータが入れる）");

  assert.equal(r.decision.recommendation, "ALLOW");
  assert.equal(r.decision.verdict_source, "decision");
});

test("S10d 402 の額が名乗りより小さい → 取引の額は 402 の amount（名乗りの額では組まない）", async () => {
  const w = watchedSvmAccount();
  const h = harness({ wall: { x402Version: 2, accepts: [solAccept({ amount: "10000" })] } });
  const r = await payOrRefuse(svmInput(w, h, { amountUsd: 0.02 }));
  assert.equal(r.status, "paid", r.decision.reason_codes.join(","));
  const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(h.paid[0].payload.transaction), (c) => c.charCodeAt(0)));
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const transfer = tx.message.compiledInstructions.find((i) => keys[i.programIdIndex] === TOKEN_PROGRAM_ID.toBase58());
  assert.equal(new DataView(Uint8Array.from(transfer.data).buffer).getBigUint64(1, true), 10000n, "額は 402 の 10000（名乗りの 20000 ではない）");
  assert.equal(h.paid[0].accepted.amount, "10000");
});

test("E0 0x の payee で account を渡さない JS の呼び手: BLOCK なら 0.6.0 と同じく refused を返す（冒頭で throw しない）", async () => {
  const h = harness({ decision: { status: 200, body: decisionBody({ recommendation: "BLOCK", reason_codes: ["l1_never_delivered"] }) } });
  const r = await payOrRefuse({ payee: baseAccept.payTo, resource: RESOURCE, amountUsd: 0.02, fetch: h.fetch });
  assert.equal(r.status, "refused");
  assert.ok(r.decision.reason_codes.includes("payee_recommendation_block"));
  assert.equal(r.signed, false);
  assert.equal(r.rail, "evm");
});

test("S10b svmAccountFromKeypair は web3.js の Keypair から署名者を作り、そのまま払える", async () => {
  assert.equal(typeof svmAccountFromKeypair, "function");
  const account = svmAccountFromKeypair(PAYER);
  assert.equal(account.address, PAYER.publicKey.toBase58());
  const h = harness();
  const r = await payOrRefuse({ payee: PAYEE, resource: RESOURCE, amountUsd: 0.02, svm: { account, rpcUrl: RPC_URL }, fetch: h.fetch });
  assert.equal(r.status, "paid", r.decision.reason_codes.join(","));
  const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(r.svmTransaction), (c) => c.charCodeAt(0)));
  const payerIndex = tx.message.staticAccountKeys.findIndex((k) => k.equals(PAYER.publicKey));
  assert.ok(tx.signatures[payerIndex].some((b) => b !== 0));
});

test("S10c 公開の定数と型の入口（SOLANA_MAINNET / SOLANA_USDC）", () => {
  assert.equal(sdk.SOLANA_MAINNET, SOLANA_MAINNET);
  assert.equal(sdk.SOLANA_USDC, SOLANA_USDC);
});

// ---------- S11〜S13: 署名の後 ----------

test("S11 署名者が別の取引を返す → 再送しない（failed・signed:true・svmTransaction:null）", async () => {
  const w = watchedSvmAccount({
    returnTx: (tx) => {
      const other = TransactionMessage.decompile(tx.message);
      other.recentBlockhash = kp(4).publicKey.toBase58();
      const swapped = new VersionedTransaction(other.compileToV0Message());
      swapped.sign([PAYER]);
      return swapped;
    },
  });
  const h = harness();
  const r = await payOrRefuse(svmInput(w, h));
  assert.equal(r.status, "failed");
  assert.equal(r.signed, true, "署名者は値を返した。隠さない");
  assert.equal(h.paid.length, 0, "売り手へ送っていない");
  assert.equal(r.svmTransaction, null);
  assert.match(r.nonce, /^[0-9a-f]{32}$/);
  assert.equal(w.signAccesses().length, 1);
});

test("S11b message は元のまま、serialize だけ別の取引を返す値 → 再送しない", async () => {
  const w = watchedSvmAccount({
    returnTx: (tx) => {
      const other = TransactionMessage.decompile(tx.message);
      other.recentBlockhash = kp(5).publicKey.toBase58();
      const swapped = new VersionedTransaction(other.compileToV0Message());
      return { message: tx.message, serialize: () => swapped.serialize() };
    },
  });
  const h = harness();
  const r = await payOrRefuse(svmInput(w, h));
  assert.equal(r.status, "failed");
  assert.equal(h.paid.length, 0);
  assert.equal(r.svmTransaction, null);
});

test("S12 決済失敗（PAYMENT-RESPONSE success:false）→ failed・signed:true・memo を返す", async () => {
  const w = watchedSvmAccount();
  const h = harness({ settlement: { success: false, errorReason: "insufficient_funds", network: SOLANA_MAINNET } });
  const r = await payOrRefuse(svmInput(w, h));
  assert.equal(r.status, "failed");
  assert.equal(r.signed, true);
  assert.match(r.nonce, /^[0-9a-f]{32}$/, "memo を返す（遅れて決済され得る取引を照合するため）");
  assert.equal(h.paid.length, 1);
  assert.equal(r.svmTransaction, h.paid[0].payload.transaction, "何を送ったかも隠さない");
  assert.equal(r.attested, false);
  assert.equal(h.attestCalls(), 0);
  assert.ok(r.decision.reason_codes.includes("settle_failed"));
});

test("S13 RPC が blockhash を返さない → 署名の前に throw（金は動いていない）", async () => {
  const w = watchedSvmAccount();
  const h = harness({ rpc: () => ({ ok: false, status: 429, json: async () => ({ error: { code: 429 } }), headers: new Map() }) });
  await assert.rejects(() => payOrRefuse(svmInput(w, h)), /svm_rpc_unavailable/);
  assert.deepEqual(w.signAccesses(), []);
  assert.equal(h.paid.length, 0);
});

for (const [name, rpc] of [
  ["S13b RPC が HTTP 500 で blockhash の形の値を返す", () => ({ ok: false, status: 500, json: async () => ({ result: { value: { blockhash: BLOCKHASH } } }), headers: new Map() })],
  ["S13c RPC が base58 でない blockhash を返す", () => ({ ok: true, status: 200, json: async () => ({ result: { value: { blockhash: "not-a-blockhash!" } } }), headers: new Map() })],
]) {
  test(`${name} → 署名の前に svm_rpc_unavailable で throw`, async () => {
    const w = watchedSvmAccount();
    const h = harness({ rpc });
    await assert.rejects(() => payOrRefuse(svmInput(w, h)), /svm_rpc_unavailable/);
    assert.deepEqual(w.signAccesses(), []);
    assert.equal(h.paid.length, 0);
  });
}

// ---------- EVM の結果の形（加算のみ）----------

test("E1 EVM の結果は rail:\"evm\"・svmTransaction:null を足しただけ", async () => {
  const account = { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => "0xsig" };
  const fetch = async (url) => {
    if (String(url).includes("/decision")) return { ok: true, status: 200, json: async () => decisionBody({ recommendation: "WARN" }), headers: new Map() };
    throw new Error("unexpected");
  };
  const r = await payOrRefuse({ payee: baseAccept.payTo, resource: RESOURCE, amountUsd: 0.02, account, fetch });
  assert.equal(r.status, "refused");
  assert.equal(r.rail, "evm");
  assert.equal(r.svmTransaction, null);
});
