// ============================================================
// vet402 の API を呼ぶときだけ、SDK は自分の名前を名乗る（0.7.1）。
//
//   User-Agent: vet402-sdk/<版>
//
// サーバの受け皿は `src/lib/api/client-usage.ts` の DISTRIBUTED_CLIENTS（版は数字3組の semver）。
// 名乗る先は vet402 の API だけ:
//   - 名乗る   … VouchClient の全リクエスト、payOrRefuse の /decision・受取人スコア・attest
//   - 名乗らない … 売り手への要求（402 の取得・支払いつきの再送）、Solana の RPC
//     （売り手に vet402 の SDK だと知らせる必要は無く、0.7.0 までの要求の形を変えない）
// ブラウザ（navigator.userAgent が Mozilla/ で始まる）では付けない。ブラウザは User-Agent の上書きを
// 無視するか、CORS の事前確認（preflight）を増やすので、付けると今まで通っていた呼び出しが落ち得る。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { createVouchClient, payOrRefuse } from "../dist/index.js";
import { SDK_VERSION, SDK_USER_AGENT, clientIdentityHeaders } from "../dist/user-agent.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
/** サーバ側 `client-usage.ts` の VERSION_RE と同じ形（数字3組・各1〜3桁）。 */
const SERVER_ACCEPTS = /^vet402-sdk\/\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const EXPECTED_UA = `vet402-sdk/${pkg.version}`;

/** ヘッダ名の大小を問わず User-Agent を読む。無ければ undefined。 */
function userAgentOf(init) {
  const headers = init?.headers ?? {};
  const key = Object.keys(headers).find((k) => k.toLowerCase() === "user-agent");
  return key === undefined ? undefined : headers[key];
}

/** `navigator` を差し替えて body を走らせ、必ず元へ戻す。 */
async function withNavigator(value, body) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
  try {
    return await body();
  } finally {
    if (saved) Object.defineProperty(globalThis, "navigator", saved);
    else delete globalThis.navigator;
  }
}
const CHROME = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" };

test("U1 SDK_VERSION は package.json の version と同じで、サーバが版として読める形", () => {
  assert.equal(SDK_VERSION, pkg.version);
  assert.equal(SDK_USER_AGENT, EXPECTED_UA);
  assert.match(SDK_USER_AGENT, SERVER_ACCEPTS);
  assert.deepEqual(clientIdentityHeaders(), { "User-Agent": EXPECTED_UA });
});

// ---------- VouchClient ----------

function captureFetch(body = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, fetchFn };
}
const WALLET = "0x1111111111111111111111111111111111111111";

test("U2 VouchClient: resolve と getDecision は User-Agent: vet402-sdk/<版> を付ける（鍵なしでも・鍵つきでも）", async () => {
  for (const apiKey of [undefined, "vouch_live_test"]) {
    const { calls, fetchFn } = captureFetch();
    const vouch = createVouchClient({ ...(apiKey ? { apiKey } : {}), fetch: fetchFn });
    await vouch.resolve("https://api.example.com/v1/quote");
    await vouch.getDecision("a".repeat(64), { idempotencyKey: "req-1" });
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/resolve\?q=/);
    assert.match(calls[1].url, /\/resources\/a{64}\/decision\?/);
    for (const c of calls) assert.equal(userAgentOf(c.init), EXPECTED_UA, c.url);
    assert.equal("Authorization" in calls[0].init.headers, apiKey !== undefined, "鍵の有無の扱いは変わらない");
    assert.equal(calls[1].init.headers["Idempotency-Key"], "req-1", "ほかのヘッダはそのまま");
  }
});

test("U3 VouchClient: スコア・attest など vet402 の API へのほかの呼び出しにも付く", async () => {
  const { calls, fetchFn } = captureFetch({ ok: true });
  const vouch = createVouchClient({ apiKey: "vouch_live_test", fetch: fetchFn });
  await vouch.getPayeeScore(WALLET);
  await vouch.getWalletScore(WALLET);
  await vouch.attestX402Payment({ wallet: WALLET, txHash: `0x${"a".repeat(64)}` });
  assert.equal(calls.length, 3);
  for (const c of calls) assert.equal(userAgentOf(c.init), EXPECTED_UA, c.url);
  assert.equal(calls[2].init.headers["Content-Type"], "application/json");
});

