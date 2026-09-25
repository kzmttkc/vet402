// ETHGlobal Tokyo 2026 — B1 の red テスト: payOrRefuse 経由の ENSIP-29 段（段 2.5）・約束と 402 の照合・
// 署名直前の再検証・testnet の profile・D1-a の床・vet402 に届かないときの支払い（G1〜G10）。
// 正典: PLAN_v4.3 §3.3・§5（T01〜T28・T31〜T35・T39〜T48・T41b）。
// 規則: モジュールは各テストの中で await import する（先頭で静的 import しない）。期待は理由コードの中身で書く。
//       ENS は EnsRpc の偽物2つ、HTTP は許可リストの偽 fetch。ネットワークに出ない。
// 注（契約の仮置き・B3/B6 で実装に合わせて読む）:
//   - 支払いチェーンの受領の読み手は input.chainReader / input.chainReaderCrossCheck（PLAN_v3 §2.2）。
//     偽物は getLogs・getBlockNumber・getChainId を持つ。2系統の件数が違えば（片系統に canary が無ければ）読めない扱い。
//   - 決定行の ENS の内訳は形を決め打ちせず、JSON に "recovered" と expected のアドレスが出ることだけを見る。
import test from "node:test";
import assert from "node:assert/strict";

// ==== harness begin（ENS の偽物。同じ塊を tokyo の各テストファイルに写している。ネットワークに出ない）====
// 固定値は PLAN_v4.3 §2.1・§10.1。署名は anvil の既知鍵（#0 = K_atst・#1 = 2人目の attester・#2 = 差し替え後の鍵）。
// 16 進の正解は @ipld/dag-cbor@9.2.6 と viem で scratch に1回だけ作って貼った（依存には足さない）。
const UR = "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe";
const UH = "0x33f571aa8A160a21b877cF6E0Fb8806692b97DF5";
const ROOT = "0x9703DBD26dAB89504490994138cF2c575251a9cE";
const ROOT_OTHER = "0x1111111111111111111111111111111111111111";
const ZERO = "0x0000000000000000000000000000000000000000";
const W_ENS = "0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6";
const W_VET = "0x502B59FbfF30E21B02Ade06ed0328FE03B35b8e6";
const P_A = "0xC54403186Db35B9D92cc393Ae665D3960117ac14";
const R_VET = "0x3368219EDdFdd1faC6409Fb9A1b8bF7D21598391";
const P_AG1 = "0xd3F4818c0bB93e54780525b21380D44D6D06bcd6";
const ATST = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // anvil #0
const ATST2 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // anvil #1
const ROTATED = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // anvil #2
const NEW_OWNER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // anvil #3
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RESOURCE = "https://vet402.com/api/tokyo/seller"; // 約束の中の文字列（定数）。fetch は偽物にしか届かない
const T0 = 1790391600; // 2026-09-26T03:00:00Z
const KEY_OFFER = "x402-offer";
const KEY_ATST = "attestations[x402-offer][atst.vet402.eth]";
const KEY_ATST2 = "attestations[x402-offer][atst.second.eth]";
const KEY_EP = "agent-endpoint[x402]";
// §3.3.1 の逐語（266 バイト）。K1-04 の calls に入るのと同じ1行。
const OFFER = '{"v":1,"resource":"https://vet402.com/api/tokyo/seller","method":"GET","network":"eip155:84532","asset":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","amount":"10000","payTo":"0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6","output":{"required":["result","observed_at"]}}';
const OFFER_1CHAR = OFFER.replace('"amount":"10000"', '"amount":"10001"');
// seller-a.eth × W_ENS × x402-offer × OFFER × T0 を K_atst で署名した envelope（79 バイト）
const SIG_A = "0x87205543b9a015f7980b79f1af9c5f0fdeb1de3a21f8d0cb81faa5b2abf0f8eb0413aed2eba26a2f819465cea6bde352726f4bf63793656188f1bb65d3e94d1b1b";
const ENV_A_HEX = "0xda6174737483011a6ab73530584187205543b9a015f7980b79f1af9c5f0fdeb1de3a21f8d0cb81faa5b2abf0f8eb0413aed2eba26a2f819465cea6bde352726f4bf63793656188f1bb65d3e94d1b1b";
const ENV_A_B64 = "2mF0c3SDARpqtzUwWEGHIFVDuaAV95gLefGvnF8P3rHeOiH40MuB+qWyq/D46wQTrtLromovgZRlzqa941Jyb0v2N5NlYYjxu2XT6U0bGw==";
const DIGEST_A = "0x405d237f0be14ebe44664120a253086a370f0da77b85f14a5b07201b31df2624";
// 同じ payload を 2人目（anvil #1）が署名
const ENV_A2_HEX = "0xda6174737483011a6ab73530584134268c0adbdf4875b31c2d00acb160f27cf9fbf1b4ea6d4c0577cef9557dfe5807958f14357dcfe23d2e1a0fa750e264a49d02b683a6534a6cb3ff6fb4975f011c";
// seller-b.eth（n2）用に K_atst が署名した有効な envelope（約束は OFFER と同じ値）
const ENV_B_HEX = "0xda6174737483011a6ab7353058412b4893afbd572c15f9c647474703e40fa61a356b21c4cc7bb59b7329937b86c96106e9c1356ec32ca062083907cef37b0417c82dd00e62c54cbaed500ff7ec691b";
// JSON でない値に正しく署名したもの（T18）
const BAD_VALUE = "not-json{amount:10000}";
const ENV_BAD_HEX = "0xda6174737483011a6ab735305841a630e77301a67bd51b11c0a848e21f2e93e6a0b5e2401676f69cad07982d5fff3bc6d8cf88bebbea87307325504c63783b7144d92f2807dfd65da51811a889511b";

const lc = (a) => String(a).toLowerCase();
const hexBuf = (h) => (typeof h === "string" ? Buffer.from(h.replace(/^0x/, ""), "hex") : Buffer.from(h));
function dnsDecode(hex) {
  const b = hexBuf(hex); const out = []; let i = 0;
  while (i < b.length && b[i] !== 0) { const l = b[i]; out.push(b.subarray(i + 1, i + 1 + l).toString("utf8")); i += 1 + l; }
  return out.join(".");
}
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
function abiDyn(buf) { const pad = Math.ceil(buf.length / 32) * 32; return "0x" + word(32) + word(buf.length) + buf.toString("hex").padEnd(pad * 2, "0"); }
const abiString = (s) => abiDyn(Buffer.from(s, "utf8"));
const abiAddress = (a) => "0x" + lc(a).replace(/^0x/, "").padStart(64, "0");
function decodeCall(data) {
  const h = hexBuf(data).toString("hex"); const sel = h.slice(0, 8);
  if (sel === "59d1d43c") { // text(bytes32,string)
    const off = parseInt(h.slice(72, 136), 16); const at = 8 + off * 2; const len = parseInt(h.slice(at, at + 64), 16);
    return { kind: "text", key: Buffer.from(h.slice(at + 64, at + 64 + len * 2), "hex").toString("utf8") };
  }
  if (sel === "3b3b57de") return { kind: "addr" }; // addr(bytes32)
  if (sel === "f1cb7e06") return { kind: "addr", coinType: BigInt("0x" + h.slice(72, 136)) }; // addr(bytes32,uint256)
  return { kind: "unknown", sel };
}

