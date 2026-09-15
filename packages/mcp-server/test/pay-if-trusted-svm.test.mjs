// pay_if_trusted on Solana（2026-09-15）。SDK の pay-or-refuse-svm.test.mjs と同じ数え方を、MCP の橋に当てる:
// Solana と EVM の署名者を両方 Proxy で包み、`sign` で始まるプロパティ参照をそれぞれ数える。
//
//   M1 Solana の BLOCK → REFUSE・Solana / EVM の署名者とも参照 0
//   M2 Solana の ALLOW → PAID・Solana の署名者 1・EVM 0（ネガティブコントロール）
//   M3 base58 の payee で EVM の署名者しか無い → REFUSE（payer_not_configured）・参照 0
//   M4 スキーマ: 44 字の base58 と 0x は通り、45 字は落ちる（実プロセス・stdio）
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { payIfTrusted } from "../dist/pay-if-trusted.js";
import { payerConfiguredFor, resolveSvmPayer } from "../dist/payer.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
const kp = (n) => Keypair.fromSeed(new Uint8Array(32).fill(n));
const PAYER = kp(1);
const PAYEE = kp(7).publicKey.toBase58();
const FEE_PAYER = kp(9).publicKey.toBase58();
const RESOURCE = "https://sol-seller.example/api/v1/price/sol";
const RPC_URL = "https://rpc.solana.example/";
const BLOCKHASH = kp(3).publicKey.toBase58();
const b64 = (o) => btoa(JSON.stringify(o));
const SOL_ACCEPT = { scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", amount: "10000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: PAYEE, extra: { feePayer: FEE_PAYER } };

function watchedSigners() {
  const evmAccess = [];
  const svmAccess = [];
  const signer = new Proxy({ address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => "0xsig" }, { get: (t, p) => (evmAccess.push(String(p)), Reflect.get(t, p)) });
  const svmSigner = new Proxy(
    { address: PAYER.publicKey.toBase58(), signTransaction: async (tx) => { tx.sign([PAYER]); return tx; } },
    { get: (t, p) => (svmAccess.push(String(p)), Reflect.get(t, p)) },
  );
  const signs = (list) => list.filter((k) => k.startsWith("sign"));
  return { signer, svmSigner, evmSigns: () => signs(evmAccess), svmSigns: () => signs(svmAccess) };
}

const decision = (over = {}) => ({ recommendation: "ALLOW", reason_codes: ["l0_pass", "l1_delivered"], facts: { l1: { n_delivered: 3 } }, evidence: [], degraded: false, rules_version: "t", ...over });

function harness(body = decision()) {
  const paid = [];
  let rpc = 0;
  const fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/decision")) return { ok: true, status: 200, json: async () => body, headers: new Map() };
    if (u === RPC_URL) {
      rpc++;
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: { value: { blockhash: BLOCKHASH } } }), headers: new Map() };
    }
    if (u.startsWith(RESOURCE)) {
      const raw = (init?.headers ?? {})["PAYMENT-SIGNATURE"];
      if (!raw) return { ok: false, status: 402, json: async () => ({}), headers: new Map([["payment-required", b64({ x402Version: 2, accepts: [SOL_ACCEPT] })]]) };
      paid.push(JSON.parse(atob(raw)));
      return { ok: true, status: 200, json: async () => ({}), headers: new Map([["PAYMENT-RESPONSE", b64({ success: true, transaction: "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW" })]]) };
    }
    throw new Error(`forbidden call: ${u}`);
  };
  return { fetch, paid, rpcCalls: () => rpc };
}

const input = (w, h, over = {}) => ({
  resourceId: "a".repeat(64),
  signer: w.signer,
  svmSigner: w.svmSigner,
  solanaRpcUrl: RPC_URL,
  fetch: h.fetch,
  resource: RESOURCE,
  payee: PAYEE,
  amountUsd: 0.01,
  maxPerTxUsd: 1,
  ...over,
});

test("M1 Solana の BLOCK → REFUSE・Solana / EVM の署名者とも参照 0", async () => {
  const w = watchedSigners();
  const h = harness(decision({ recommendation: "BLOCK", reason_codes: ["l1_never_delivered"] }));
  const r = await payIfTrusted(input(w, h));
  assert.equal(r.decision, "REFUSE");
  assert.ok(r.refuse_reasons.includes("l1_never_delivered"), r.refuse_reasons.join(","));
  assert.deepEqual(w.svmSigns(), []);
  assert.deepEqual(w.evmSigns(), []);
  assert.equal(h.rpcCalls(), 0);
  assert.equal(h.paid.length, 0);
  assert.equal(r.nonce, null);
});