test("U4 ブラウザ（navigator.userAgent が Mozilla/…）では User-Agent を付けない・呼び出しは今までどおり通る", async () => {
  await withNavigator(CHROME, async () => {
    assert.deepEqual(clientIdentityHeaders(), {});
    const { calls, fetchFn } = captureFetch();
    const vouch = createVouchClient({ fetch: fetchFn });
    await vouch.resolve("https://api.example.com/v1/quote");
    await vouch.getDecision("a".repeat(64));
    for (const c of calls) {
      assert.equal(userAgentOf(c.init), undefined, c.url);
      assert.deepEqual(c.init.headers, {}, "鍵なしのブラウザの呼び出しは、0.7.0 と同じくヘッダ無し");
    }
  });
});

test("U4b navigator が無い・壊れている・サーバ側ランタイムを名乗る環境では付ける", async () => {
  for (const nav of [undefined, null, {}, { userAgent: 5 }, { userAgent: "Node.js/22" }, { userAgent: "Cloudflare-Workers" }, { userAgent: "Deno/2.0.0" }]) {
    await withNavigator(nav, async () => {
      assert.deepEqual(clientIdentityHeaders(), { "User-Agent": EXPECTED_UA }, JSON.stringify(nav));
    });
  }
  // 読むと throw する navigator でも落ちない。
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { get() { throw new Error("no navigator here"); }, configurable: true });
  try {
    assert.deepEqual(clientIdentityHeaders(), { "User-Agent": EXPECTED_UA });
  } finally {
    if (saved) Object.defineProperty(globalThis, "navigator", saved);
    else delete globalThis.navigator;
  }
});

// ---------- payOrRefuse（0x の payee）----------

const PAYEE = "0x36038e1d712c5e39f35952164ec58ec2b96caee7";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RESOURCE = "https://kronossignals.com/api/v1/price/btc";
const b64 = (o) => btoa(JSON.stringify(o));
const okAccept = { scheme: "exact", network: "eip155:8453", amount: "20000", asset: BASE_USDC, payTo: PAYEE, extra: { assetTransferMethod: "eip3009" } };
const decisionBody = { recommendation: "ALLOW", reason_codes: ["l0_pass"], facts: { l1: { n_delivered: 3 } }, evidence: [], degraded: false };
const account = { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => "0xsig" };

/** 行き先ごとに、実際に出た要求（url と init）を記録する。 */
function evmWorld({ decision = { status: 200, body: decisionBody } } = {}) {
  const seen = { decision: [], score: [], attest: [], wall: [], paid: [], graph: [] };
  const answer = (status, body, headers = {}) => ({ ok: status < 400, status, json: async () => body, headers: new Map(Object.entries(headers)) });
  const fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/decision")) { seen.decision.push({ u, init }); return answer(decision.status, decision.body); }
    if (u.includes("/payees/")) { seen.score.push({ u, init }); return answer(200, { payee: PAYEE, score: 90, recommendation: "ALLOW", degraded: false, signalsUnavailable: [] }); }
    if (u.includes("/payments/x402")) { seen.attest.push({ u, init }); return answer(200, { ok: true }); }
    if (u.includes("gateway.thegraph.com")) { seen.graph.push({ u, init }); return answer(200, { data: { x402AddressSummaries: [{ role: "RECIPIENT", totalPayments: "253" }], _meta: { block: { number: 50890586 } } } }); }
    if (u.startsWith(RESOURCE)) {
      if (!(init?.headers ?? {})["PAYMENT-SIGNATURE"]) { seen.wall.push({ u, init }); return answer(402, {}, { "payment-required": b64({ x402Version: 2, accepts: [okAccept] }) }); }
      seen.paid.push({ u, init });
      return answer(200, {}, { "PAYMENT-RESPONSE": b64({ success: true, transaction: `0x${"b".repeat(64)}`, network: "eip155:8453" }) });
    }
    throw new Error(`forbidden call: ${u}`);
  };
  return { fetch, seen };
}

test("U5 payOrRefuse: /decision と attest には付け、売り手への要求（402 の取得・支払いつきの再送）には付けない", async () => {
  const f = evmWorld();
  const r = await payOrRefuse({ payee: PAYEE, resource: RESOURCE, amountUsd: 0.02, account, fetch: f.fetch, apiKey: "vouch_live_test" });
  assert.equal(r.status, "paid");
  assert.equal(r.attested, true);
  assert.equal(f.seen.decision.length, 1);
  assert.equal(userAgentOf(f.seen.decision[0].init), EXPECTED_UA);
  assert.equal(f.seen.decision[0].init.headers.Authorization, "Bearer vouch_live_test");
  assert.equal(f.seen.attest.length, 1);
  assert.equal(userAgentOf(f.seen.attest[0].init), EXPECTED_UA);
  assert.equal(f.seen.attest[0].init.headers["Content-Type"], "application/json");
  // 売り手への要求は 0.7.0 と同じ形のまま。
  assert.equal(f.seen.wall.length, 1);
  assert.deepEqual(f.seen.wall[0].init, { method: "GET" }, "402 の取得はヘッダ無し");
  assert.equal(f.seen.paid.length, 1);
  assert.deepEqual(Object.keys(f.seen.paid[0].init.headers).sort(), ["PAYMENT-SIGNATURE", "accept"], "再送のヘッダは accept と PAYMENT-SIGNATURE だけ");
  assert.equal(userAgentOf(f.seen.paid[0].init), undefined);
  assert.equal(JSON.stringify(f.seen.paid[0].init.headers).includes("vet402-sdk"), false);
  assert.equal(JSON.stringify(f.seen.wall[0].init).includes("vet402-sdk"), false);
});