/** 2系統が共有する「チェーンの状態」。テストごとに作り直す。 */
function ensWorld(over = {}) {
  return {
    chainId: 11155111, head: 11_800_000n, now: T0 + 60, lag: 12,
    rootUR: ROOT, rootUH: ROOT,
    owners: { "seller-a.eth": W_ENS, "seller-b.eth": W_ENS, "vet402.eth": W_VET, "agent-1.vet402.eth": W_VET },
    texts: {
      "seller-a.eth": { [KEY_OFFER]: OFFER, [KEY_ATST]: ENV_A_HEX, [KEY_EP]: RESOURCE },
      "seller-b.eth": { [KEY_OFFER]: OFFER, [KEY_ATST]: ENV_B_HEX, [KEY_EP]: RESOURCE },
    },
    addrs: { "atst.vet402.eth": ATST, "atst.second.eth": ATST2, "seller-a.eth": W_ENS, "seller-b.eth": W_ENS },
    resolvers: { "vet402.eth": R_VET, "atst.vet402.eth": R_VET, "agent-1.vet402.eth": P_AG1 },
    ...over,
  };
}

/**
 * EnsRpc の偽物（readContract・getBlock・getBlockNumber・getChainId の4つだけ。キャストしない）。
 * `chain` は値であってメソッドではない（§3.3.2 #7 の `clients.*.chain.id` の検査用）。
 * `p` はこの系統だけの差分（head・timestamp・texts・root・throw）。
 */
function fakeRpc(w, log, p = {}) {
  const textOf = (name, key) => {
    const o = p.texts?.[name];
    if (o && key in o) return o[key];
    return w.texts[name]?.[key] ?? "";
  };
  return {
    chain: { id: p.chainId ?? w.chainId },
    async readContract(a) {
      log.push({ fn: a.functionName, address: a.address, blockNumber: a.blockNumber, args: a.args });
      if (p.throwOn && p.throwOn(a)) throw new Error("fake rpc: connection reset");
      switch (a.functionName) {
        case "ROOT_REGISTRY":
          return lc(a.address) === lc(UR) ? (p.rootUR ?? w.rootUR) : (p.rootUH ?? w.rootUH);
        case "findExactOwner": {
          const name = dnsDecode(a.args[0]);
          const o = (p.owners ?? {})[name] ?? w.owners[name] ?? ZERO;
          w.lastOwner = o;
          return o;
        }
        case "findNearestOwner": {
          const name = dnsDecode(a.args[0]);
          const parent = name.split(".").slice(1).join(".");
          return w.owners[name] ?? w.owners[parent] ?? ZERO; // 親の持ち主を返す（使ったら負け・T14）
        }
        case "getState": {
          const o = w.lastOwner ?? ZERO;
          const st = o === ZERO ? 0 : 2;
          return Object.assign([1n, st, o, 1821178728n], { tokenId: 1n, status: st, latestOwner: o, expiry: 1821178728n });
        }
        case "resolve": {
          const name = dnsDecode(a.args[0]);
          const c = decodeCall(a.args[1]);
          const resolver = w.resolvers[name] ?? P_A;
          if (c.kind === "text") return [abiString(textOf(name, c.key)), resolver];
          if (c.kind === "addr") {
            const v = name in (p.addrs ?? {}) ? p.addrs[name] : w.addrs[name];
            if (c.coinType !== undefined) return [abiDyn(v ? hexBuf(v) : Buffer.alloc(0)), resolver];
            return [abiAddress(v ?? ZERO), resolver];
          }
          throw new Error(`fake rpc: unexpected resolve selector ${c.sel}`);
        }
        default:
          throw new Error(`fake rpc: unexpected readContract ${a.functionName}`);
      }
    },
    async getBlock(a = {}) {
      log.push({ fn: "getBlock", blockNumber: a.blockNumber });
      const head = p.head ?? w.head;
      const ts = BigInt(p.timestamp ?? (w.now - w.lag));
      return { number: a.blockNumber ?? head, timestamp: ts };
    },
    async getBlockNumber() { log.push({ fn: "getBlockNumber" }); return p.head ?? w.head; },
    async getChainId() { log.push({ fn: "getChainId" }); return p.chainId ?? w.chainId; },
  };
}

/** 別系統2つ。`log` は2系統の呼び出しを全部残す。 */
function ensClients(w, pp = {}, ps = {}) {
  const log = [];
  return { clients: { primary: fakeRpc(w, log, pp), secondary: fakeRpc(w, log, ps) }, log };
}
const ATST_CFG = { name: "atst.vet402.eth", address: ATST, recordKeys: ["x402-offer"] };
const ensPolicy = (w, over = {}) => ({ trustedAttesters: [ATST_CFG], now: () => w.now, ...over });
// checkEnsOffer が使う profile の2欄（§3.3.1: network と asset だけ）。
const PROFILE_SEPOLIA = { name: "base-sepolia", network: "eip155:84532", chainId: 84532, asset: USDC_SEPOLIA };
// ネットワークに出ない（実装が fetch を黙って掴んでもここで落ちる）。
const netGuard = { calls: [] };
globalThis.fetch = async (url) => { netGuard.calls.push(String(url)); throw new Error(`network forbidden in tokyo tests: ${String(url)}`); };
// ==== harness end ====

// ---- 小道具（支払い側） ----
const API = "https://api.vet402.test"; // 偽の apiUrl（定数）。届くのは下の偽 fetch だけ
const SEED_TX = "0x" + "5e".repeat(32);
const sdk = () => import("../../dist/index.js");