test("M1b Solana の BLOCK は requireVet402Allow:false でも SDK の段で拒否（署名者参照 0）", async () => {
  const w = watchedSigners();
  const h = harness(decision({ recommendation: "BLOCK", reason_codes: [] }));
  const r = await payIfTrusted(input(w, h, { policy: { requireVet402Allow: false, evidence: { minL1Deliveries: 1 } } }));
  assert.equal(r.decision, "REFUSE");
  assert.ok(r.refuse_reasons.includes("payee_recommendation_block"), r.refuse_reasons.join(","));
  assert.equal(r.decision_record?.recommendation, "REFUSE");
  assert.deepEqual(w.svmSigns(), []);
  assert.deepEqual(w.evmSigns(), []);
});

test("M2 Solana の ALLOW → PAID・Solana の署名者 1・EVM 0", async () => {
  const w = watchedSigners();
  const h = harness();
  const r = await payIfTrusted(input(w, h));
  assert.equal(r.decision, "PAID", r.refuse_reasons.join(","));
  assert.equal(r.safe_to_pay, true);
  assert.equal(w.svmSigns().length, 1);
  assert.deepEqual(w.evmSigns(), []);
  assert.equal(h.rpcCalls(), 1);
  assert.equal(h.paid.length, 1);
  assert.equal(r.attested, false, "Solana では attest しない");
  assert.match(r.nonce, /^[0-9a-f]{32}$/);
  const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(h.paid[0].payload.transaction), (c) => c.charCodeAt(0)));
  assert.equal(tx.message.staticAccountKeys[0].toBase58(), FEE_PAYER);
});

test("M2b 0x の payee は従来どおり EVM の署名者で払い、Solana の署名者には触らない", async () => {
  const w = watchedSigners();
  const evmPayee = "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB";
  const accept = { scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: evmPayee, extra: { assetTransferMethod: "eip3009" } };
  const fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/decision")) return { ok: true, status: 200, json: async () => decision(), headers: new Map() };
    if (u.startsWith(RESOURCE)) {
      if (!(init?.headers ?? {})["PAYMENT-SIGNATURE"]) return { ok: false, status: 402, json: async () => ({}), headers: new Map([["payment-required", b64({ x402Version: 2, accepts: [accept] })]]) };
      return { ok: true, status: 200, json: async () => ({}), headers: new Map([["PAYMENT-RESPONSE", b64({ success: true, transaction: "0xtx" })]]) };
    }
    if (u.includes("/payments/x402")) return { ok: true, status: 200, json: async () => ({}), headers: new Map() };
    throw new Error(`forbidden: ${u}`);
  };
  const r = await payIfTrusted({ ...input(w, { fetch }), payee: evmPayee });
  assert.equal(r.decision, "PAID");
  assert.equal(w.evmSigns().length, 1);
  assert.deepEqual(w.svmSigns(), []);
});

test("M3a base58 の payee で Solana の署名者が無い → 払える署名者なし（どちらの署名者にも触らない）", () => {
  const w = watchedSigners();
  assert.equal(payerConfiguredFor(PAYEE, w.signer, null), false, "EVM の署名者で Solana に払わない");
  assert.equal(payerConfiguredFor("0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB", null, w.svmSigner), false, "Solana の署名者で Base に払わない");
  assert.equal(payerConfiguredFor(PAYEE, null, w.svmSigner), true);
  assert.equal(payerConfiguredFor("0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB", w.signer, null), true);
  assert.equal(payerConfiguredFor(undefined, w.signer, null), true, "支払い先なしは従来どおり EVM の署名者で見る");
  assert.deepEqual(w.evmSigns(), []);
  assert.deepEqual(w.svmSigns(), []);
});

test("M3b resolveSvmPayer は鍵・RPC のどちらかが無ければ null、両方あれば base58 の署名者（鍵は JSON 配列 / base64）", async () => {
  assert.equal(await resolveSvmPayer(undefined, RPC_URL), null);
  assert.equal(await resolveSvmPayer(JSON.stringify([...PAYER.secretKey]), undefined), null);
  assert.equal(await resolveSvmPayer("not-a-key", RPC_URL), null);
  const fromJson = await resolveSvmPayer(JSON.stringify([...PAYER.secretKey]), RPC_URL);
  assert.equal(fromJson?.signer.address, PAYER.publicKey.toBase58());
  assert.equal(fromJson?.rpcUrl, RPC_URL);
  const fromB64 = await resolveSvmPayer(btoa(String.fromCharCode(...PAYER.secretKey)), RPC_URL);
  assert.equal(fromB64?.signer.address, PAYER.publicKey.toBase58());
});

// ---------- 実プロセス（stdio）----------