test("U6 payOrRefuse: カタログ外の経路で引く受取人スコアにも付く（鍵なしなら Authorization は無い）", async () => {
  const f = evmWorld({ decision: { status: 404, body: { error: "not_found" } } });
  const r = await payOrRefuse({ payee: PAYEE, resource: RESOURCE, amountUsd: 0.02, account, fetch: f.fetch });
  assert.equal(r.status, "paid", r.decision.reason_codes.join(","));
  assert.equal(f.seen.score.length, 1);
  assert.deepEqual(f.seen.score[0].init.headers, { "User-Agent": EXPECTED_UA });
  assert.deepEqual(f.seen.decision[0].init.headers, { "User-Agent": EXPECTED_UA });
  assert.equal(userAgentOf(f.seen.paid[0].init), undefined);
});

test("U7 payOrRefuse: ブラウザでは vet402 の API にも付けない・支払いは今までどおり通る", async () => {
  await withNavigator(CHROME, async () => {
    const f = evmWorld();
    const r = await payOrRefuse({ payee: PAYEE, resource: RESOURCE, amountUsd: 0.02, account, fetch: f.fetch });
    assert.equal(r.status, "paid");
    assert.deepEqual(f.seen.decision[0].init.headers, {}, "鍵なしのブラウザの /decision は 0.7.0 と同じくヘッダ無し");
    assert.equal(userAgentOf(f.seen.attest[0].init), undefined);
    assert.equal(userAgentOf(f.seen.paid[0].init), undefined);
  });
});

// ---------- payOrRefuse（Solana の payee）----------

test("U8 Solana: /decision には付け、RPC と売り手への要求には付けない", async () => {
  const kp = (n) => Keypair.fromSeed(new Uint8Array(32).fill(n));
  const payer = kp(1);
  const payee = kp(7).publicKey.toBase58();
  const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
  const accept = { scheme: "exact", network: SOLANA_MAINNET, amount: "20000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo: payee, extra: { feePayer: kp(9).publicKey.toBase58() } };
  const resource = "https://sol-seller.example/api/v1/price/sol";
  const rpcUrl = "https://rpc.solana.example/";
  const seen = { decision: [], rpc: [], wall: [], paid: [] };
  const fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/decision")) { seen.decision.push(init); return { ok: true, status: 200, json: async () => decisionBody, headers: new Map() }; }
    if (u === rpcUrl) { seen.rpc.push(init); return { ok: true, status: 200, json: async () => ({ result: { value: { blockhash: kp(3).publicKey.toBase58() } } }), headers: new Map() }; }
    if (u.startsWith(resource)) {
      if (!(init?.headers ?? {})["PAYMENT-SIGNATURE"]) { seen.wall.push(init); return { ok: false, status: 402, json: async () => ({}), headers: new Map([["payment-required", b64({ x402Version: 2, accepts: [accept] })]]) }; }
      seen.paid.push(init);
      return { ok: true, status: 200, json: async () => ({}), headers: new Map([["PAYMENT-RESPONSE", b64({ success: true, transaction: "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW", network: SOLANA_MAINNET })]]) };
    }
    throw new Error(`forbidden call: ${u}`);
  };
  const r = await payOrRefuse({
    payee, resource, amountUsd: 0.02, fetch,
    svm: { account: { address: payer.publicKey.toBase58(), signTransaction: async (tx) => { tx.sign([payer]); return tx; } }, rpcUrl },
  });
  assert.equal(r.status, "paid", r.decision.reason_codes.join(","));
  assert.equal(userAgentOf(seen.decision[0]), EXPECTED_UA);
  assert.equal(seen.rpc.length, 1);
  assert.deepEqual(seen.rpc[0].headers, { "content-type": "application/json" }, "RPC への要求は 0.7.0 と同じ");
  assert.deepEqual(seen.wall[0], { method: "GET" });
  assert.deepEqual(Object.keys(seen.paid[0].headers).sort(), ["PAYMENT-SIGNATURE", "accept"]);
});