/** 署名者への「参照」を記録する Proxy（既存 pay-or-refuse.test.mjs の第1層と同じ考え方）。 */
function watchedAccount() {
  const accessed = [];
  const typed = [];
  const account = new Proxy(
    { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async (args) => { typed.push(args); return "0x" + "11".repeat(65); } },
    { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } },
  );
  return { account, typed, signAccesses: () => accessed.filter((k) => k.startsWith("sign")) };
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const ACCEPT_SEPOLIA = { scheme: "exact", network: "eip155:84532", amount: "10000", asset: USDC_SEPOLIA, payTo: W_ENS, extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" } };
const ACCEPT_BASE = { ...ACCEPT_SEPOLIA, network: "eip155:8453", asset: USDC_BASE, extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" } };
const decisionBody = (over = {}) => ({
  subject: { type: "resource", id: "b".repeat(64) }, role: "payer", recommendation: "ALLOW",
  reason_codes: ["l0_pass"], facts: { l0: { status: "pass" }, l1: { n_delivered: 0, n_attempts: 0 }, l2: { status: "undeclared" } },
  evidence: [], degraded: false, policy: "allow_only", rules_version: "2026-09-02.1", ...over,
});
function resp(r) {
  const headers = new Headers(r.headers ?? {});
  return {
    ok: r.status >= 200 && r.status < 300, status: r.status, headers,
    json: async () => { if (r.raw !== undefined) return JSON.parse(r.raw); return r.body; },
    text: async () => (r.raw !== undefined ? r.raw : JSON.stringify(r.body ?? null)),
  };
}
/**
 * 許可リストの偽 fetch。apiUrl（/decision など）と売り手（RESOURCE）だけに答え、他は throw。
 * decision: 応答 {status, body|raw} か Error（接続不能）か関数。accept: 402 に載せる accept。
 */
function router({ decision = { status: 200, body: decisionBody() }, accept = ACCEPT_SEPOLIA, onWall } = {}) {
  const calls = [];
  const paid = [];
  const fetch = async (url, init) => {
    const u = String(url);
    calls.push({ u, method: (init && init.method) || "GET" });
    if (u.startsWith(API)) {
      const d = typeof decision === "function" ? decision(u, init) : decision;
      if (d instanceof Error) throw d;
      if (!u.includes("/decision")) throw new Error(`unexpected api call: ${u}`);
      return resp(d);
    }
    if (u.startsWith(RESOURCE)) {
      const h = new Headers((init && init.headers) || {});
      const sig = h.get("PAYMENT-SIGNATURE") ?? h.get("X-PAYMENT");
      if (!sig) { if (onWall) onWall(); return resp({ status: 402, body: {}, headers: { "payment-required": b64({ x402Version: 2, accepts: [accept] }) } }); }
      paid.push(u);
      return resp({ status: 200, body: { result: "ok", observed_at: "2026-09-26T03:00:00Z" }, headers: { "PAYMENT-RESPONSE": b64({ success: true, transaction: "0x" + "ab".repeat(32), network: accept.network, payer: "0xDB62BD202914609830fA656F87996b91be3Aa673" }) } });
    }
    throw new Error(`forbidden call: ${u}`);
  };
  return {
    fetch, calls, paid,
    decisions: () => calls.filter((c) => c.u.startsWith(API) && c.u.includes("/decision")).length,
    api: () => calls.filter((c) => c.u.startsWith(API)).length,
    walls: () => calls.filter((c) => c.u.startsWith(RESOURCE)).length,
  };
}
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** 支払いチェーン（Base Sepolia）の受領の読み手の偽物。logs は payTo 宛ての USDC Transfer。 */
function chainReader({ logs = [seedLog()], throws = false } = {}) {
  const calls = [];
  return {
    calls,
    reader: {
      async getChainId() { calls.push("getChainId"); return 84532; },
      async getBlockNumber() { calls.push("getBlockNumber"); return 31_000_000n; },
      async getLogs(a) { calls.push("getLogs"); if (throws) throw new Error("fake chain rpc down"); return logs; },
    },
  };
}
function seedLog() {
  return { address: USDC_SEPOLIA, topics: [TRANSFER, abiAddress("0xDB62BD202914609830fA656F87996b91be3Aa673"), abiAddress(W_ENS)],
    data: "0x" + word(10000), transactionHash: SEED_TX, blockNumber: 30_999_000n, logIndex: 0,
    args: { from: "0xDB62BD202914609830fA656F87996b91be3Aa673", to: W_ENS, value: 10000n } };
}
/** 名前経路の入力（段 2.5 が通れば base-sepolia で払う形）。 */
function nameInput(w, f, acct, over = {}) {
  const { clients, log } = ensClients(w, over.pp, over.ps);
  const input = {
    payeeName: "seller-a.eth", network: "base-sepolia", resource: RESOURCE, method: "GET", amountUsd: 0.01,
    apiUrl: API, account: acct.account, fetch: f.fetch,
    ens: { clients, policy: over.ensPolicy ?? ensPolicy(w) },
    ...(over.input ?? {}),
  };
  return { input, log };
}
const codes = (r) => r.decision.reason_codes;
function refusedWith(r, code) {
  assert.equal(r.status, "refused", `refused のはず: ${r.status} ${JSON.stringify(r.decision && r.decision.reason_codes)}`);
  assert.equal(codes(r).includes(code), true, `reason_codes に ${code}: ${JSON.stringify(codes(r))}`);
}
/** ENS の段で止まった拒否の共通の形: /decision 0 本・署名者参照 0・local_policy。 */
function stoppedAtEns(r, f, acct, code) {
  refusedWith(r, code);
  assert.equal(f.decisions(), 0, "段 2.5 で止まれば /decision は 1 本も出ない");
  assert.equal(f.api(), 0, "vet402 の API に fetch 0");
  assert.equal(r.decision.verdict_source, "local_policy");
  assert.deepEqual(acct.signAccesses(), [], "署名者への参照 0");
  assert.equal(r.signed, false);
}
/** vet402 に届かない経路の床（G1〜G10・T39 の基本形）。 */
const unreachablePolicy = (over = {}) => ({ requireVet402Allow: false, evidence: { minEnsAttestations: 1, minChainReceipts: 1, ...over } });
const unreachable = () => new Error("connect ECONNREFUSED 127.0.0.1:443");
function withChain(input, primary = chainReader(), cross = chainReader()) {
  return { ...input, chainReader: primary.reader, chainReaderCrossCheck: cross.reader };
}

// ---- 段 2.5（ENSIP-29）----

test("T01 有効な証明（正の対照）→ ENS 段を通り /decision がちょうど1回・決定行に source:\"ens\" の行", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); const acct = watchedAccount(); const f = router();
  const { input } = nameInput(w, f, acct);
  const r = await payOrRefuse(input);
  assert.equal(f.decisions(), 1, "/decision はちょうど1回");
  assert.equal(codes(r).some((c) => c.startsWith("ens_")), false, JSON.stringify(codes(r)));
  const ensRow = r.decision.evidence.find((e) => e.source === "ens");
  assert.ok(ensRow, `evidence に source:"ens" の行: ${JSON.stringify(r.decision.evidence)}`);
  assert.equal(f.walls() >= 1, true, "ENS 段の後に 402 を取りに行っている");
  assert.equal(r.challenge && lc(r.challenge.payTo), lc(W_ENS));
  assert.deepEqual(netGuard.calls, []);
});