/** MCP サーバを子プロセスで起動し、上流 API と売り手はローカル HTTP で受ける。 */
async function callTool(args, extraEnv = {}, decisionBody = decision()) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    if (req.url.includes("/decision")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(decisionBody));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, VOUCH_API_URL: `${origin}/api/v1` };
  for (const k of ["VOUCH_API_KEY", "VOUCH_PAYER_PRIVATE_KEY", "VOUCH_SOLANA_PAYER_SECRET_KEY", "SOLANA_RPC_URL", "VOUCH_MAX_PER_TX_USD"]) delete env[k];
  Object.assign(env, extraEnv);
  const resolved = JSON.parse(JSON.stringify(args).replaceAll("__ORIGIN__", origin));
  const lines = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "pay_if_trusted", arguments: resolved } },
  ];
  const child = spawn(process.execPath, [join(PKG, "dist/index.js")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  child.stdin.write(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  try {
    const msg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`tools/call timed out\n${err}`)), 15_000);
      child.stdout.on("data", () => {
        for (const line of out.split("\n")) {
          try {
            const m = JSON.parse(line);
            if (m.id === 2) { clearTimeout(timer); resolve(m); }
          } catch { /* partial line */ }
        }
      });
    });
    return { msg, seen, origin };
  } finally {
    child.kill();
    server.close();
  }
}

/** 資金の無い使い捨ての EVM 鍵（表示しない）。viem が解決できる環境でだけ EVM の署名者が立つ。 */
const THROWAWAY_EVM_KEY = `0x${"11".repeat(32)}`;

test("M3c 実プロセス: EVM の鍵しか無いサーバで base58 の payee → REFUSE（payer_not_configured）・資源に一度も触れない", async () => {
  const args = { resourceId: "a".repeat(64), resource: "__ORIGIN__/seller/sol", payee: PAYEE, amountUsd: 0.01 };
  const { msg, seen } = await callTool(args, { VOUCH_PAYER_PRIVATE_KEY: THROWAWAY_EVM_KEY });
  const text = JSON.parse(msg.result.content[0].text);
  assert.equal(text.decision, "REFUSE", JSON.stringify(text));
  assert.ok(text.refuse_reasons.includes("payer_not_configured"), text.refuse_reasons.join(","));
  assert.equal(text.signed, false);
  assert.equal(text.nonce, null);
  assert.match(text.summary, /VOUCH_SOLANA_PAYER_SECRET_KEY/);
  assert.deepEqual(seen.filter((u) => u.startsWith("/seller")), [], "402 を取りに行っていない（支払い先を SDK へ渡していない）");
});

test("M3d 実プロセス（対照）: 同じ EVM の鍵で 0x の payee は payer_not_configured にならず、資源の 402 を読みに行く", async () => {
  const args = { resourceId: "a".repeat(64), resource: "__ORIGIN__/seller/evm", payee: "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB", amountUsd: 0.01 };
  const { msg, seen } = await callTool(args, { VOUCH_PAYER_PRIVATE_KEY: THROWAWAY_EVM_KEY });
  const text = JSON.parse(msg.result.content[0].text);
  assert.equal(text.refuse_reasons.includes("payer_not_configured"), false, `EVM の署名者が立っていない（viem が解決できない環境）: ${text.summary}`);
  assert.equal(seen.filter((u) => u.startsWith("/seller")).length, 1, "402 を取りに行った（ここで壁が無いので evidence_unavailable で止まる）");
  assert.equal(text.decision, "REFUSE");
  assert.equal(text.signed, false);
});

for (const [name, payee, ok] of [
  ["44 字の base58", "4".repeat(44), true],
  ["32 字の base58", "4".repeat(32), true],
  ["0x", "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB", true],
  ["45 字", "4".repeat(45), false],
  ["base58 に無い文字（0OIl）", "0OIl".repeat(10), false],
  ["ENS 名", "vitalik.eth", false],
]) {
  test(`M4 スキーマ: payee ${name} → ${ok ? "通る" : "落ちる"}`, async () => {
    // 判定は WARN にして、スキーマを通ったものが支払いへ進まずに REFUSE で返るようにする。
    const { msg } = await callTool({ resourceId: "a".repeat(64), payee }, {}, decision({ recommendation: "WARN", reason_codes: ["l1_thin"] }));
    const schemaRejected = msg.error !== undefined || (msg.result?.isError === true && /payee|invalid/i.test(msg.result.content?.[0]?.text ?? ""));
    if (ok) {
      assert.equal(schemaRejected, false, JSON.stringify(msg));
      assert.equal(JSON.parse(msg.result.content[0].text).decision, "REFUSE");
    } else {
      assert.equal(schemaRejected, true, JSON.stringify(msg));
    }
  });
}