test("T02 約束を1文字変えた → REFUSE ens_attestation_signer_mismatch・決定行に recovered と expected・signer 参照 0", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); w.texts["seller-a.eth"][KEY_OFFER] = OFFER_1CHAR;
  const acct = watchedAccount(); const f = router();
  const r = await payOrRefuse(nameInput(w, f, acct).input);
  stoppedAtEns(r, f, acct, "ens_attestation_signer_mismatch");
  const row = JSON.stringify(r.decision);
  assert.match(row, /"recovered"/);
  assert.match(row, /"expected"/);
  assert.equal(lc(row).includes(lc(ATST)), true, "expected（K_atst）のアドレスが決定行に残る");
});

test("T03 vet402 に届かない＋1文字変えた → ens_attestation_signer_mismatch（evidence_unavailable を含まない）・apiUrl への fetch 0 回", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); w.texts["seller-a.eth"][KEY_OFFER] = OFFER_1CHAR;
  const acct = watchedAccount(); const f = router({ decision: unreachable() });
  const r = await payOrRefuse(nameInput(w, f, acct).input);
  stoppedAtEns(r, f, acct, "ens_attestation_signer_mismatch");
  assert.equal(codes(r).includes("evidence_unavailable"), false);
  assert.equal(f.calls.filter((c) => c.u.startsWith(API)).length, 0);
});

test("T04 持ち主が移った → REFUSE ens_attestation_signer_mismatch", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); w.owners["seller-a.eth"] = NEW_OWNER;
  const acct = watchedAccount(); const f = router();
  stoppedAtEns(await payOrRefuse(nameInput(w, f, acct).input), f, acct, "ens_attestation_signer_mismatch");
});

test("T05a 記録の切り離し（x402-offer・envelope・addr が空）→ REFUSE ens_offer_missing", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); w.texts["seller-a.eth"] = {}; delete w.addrs["seller-a.eth"];
  const acct = watchedAccount(); const f = router();
  stoppedAtEns(await payOrRefuse(nameInput(w, f, acct).input), f, acct, "ens_offer_missing");
});

test("T05b envelope だけ消えた → REFUSE ens_attestation_missing", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); w.texts["seller-a.eth"][KEY_ATST] = "";
  const acct = watchedAccount(); const f = router();
  stoppedAtEns(await payOrRefuse(nameInput(w, f, acct).input), f, acct, "ens_attestation_missing");
});

test("T06 他の名前の箱につなぐ（seller-b.eth の有効な組をそのまま返す）→ REFUSE ens_attestation_signer_mismatch", { skip: !process.env.TOKYO_OPT_LINK }, async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); w.texts["seller-a.eth"] = { ...w.texts["seller-b.eth"] };
  const acct = watchedAccount(); const f = router();
  stoppedAtEns(await payOrRefuse(nameInput(w, f, acct).input), f, acct, "ens_attestation_signer_mismatch");
});

test("T07 別の名前に写した envelope → REFUSE ens_attestation_signer_mismatch", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); w.texts["seller-b.eth"][KEY_ATST] = ENV_A_HEX;
  const acct = watchedAccount(); const f = router();
  const r = await payOrRefuse(nameInput(w, f, acct, { input: { payeeName: "seller-b.eth" } }).input);
  stoppedAtEns(r, f, acct, "ens_attestation_signer_mismatch");
});

test("T08 attester が鍵を替えた → REFUSE ens_attester_unpinned（署名の比較まで進まない）", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); w.addrs["atst.vet402.eth"] = ROTATED;
  const acct = watchedAccount(); const f = router();
  const r = await payOrRefuse(nameInput(w, f, acct).input);
  stoppedAtEns(r, f, acct, "ens_attester_unpinned");
  assert.equal(codes(r).includes("ens_attestation_signer_mismatch"), false);
});

test("T09 attester 名に addr が無い → REFUSE ens_attester_unresolved", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); delete w.addrs["atst.vet402.eth"];
  const acct = watchedAccount(); const f = router();
  stoppedAtEns(await payOrRefuse(nameInput(w, f, acct).input), f, acct, "ens_attester_unresolved");
});

test("T10 信頼していない attester だけ → REFUSE ens_attestation_missing", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); delete w.texts["seller-a.eth"][KEY_ATST];
  w.texts["seller-a.eth"]["attestations[x402-offer][evil.eth]"] = ENV_A_HEX; w.addrs["evil.eth"] = ATST;
  const acct = watchedAccount(); const f = router();
  stoppedAtEns(await payOrRefuse(nameInput(w, f, acct).input), f, acct, "ens_attestation_missing");
});

test("T11 別の種類だけを信じる attester → REFUSE ens_attestation_missing", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); const acct = watchedAccount(); const f = router();
  const ensPol = ensPolicy(w, { trustedAttesters: [
    { name: "atst.vet402.eth", address: ATST, recordKeys: ["com.x"] },
    { name: "atst.second.eth", address: ATST2, recordKeys: ["x402-offer"] },
  ] });
  stoppedAtEns(await payOrRefuse(nameInput(w, f, acct, { ensPolicy: ensPol }).input), f, acct, "ens_attestation_missing");
});

test("T12 古い証明 → REFUSE ens_attestation_stale", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld({ now: T0 + 86_401 }); const acct = watchedAccount(); const f = router();
  stoppedAtEns(await payOrRefuse(nameInput(w, f, acct).input), f, acct, "ens_attestation_stale");
});

test("T13 未来の証明（t = now + 301）→ REFUSE ens_attestation_stale", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld({ now: T0 - 301 }); const acct = watchedAccount(); const f = router();
  stoppedAtEns(await payOrRefuse(nameInput(w, f, acct).input), f, acct, "ens_attestation_stale");
});

test("T14 未登録・RESERVED・wildcard のサブ名 → REFUSE ens_name_unresolved・findNearestOwner 0 回", async () => {
  const { payOrRefuse } = await sdk();
  for (const name of ["seller-z.eth", "reserved-name.eth", "x.seller-a.eth"]) {
    const w = ensWorld(); w.texts[name] = { ...w.texts["seller-a.eth"] };
    const acct = watchedAccount(); const f = router();
    const { input, log } = nameInput(w, f, acct, { input: { payeeName: name } });
    stoppedAtEns(await payOrRefuse(input), f, acct, "ens_name_unresolved");
    assert.equal(log.filter((c) => c.fn === "findNearestOwner").length, 0, name);
  }
});

test("T15 2系統の値が違う → REFUSE ens_evidence_unavailable＋evidence_unavailable", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); const acct = watchedAccount(); const f = router();
  const r = await payOrRefuse(nameInput(w, f, acct, { ps: { texts: { "seller-a.eth": { [KEY_OFFER]: OFFER_1CHAR } } } }).input);
  stoppedAtEns(r, f, acct, "ens_evidence_unavailable");
  assert.equal(codes(r).includes("evidence_unavailable"), true);
});

test("T16 head が古い／2系統の head が 4 ブロック離れている → 各 REFUSE ens_evidence_unavailable", async () => {
  const { payOrRefuse } = await sdk();
  const w1 = ensWorld(); const a1 = watchedAccount(); const f1 = router();
  stoppedAtEns(await payOrRefuse(nameInput(w1, f1, a1, { pp: { timestamp: w1.now - 600 }, ps: { timestamp: w1.now - 600 } }).input), f1, a1, "ens_evidence_unavailable");
  const w2 = ensWorld(); const a2 = watchedAccount(); const f2 = router();
  stoppedAtEns(await payOrRefuse(nameInput(w2, f2, a2, { ps: { head: w2.head - 4n } }).input), f2, a2, "ens_evidence_unavailable");
});

test("T17 RPC が落ちた → REFUSE ens_evidence_unavailable・x402-pay.js 未評価（署名者参照 0）", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); const acct = watchedAccount(); const f = router();
  const r = await payOrRefuse(nameInput(w, f, acct, { pp: { throwOn: (a) => a.functionName === "resolve" } }).input);
  stoppedAtEns(r, f, acct, "ens_evidence_unavailable");
  assert.equal(f.walls(), 0);
});

test("T18 約束が壊れている（証明は有効）→ REFUSE ens_offer_malformed", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); w.texts["seller-a.eth"][KEY_OFFER] = BAD_VALUE; w.texts["seller-a.eth"][KEY_ATST] = ENV_BAD_HEX;
  const acct = watchedAccount(); const f = router();
  stoppedAtEns(await payOrRefuse(nameInput(w, f, acct).input), f, acct, "ens_offer_malformed");
});

test("T19 agent-endpoint[x402] が約束と違う → REFUSE ens_offer_mismatch", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); w.texts["seller-a.eth"][KEY_EP] = "https://vet402.com/api/tokyo/sellet";
  const acct = watchedAccount(); const f = router();
  stoppedAtEns(await payOrRefuse(nameInput(w, f, acct).input), f, acct, "ens_offer_mismatch");
});

test("T20 呼び手の resource が約束と違う → REFUSE ens_offer_mismatch・402 への fetch 0", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); const acct = watchedAccount(); const f = router();
  const r = await payOrRefuse(nameInput(w, f, acct, { input: { resource: RESOURCE + "?x=1" } }).input);
  stoppedAtEns(r, f, acct, "ens_offer_mismatch");
  assert.equal(f.walls(), 0, "402 を取りに行っていない");
});

async function offerVs402(accept, word) {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); const acct = watchedAccount(); const f = router({ accept });
  const r = await payOrRefuse(nameInput(w, f, acct).input);
  refusedWith(r, "ens_offer_mismatch");
  assert.equal(codes(r).includes(word), true, `具体の語 ${word} を消さない: ${JSON.stringify(codes(r))}`);
  assert.equal(codes(r).indexOf("ens_offer_mismatch") < codes(r).indexOf(word), true, "ens_offer_mismatch を先頭側に足す");
  assert.equal(f.walls(), 1, "402 は読んだ");
  assert.deepEqual(acct.signAccesses(), [], "署名前に止まる");
  assert.equal(f.paid.length, 0);
}
test("T21 402 の payTo が約束と違う → REFUSE ens_offer_mismatch＋payee_mismatch・署名前", async () => {
  await offerVs402({ ...ACCEPT_SEPOLIA, payTo: NEW_OWNER }, "payee_mismatch");
});
test("T22 402 の額が約束と違う → REFUSE ens_offer_mismatch＋price_above_declared・署名前", async () => {
  await offerVs402({ ...ACCEPT_SEPOLIA, amount: "20000" }, "price_above_declared");
});
test("T23 402 のチェーン・資産が約束と違う → REFUSE ens_offer_mismatch＋chain_or_asset_mismatch・署名前", async () => {
  await offerVs402({ ...ACCEPT_SEPOLIA, asset: USDC_BASE }, "chain_or_asset_mismatch");
});

test("T24 閾値 2 で片方欠ける → REFUSE ens_attestation_missing", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); const acct = watchedAccount(); const f = router();
  const ensPol = ensPolicy(w, { minValid: 2, trustedAttesters: [ATST_CFG, { name: "atst.second.eth", address: ATST2, recordKeys: ["x402-offer"] }] });
  stoppedAtEns(await payOrRefuse(nameInput(w, f, acct, { ensPolicy: ensPol }).input), f, acct, "ens_attestation_missing");
});

test("T25 読みと署名の間に変わった（1回目有効・再検証で v が変わる）→ REFUSE ens_attestation_signer_mismatch・x402-pay.js 未評価", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); const acct = watchedAccount();
  // 402 を取りに来た時点（段 2.5 の後・再検証の前）で約束を1文字変える
  const f = router({ onWall: () => { w.texts["seller-a.eth"][KEY_OFFER] = OFFER_1CHAR; } });
  const r = await payOrRefuse(nameInput(w, f, acct).input);
  refusedWith(r, "ens_attestation_signer_mismatch");
  assert.equal(f.decisions(), 1, "1回目の ENS 段は通っている");
  assert.equal(f.walls(), 1);
  assert.deepEqual(acct.signAccesses(), [], "署名者への参照 0（x402-pay.js まで行っていない）");
  assert.equal(f.paid.length, 0);
});

test("T26 ENS の拒否は免除できない（T02 ＋ requireVet402Allow:false と床）→ REFUSE ens_attestation_signer_mismatch・allowed_by_caller_policy を含まない", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); w.texts["seller-a.eth"][KEY_OFFER] = OFFER_1CHAR;
  const acct = watchedAccount(); const f = router();
  const { input } = nameInput(w, f, acct, { input: { policy: unreachablePolicy() } });
  const r = await payOrRefuse(withChain(input));
  stoppedAtEns(r, f, acct, "ens_attestation_signer_mismatch");
  assert.equal(codes(r).includes("allowed_by_caller_policy"), false);
  assert.equal(r.decision.policy_override, null);
});

test("T27 呼び出し側エラー（7枝）→ 各 throw・RPC 0・fetch 0", async () => {
  const { payOrRefuse } = await sdk();
  const cases = [
    ["payeeName だけ（ens なし）", (i) => { delete i.ens; }, "invalid_ens_config"],
    ["空白を含む名前", (i) => { i.payeeName = "seller a.eth"; }, "invalid_payee_name"],
    ["network:base ＋ payeeName", (i) => { i.network = "base"; }, "invalid_ens_chain"],
    ["trustedAttesters:[]", (i) => { i.ens.policy = { ...i.ens.policy, trustedAttesters: [] }; }, "invalid_attestation_policy"],
    ["minValid:3（信頼2）", (i) => { i.ens.policy = { ...i.ens.policy, minValid: 3, trustedAttesters: [ATST_CFG, { name: "atst.second.eth", address: ATST2, recordKeys: ["x402-offer"] }] }; }, "invalid_attestation_policy"],
    ["maxAgeSeconds:10", (i) => { i.ens.policy = { ...i.ens.policy, maxAgeSeconds: 10 }; }, "invalid_attestation_policy"],
    ["network:sepolia", (i) => { i.network = "sepolia"; }, "invalid_network"],
  ];
  for (const [label, mutate, code] of cases) {
    const w = ensWorld(); const acct = watchedAccount(); const f = router();
    const { input, log } = nameInput(w, f, acct);
    mutate(input);
    await assert.rejects(() => payOrRefuse(input), (e) => String(e && e.message).startsWith(code), `${label} → ${code}`);
    assert.equal(log.length, 0, `${label}: RPC 0`);
    assert.equal(f.calls.length, 0, `${label}: fetch 0`);
    assert.deepEqual(acct.signAccesses(), []);
  }
});

test("T28 payee と約束の payTo が違う → REFUSE payee_mismatch・/decision 0 本", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); const acct = watchedAccount(); const f = router();
  const r = await payOrRefuse(nameInput(w, f, acct, { input: { payee: "0x" + "a".repeat(40) } }).input);
  stoppedAtEns(r, f, acct, "payee_mismatch");
});

// ---- testnet の profile（B3）----

test("T31 testnet の正の対照 → signTypedData 1回・domain は Base Sepolia USDC・/payments/x402 への POST 0", { skip: !process.env.TOKYO_OPT_TESTNET_PAY }, async () => {
  const { payOrRefuse } = await sdk();
  const acct = watchedAccount(); const f = router();
  const r = await payOrRefuse({ payee: W_ENS, network: "base-sepolia", resource: RESOURCE, amountUsd: 0.01, apiUrl: API, account: acct.account, fetch: f.fetch });
  assert.equal(r.status, "paid", JSON.stringify(codes(r)));
  assert.equal(acct.typed.length, 1);
  assert.equal(acct.signAccesses().filter((k) => k === "signTypedData").length, 1);
  const d = acct.typed[0].domain;
  assert.equal(d.name, "USDC"); assert.equal(d.version, "2"); assert.equal(Number(d.chainId), 84532);
  assert.equal(lc(d.verifyingContract), lc(USDC_SEPOLIA));
  assert.equal(f.calls.filter((c) => c.u.includes("/payments/x402")).length, 0, "testnet は本番台帳へ attest しない");
  assert.equal(r.attested, false);
});

test("T32 profile の取り違え（4枝と期待を1対1）", { skip: !process.env.TOKYO_OPT_TESTNET_PAY }, async () => {
  const { payOrRefuse } = await sdk();
  const run = async (network, accept) => {
    const acct = watchedAccount(); const f = router({ accept });
    const payee = accept.payTo;
    const r = await payOrRefuse({ payee, network, resource: RESOURCE, amountUsd: 0.01, apiUrl: API, account: acct.account, fetch: f.fetch });
    return { r, acct };
  };
  // (a) testnet の呼び手に本番 Base の 402
  let x = await run("base-sepolia", { ...ACCEPT_BASE, payTo: W_ENS });
  assert.deepEqual(codes(x.r), ["no_eligible_accept", "chain_or_asset_mismatch"]);
  // (b) 既定（base）の呼び手に testnet の 402
  x = await run("base", ACCEPT_SEPOLIA);
  assert.deepEqual(codes(x.r), ["no_eligible_accept", "chain_or_asset_mismatch"]);
  // (c) network は合うが asset が本番 USDC
  x = await run("base-sepolia", { ...ACCEPT_SEPOLIA, asset: USDC_BASE });
  assert.deepEqual(codes(x.r), ["no_eligible_accept", "chain_or_asset_mismatch"]); // 本番 Base と同じ語（払える形が1件も無い）
  // (d) EIP-712 domain の取り違え（両方向）→ 署名者参照 0。profile で違うのは name（Base "USD Coin"／Base Sepolia "USDC"）。
  //     verifyingContract は x402 の extra の欄ではなく、SDK は accept.asset で署名する。
  x = await run("base-sepolia", { ...ACCEPT_SEPOLIA, extra: { ...ACCEPT_SEPOLIA.extra, name: "USD Coin" } });
  assert.deepEqual(codes(x.r), ["chain_or_asset_mismatch"]);
  assert.deepEqual(x.acct.signAccesses(), []);
  x = await run("base", { ...ACCEPT_BASE, extra: { ...ACCEPT_BASE.extra, name: "USDC" } });
  assert.deepEqual(codes(x.r), ["chain_or_asset_mismatch"]);
  assert.deepEqual(x.acct.signAccesses(), []);
});

test("T33 D1-a の床（minChainReceipts:1）: 0 件／reader が throw／片系統に canary なし", { skip: !process.env.TOKYO_OPT_TESTNET_PAY }, async () => {
  const { payOrRefuse } = await sdk();
  const run = async (primary, cross) => {
    const acct = watchedAccount(); const f = router();
    const r = await payOrRefuse({ payee: W_ENS, network: "base-sepolia", resource: RESOURCE, amountUsd: 0.01, apiUrl: API,
      account: acct.account, fetch: f.fetch, policy: { requireVet402Allow: false, evidence: { minChainReceipts: 1 } },
      chainReader: primary.reader, chainReaderCrossCheck: cross.reader });
    assert.deepEqual(acct.signAccesses(), []);
    return r;
  };
  let r = await run(chainReader({ logs: [] }), chainReader({ logs: [] }));
  refusedWith(r, "insufficient_chain_evidence");
  r = await run(chainReader({ throws: true }), chainReader());
  refusedWith(r, "evidence_unavailable"); refusedWith(r, "chain_evidence_unavailable");
  r = await run(chainReader(), chainReader({ logs: [] }));
  refusedWith(r, "evidence_unavailable"); refusedWith(r, "chain_evidence_unavailable");
  // 本番 Base では床として使えない（通信の前に throw・署名者参照 0）
  const acct = watchedAccount(); const f = router();
  await assert.rejects(
    payOrRefuse({ payee: W_ENS, network: "base", resource: RESOURCE, amountUsd: 0.01, apiUrl: API, account: acct.account, fetch: f.fetch,
      policy: { requireVet402Allow: false, evidence: { minChainReceipts: 1 } }, chainReader: chainReader().reader, chainReaderCrossCheck: chainReader().reader }),
    /invalid_evidence_policy: evidence\.minChainReceipts is limited to network "base-sepolia"/,
  );
  assert.deepEqual(acct.signAccesses(), []);
});

// ---- 補助の走査・親名の固定（切り捨て対象）----

test("T34 補助の走査（3枝）→ 各 REFUSE ens_record_changed_after_attestation（オフなら ENS 段を通る）", { skip: !process.env.TOKYO_OPT_SCAN }, async () => {
  const { payOrRefuse } = await sdk();
  const TEXT_UPDATED = "0x14cf4389d9a790cb32a054e033d7e3d3b78119dee4fea3c0983aac1db3f54015";
  const LINKED = "0x66fd1d4edf16fc35ee08adaecfdf6fd5f75283da903b50f642558d6e0ba630ff";
  const branches = {
    a: [{ topics: [TEXT_UPDATED, "0x" + word(1), "0xddc51409" + "0".repeat(56)], blockNumber: 11_799_990n }],
    b: [{ topics: [LINKED, "0x" + word(1), "0x" + "cd".repeat(32)], blockNumber: 11_799_990n }],
    c: [{ topics: [TEXT_UPDATED, "0x" + word(7), "0xddc51409" + "0".repeat(56)], blockNumber: 11_799_990n }],
  };
  for (const [k, logs] of Object.entries(branches)) {
    for (const scan of [{ canary: { address: P_A, blockNumber: 11_700_000n, txHash: SEED_TX } }, false]) {
      const w = ensWorld(); const acct = watchedAccount(); const f = router();
      const { clients } = ensClients(w);
      for (const c of Object.values(clients)) c.getLogs = async () => logs; // 走査だけが読む5つ目
      const input = { ...nameInput(w, f, acct).input, ens: { clients, policy: ensPolicy(w, { sinceIssuanceScan: scan }) } };
      const r = await payOrRefuse(input);
      if (scan) refusedWith(r, "ens_record_changed_after_attestation");
      else assert.equal(codes(r).includes("ens_record_changed_after_attestation"), false, `(${k}) オフなら走査しない`);
    }
  }
});

test("T35 親名の持ち主が変わった（anchor.owner ≠ findExactOwner(vet402.eth)）→ REFUSE ens_attester_anchor_changed", { skip: !process.env.TOKYO_OPT_ANCHOR }, async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); w.owners["vet402.eth"] = NEW_OWNER;
  const acct = watchedAccount(); const f = router();
  const ensPol = ensPolicy(w, { trustedAttesters: [{ ...ATST_CFG, anchor: { name: "vet402.eth", owner: W_VET } }] });
  stoppedAtEns(await payOrRefuse(nameInput(w, f, acct, { ensPolicy: ensPol }).input), f, acct, "ens_attester_anchor_changed");
});

// ---- vet402 に届かないときの支払い（G1〜G10）----

test("T39 vet402 に届かなくても払える（throw＋証明有効＋床2つ＋requireVet402Allow:false）", { skip: !process.env.TOKYO_OPT_UNREACHABLE }, async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); const acct = watchedAccount(); const f = router({ decision: unreachable() });
  const r = await payOrRefuse(withChain(nameInput(w, f, acct, { input: { policy: unreachablePolicy() } }).input));
  assert.equal(r.status, "paid", JSON.stringify(codes(r)));
  assert.equal(acct.typed.length, 1, "signTypedData 1回");
  assert.equal(codes(r).includes("vet402_unreachable"), true);
  assert.equal(codes(r).includes("allowed_by_caller_policy"), true);
  assert.equal(r.decision.verdict_source, "caller_policy");
  assert.equal(r.decision.policy_override.waived.source, "vet402_unreachable");
  assert.equal(r.decision.policy_override.waived.recommendation, "unreachable");
  assert.equal(r.decision.policy_override.waived.score, null);
  const ensFloor = r.decision.policy_override.floors_met.find((m) => m.floor === "minEnsAttestations");
  assert.deepEqual(ensFloor, { floor: "minEnsAttestations", source: "ens", required: 1, observed: 1 });
  assert.equal(f.paid.length, 1);
});

test("T40 届かない＋既定の requireVet402Allow → REFUSE evidence_unavailable", { skip: !process.env.TOKYO_OPT_UNREACHABLE }, async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); const acct = watchedAccount(); const f = router({ decision: unreachable() });
  const pol = unreachablePolicy(); delete pol.requireVet402Allow;
  const r = await payOrRefuse(withChain(nameInput(w, f, acct, { input: { policy: pol } }).input));
  refusedWith(r, "evidence_unavailable");
  assert.equal(codes(r).includes("vet402_unreachable"), false);
  assert.deepEqual(acct.signAccesses(), []);
});

test("T41 届いたが degraded → REFUSE evidence_unavailable（床があっても免除しない）", { skip: !process.env.TOKYO_OPT_UNREACHABLE }, async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); const acct = watchedAccount(); const f = router({ decision: { status: 200, body: decisionBody({ degraded: true, recommendation: "WARN" }) } });
  const r = await payOrRefuse(withChain(nameInput(w, f, acct, { input: { policy: unreachablePolicy() } }).input));
  refusedWith(r, "evidence_unavailable");
  assert.equal(codes(r).includes("vet402_unreachable"), false);
  assert.deepEqual(acct.signAccesses(), []);
});

test("T41b 200 で「読めたが判定になっていない」（4枝）→ 各 REFUSE evidence_unavailable・vet402_unreachable を含まない・署名者参照 0", { skip: !process.env.TOKYO_OPT_UNREACHABLE }, async () => {
  const { payOrRefuse } = await sdk();
  const branches = [
    ["① 壊れた JSON", { status: 200, raw: "{not json" }],
    ["② 空 body ＋ 204", { status: 204, raw: "" }],
    ["③ 3xx", { status: 302, raw: "", headers: { location: "https://elsewhere.test/" } }],
    ["④ {}", { status: 200, body: {} }],
    ["④ null", { status: 200, body: null }],
    ["④ {ok:true}", { status: 200, body: { ok: true } }],
  ];
  for (const [label, decision] of branches) {
    const w = ensWorld(); const acct = watchedAccount(); const f = router({ decision });
    const r = await payOrRefuse(withChain(nameInput(w, f, acct, { input: { policy: unreachablePolicy() } }).input));
    assert.equal(r.status, "refused", label);
    assert.equal(codes(r).includes("evidence_unavailable"), true, `${label}: ${JSON.stringify(codes(r))}`);
    assert.equal(codes(r).includes("vet402_unreachable"), false, `${label}: 届かなかった扱いにしない`);
    assert.deepEqual(acct.signAccesses(), [], label);
  }
});

test("T42 届いたが BLOCK → REFUSE payee_recommendation_block", { skip: !process.env.TOKYO_OPT_UNREACHABLE }, async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); const acct = watchedAccount(); const f = router({ decision: { status: 200, body: decisionBody({ recommendation: "BLOCK", reason_codes: ["l0_fail"] }) } });
  const r = await payOrRefuse(withChain(nameInput(w, f, acct, { input: { policy: unreachablePolicy() } }).input));
  refusedWith(r, "payee_recommendation_block");
  assert.equal(codes(r).includes("vet402_unreachable"), false);
  assert.deepEqual(acct.signAccesses(), []);
});

test("T43 届いたが 401・429 → 各 REFUSE evidence_unavailable（4xx は届かないに当たらない）", { skip: !process.env.TOKYO_OPT_UNREACHABLE }, async () => {
  const { payOrRefuse } = await sdk();
  for (const status of [401, 429, 404]) {
    const w = ensWorld(); const acct = watchedAccount(); const f = router({ decision: { status, body: { error: "x" } } });
    const r = await payOrRefuse(withChain(nameInput(w, f, acct, { input: { policy: unreachablePolicy() } }).input));
    refusedWith(r, "evidence_unavailable");
    assert.equal(codes(r).includes("vet402_unreachable"), false, `HTTP ${status}`);
    assert.deepEqual(acct.signAccesses(), []);
  }
});

test("T44 届かない＋vet402 の台帳の床（minL1Deliveries:1）→ REFUSE evidence_unavailable", { skip: !process.env.TOKYO_OPT_UNREACHABLE }, async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); const acct = watchedAccount(); const f = router({ decision: unreachable() });
  const r = await payOrRefuse(withChain(nameInput(w, f, acct, { input: { policy: unreachablePolicy({ minL1Deliveries: 1 }) } }).input));
  refusedWith(r, "evidence_unavailable");
  assert.deepEqual(acct.signAccesses(), []);
});

test("T45 ENS の床の呼び出し側エラー（3枝）", { skip: !process.env.TOKYO_OPT_UNREACHABLE }, async () => {
  const { payOrRefuse } = await sdk();
  // (a) payeeName なしで minEnsAttestations → invalid_evidence_policy
  {
    const acct = watchedAccount(); const f = router();
    await assert.rejects(() => payOrRefuse({ payee: W_ENS, network: "base-sepolia", resource: RESOURCE, amountUsd: 0.01, apiUrl: API, account: acct.account, fetch: f.fetch,
      policy: { requireVet402Allow: false, evidence: { minEnsAttestations: 1 } } }), (e) => String(e && e.message).startsWith("invalid_evidence_policy"));
    assert.equal(f.calls.length, 0);
  }
  // (b) minEnsAttestations:0 だけで requireVet402Allow:false → invalid_policy（0 は床でない）
  {
    const w = ensWorld(); const acct = watchedAccount(); const f = router();
    const { input } = nameInput(w, f, acct, { input: { policy: { requireVet402Allow: false, evidence: { minEnsAttestations: 0 } } } });
    await assert.rejects(() => payOrRefuse(input), (e) => String(e && e.message).startsWith("invalid_policy"));
    assert.equal(f.calls.length, 0);
  }
  // (c) minEnsAttestations:1 と evidence.source:"subgraph" を一緒に → throw しない（source の制約を受けない・S4）
  {
    const w = ensWorld(); const acct = watchedAccount(); const f = router({ decision: unreachable() });
    const { input } = nameInput(w, f, acct, { input: { policy: { requireVet402Allow: false, evidence: { minEnsAttestations: 1, source: "subgraph" } } } });
    const r = await payOrRefuse(input);
    assert.ok(r && typeof r.status === "string", "throw せずに決定を返す");
  }
});

test("T46 ENS の床が足りない（届かない＋有効1＋minEnsAttestations:2）→ REFUSE insufficient_ens_attestations", { skip: !process.env.TOKYO_OPT_UNREACHABLE }, async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); const acct = watchedAccount(); const f = router({ decision: unreachable() });
  const ensPol = ensPolicy(w, { trustedAttesters: [ATST_CFG, { name: "atst.second.eth", address: ATST2, recordKeys: ["x402-offer"] }] });
  const r = await payOrRefuse(withChain(nameInput(w, f, acct, { ensPolicy: ensPol, input: { policy: unreachablePolicy({ minEnsAttestations: 2 }) } }).input));
  refusedWith(r, "insufficient_ens_attestations");
  assert.deepEqual(acct.signAccesses(), []);
});

test("T47 届かない経路でも約束が変われば払えない（再検証で x402-offer が1文字違う）→ REFUSE ens_attestation_signer_mismatch・x402-pay.js 未評価", { skip: !process.env.TOKYO_OPT_UNREACHABLE }, async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld(); const acct = watchedAccount();
  const f = router({ decision: unreachable(), onWall: () => { w.texts["seller-a.eth"][KEY_OFFER] = OFFER_1CHAR; } });
  const r = await payOrRefuse(withChain(nameInput(w, f, acct, { input: { policy: unreachablePolicy() } }).input));
  refusedWith(r, "ens_attestation_signer_mismatch");
  assert.equal(f.walls(), 1, "1回目は通って 402 まで来ている");
  assert.deepEqual(acct.signAccesses(), []);
  assert.equal(f.paid.length, 0, "支払いは起きない");
});

test("T48 配備の食い違い（同じブロックで UH.ROOT_REGISTRY ≠ UR.ROOT_REGISTRY）→ REFUSE ens_evidence_unavailable＋evidence_unavailable", async () => {
  const { payOrRefuse } = await sdk();
  const w = ensWorld({ rootUH: ROOT_OTHER }); const acct = watchedAccount(); const f = router();
  const r = await payOrRefuse(nameInput(w, f, acct).input);
  stoppedAtEns(r, f, acct, "ens_evidence_unavailable");
  assert.equal(codes(r).includes("evidence_unavailable"), true);
});
