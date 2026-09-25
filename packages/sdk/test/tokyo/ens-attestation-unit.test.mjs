// ETHGlobal Tokyo 2026 — B1 の red テスト: ENSIP-29 の検証（checkEnsOffer の直呼び）と符号化（atst-codec）。
// 正典: PLAN_v4.3 §3.1・§3.2・§3.3.1・§5（U01〜U04・T01〜T19・T24）。
// 規則: 新しいモジュールは**各テストの中で** await import する（先頭で静的 import しない）。
//       期待はすべて理由コードの中身で書く。ENS は EnsRpc の偽物2つ（下の harness）で、ネットワークに出ない。
// 注: T11 は assertEnsAttestationPolicy の「minValid ≤ その記録を信じる attester の数」と両立させるため、
//     x402-offer を信じる2人目（envelope なし）を並べ、com.x だけを信じる atst.vet402.eth の envelope は数えないことを見る。
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

// ---- 小道具 ----
const codec = () => import("../../dist/atst-codec.js");
const attestation = () => import("../../dist/ens-attestation.js");
async function check(w, { name = "seller-a.eth", resource = RESOURCE, method = "GET", policy, pp, ps } = {}) {
  const { checkEnsOffer } = await attestation();
  const { clients, log } = ensClients(w, pp, ps);
  const r = await checkEnsOffer({ name, resource, method, profile: PROFILE_SEPOLIA, clients, policy: policy ?? ensPolicy(w) });
  return { r, log };
}
function assertTrace(r, failStep) {
  assert.equal(r.trace.length, 7, "trace は常に 7 要素");
  assert.deepEqual(r.trace.map((s) => s.step), [1, 2, 3, 4, 5, 6, 7]);
  if (failStep === null) { assert.deepEqual(r.trace.map((s) => s.status), Array(7).fill("ok")); return; }
  assert.equal(r.trace[failStep - 1].status, "fail", `段 ${failStep} が fail`);
  for (const s of r.trace.slice(failStep)) assert.equal(s.status, "skipped", `段 ${s.step} は skipped`);
}
const refused = (r, code) => {
  assert.equal(r.ok, false, "ok は false");
  assert.equal(r.reason_codes.includes(code), true, `reason_codes に ${code}: ${JSON.stringify(r.reason_codes)}`);
};
// U01 の固定入力: output.required を足す前の約束（219 バイト）。この v で payload がちょうど 282 バイトになる。
// §3.3.1 の 266 バイトの約束（OFFER）では payload は 330 バイト（下の T01 で固定）。
const OFFER_U01 = '{"v":1,"resource":"https://vet402.com/api/tokyo/seller","method":"GET","network":"eip155:84532","asset":"0x036CbD53842c5426634e7929541eC2318f3dCF7e","amount":"10000","payTo":"0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6"}';
const U01_PAYLOAD_HEX = "0xa5616154c0f58df8753a4c53fd98c17e46e9f4ce6b8e9fa6616b6a783430322d6f66666572616e6c73656c6c65722d612e65746861741a6ab73530617678db7b2276223a312c227265736f75726365223a2268747470733a2f2f7665743430322e636f6d2f6170692f746f6b796f2f73656c6c6572222c226d6574686f64223a22474554222c226e6574776f726b223a226569703135353a3834353332222c226173736574223a22307830333643624435333834326335343236363334653739323935343165433233313866336443463765222c22616d6f756e74223a223130303030222c22706179546f223a22307843306635384466383735334134433533664439386331376534366539663443453642384539666136227d";
// 参照実装の版2（n,a,p,h,t・p=記録キー・h=keccak256(値)【一次未確認】）で K_atst が署名したもの
const V2_PAYLOAD_HEX = "0xa5616154c0f58df8753a4c53fd98c17e46e9f4ce6b8e9fa6616858208cf5e73c6f02d25822e2f497a744b51c103ccbbe01b65e811d17869b0bb04fa8616e6c73656c6c65722d612e65746861706a783430322d6f6666657261741a6ab73530";
const DIGEST_V2 = "0xdc515454ac5c0315b9cd6be2c602fbbdbe72e839e5828995426292ca32ee4f94";
const ENV_V2_HEX = "0xda6174737483021a6ab7353058419dd2f59f07b3fab0f639ada20dbfa7ebfe536d31d10b41dc77e1c6866fc584531215c51e8dc2efd323530e2c678d15c39c2822656741817f8fd0594a04a1b91c1b";
const ENV_BADTAG_HEX = "0xda6174737583011a6ab73530584187205543b9a015f7980b79f1af9c5f0fdeb1de3a21f8d0cb81faa5b2abf0f8eb0413aed2eba26a2f819465cea6bde352726f4bf63793656188f1bb65d3e94d1b1b";
const ENV_4ELEM_HEX = "0xda6174737484011a6ab73530584187205543b9a015f7980b79f1af9c5f0fdeb1de3a21f8d0cb81faa5b2abf0f8eb0413aed2eba26a2f819465cea6bde352726f4bf63793656188f1bb65d3e94d1b1b00";
const ENV_SIG64_HEX = "0xda6174737483011a6ab73530584087205543b9a015f7980b79f1af9c5f0fdeb1de3a21f8d0cb81faa5b2abf0f8eb0413aed2eba26a2f819465cea6bde352726f4bf63793656188f1bb65d3e94d1b";
const toHex = (u8) => "0x" + Buffer.from(u8).toString("hex");
const malformed = (d) => assert.match(String(d && d.error), /^ens_attestation_malformed/, `malformed であること: ${JSON.stringify(d)}`);

// ---- U: 符号化 ----

test("U01 payload は @ipld/dag-cbor と同じバイト列・a は 20 バイト・キー順 a,k,n,t,v・282 バイト・envelope 79 バイト", async () => {
  const { encodePayload, encodeEnvelope, ATST_TAG, attestationKey } = await codec();
  assert.equal(ATST_TAG, 1635021684);
  const p = encodePayload({ n: "seller-a.eth", a: W_ENS, k: KEY_OFFER, v: OFFER_U01, t: T0 }, "ensip29-draft");
  assert.equal(p.length, 282);
  assert.equal(toHex(p), U01_PAYLOAD_HEX);
  // map(5) → "a" bytes(20) → "k" → "n" → "t" → "v"（長さ→バイト順）
  const h = toHex(p).slice(2);
  assert.equal(h.slice(0, 6), "a56161");
  assert.equal(h.slice(6, 8), "54", "a は 20 バイトの bytes（text ではない）");
  const at = (k) => h.indexOf("61" + Buffer.from(k).toString("hex"), 2);
  assert.ok(at("a") < at("k") && at("k") < at("n") && at("n") < at("t") && at("t") < at("v"));
  // 大文字小文字の違う a でも同じバイト列（アドレスは bytes で入る）
  assert.equal(toHex(encodePayload({ n: "seller-a.eth", a: lc(W_ENS), k: KEY_OFFER, v: OFFER_U01, t: T0 }, "ensip29-draft")), U01_PAYLOAD_HEX);
  const env = encodeEnvelope({ version: 1, t: T0, sig: SIG_A }, "hex");
  assert.equal(env, ENV_A_HEX);
  assert.equal(hexBuf(env).length, 79);
  assert.equal(encodeEnvelope({ version: 1, t: T0, sig: SIG_A }, "base64"), ENV_A_B64);
  assert.equal(attestationKey(KEY_OFFER, "atst.vet402.eth"), KEY_ATST);
});

test("U02 同じ envelope を hex（0x 前置）と base64 で読むと同じ {version:1,t,sig}・0x の無い16進は base64 として読んで malformed", async () => {
  const { decodeEnvelope } = await codec();
  const want = { version: 1, t: T0, sig: SIG_A };
  assert.deepEqual(decodeEnvelope(ENV_A_HEX), want);
  assert.deepEqual(decodeEnvelope(ENV_A_B64), want);
  malformed(decodeEnvelope(ENV_A_HEX.slice(2)));
});

test("U03 tag 違い・4要素・署名 64 バイトは各 ens_attestation_malformed", async () => {
  const { decodeEnvelope } = await codec();
  malformed(decodeEnvelope(ENV_BADTAG_HEX));
  malformed(decodeEnvelope(ENV_4ELEM_HEX));
  malformed(decodeEnvelope(ENV_SIG64_HEX));
  // checkEnsOffer 経由でも同じ語（壊れた envelope を「無い」と読まない）
  const w = ensWorld();
  w.texts["seller-a.eth"][KEY_ATST] = ENV_SIG64_HEX;
  const { r } = await check(w);
  refused(r, "ens_attestation_malformed");
});

test("U04 参照実装の版2（p,h）は既定では ens_attestation_malformed・profiles に足せば有効・digest は版1と違う", async () => {
  const { encodePayload, decodeEnvelope } = await codec();
  assert.equal(toHex(encodePayload({ n: "seller-a.eth", a: W_ENS, k: KEY_OFFER, v: OFFER, t: T0 }, "atst-me-v2")), V2_PAYLOAD_HEX);
  assert.deepEqual(decodeEnvelope(ENV_V2_HEX).version, 2);
  const w = ensWorld();
  w.texts["seller-a.eth"][KEY_ATST] = ENV_V2_HEX;
  const def = await check(w);
  refused(def.r, "ens_attestation_malformed");
  const both = await check(w, { policy: ensPolicy(w, { profiles: ["ensip29-draft", "atst-me-v2"] }) });
  assert.equal(both.r.ok, true, JSON.stringify(both.r.reason_codes));
  assert.equal(both.r.attestations[0].profile, "atst-me-v2");
  assert.equal(both.r.attestations[0].digest, DIGEST_V2);
  assert.notEqual(DIGEST_V2, DIGEST_A);
  assert.equal(lc(both.r.attestations[0].recovered), lc(ATST));
});

// ---- T: checkEnsOffer の直呼び ----

test("T01 有効な証明（正の対照）: 2系統一致・固定一致・鮮度内で ok・trace 7/7・全読み取りが同じブロック", async () => {
  const w = ensWorld();
  const { r, log } = await check(w);
  assert.equal(r.ok, true, JSON.stringify(r.reason_codes));
  assert.deepEqual(r.reason_codes, []);
  assert.equal(r.name, "seller-a.eth");
  assert.equal(r.chainId, 11155111);
  assert.equal(lc(r.manager), lc(W_ENS));
  assert.equal(r.offerRaw, OFFER);
  assert.equal(r.offer.payTo, W_ENS);
  assert.equal(r.offer.amount, "10000");
  assert.equal(r.endpoint, RESOURCE);
  assert.equal(r.block.number, w.head);
  assert.equal(r.attestations.length, 1);
  const a = r.attestations[0];
  assert.equal(a.valid, true);
  assert.equal(a.reason, null);
  assert.equal(a.profile, "ensip29-draft");
  assert.equal(a.t, T0);
  assert.equal(lc(a.recovered), lc(ATST));
  assert.equal(lc(a.expected), lc(ATST));
  assert.equal(a.digest, DIGEST_A);
  assert.equal(hexBuf(a.payloadHex).length, 330, "266 バイトの約束で payload は 330 バイト");
  assertTrace(r, null);
  const reads = log.filter((c) => c.fn !== "getBlock" && c.fn !== "getBlockNumber" && c.fn !== "getChainId");
  assert.ok(reads.length > 0);
  for (const c of reads) assert.equal(c.blockNumber, w.head, `${c.fn} が固定ブロック B で読んでいない`);
  assert.equal(log.filter((c) => c.fn === "findNearestOwner").length, 0);
  assert.deepEqual(netGuard.calls, []);
});

test("T02 約束を1文字変えた（amount 10000→10001・envelope はそのまま）→ ens_attestation_signer_mismatch・recovered と expected が残る", async () => {
  const w = ensWorld();
  w.texts["seller-a.eth"][KEY_OFFER] = OFFER_1CHAR;
  const { r } = await check(w);
  refused(r, "ens_attestation_signer_mismatch");
  const a = r.attestations[0];
  assert.equal(a.valid, false);
  assert.equal(a.reason, "ens_attestation_signer_mismatch");
  assert.equal(lc(a.expected), lc(ATST));
  assert.match(String(a.recovered), /^0x[0-9a-fA-F]{40}$/);
  assert.notEqual(lc(a.recovered), lc(ATST));
  assert.notEqual(a.digest, DIGEST_A);
  assertTrace(r, 7);
});

test("T03 1文字変えた＋fetch が全部 throw → ens_attestation_signer_mismatch のまま（evidence_unavailable を含まない）・fetch 0 回", async () => {
  const w = ensWorld();
  w.texts["seller-a.eth"][KEY_OFFER] = OFFER_1CHAR;
  const before = netGuard.calls.length;
  const { r } = await check(w);
  refused(r, "ens_attestation_signer_mismatch");
  assert.equal(r.reason_codes.includes("ens_evidence_unavailable"), false);
  assert.equal(r.reason_codes.includes("evidence_unavailable"), false);
  assert.equal(netGuard.calls.length - before, 0, "段 2.5 は HTTP に出ない");
});

test("T04 持ち主が移った（findExactOwner が別アドレス）→ ens_attestation_signer_mismatch", async () => {
  const w = ensWorld();
  w.owners["seller-a.eth"] = NEW_OWNER;
  const { r } = await check(w);
  refused(r, "ens_attestation_signer_mismatch");
  assert.equal(lc(r.manager), lc(NEW_OWNER));
  assert.equal(r.reason_codes.includes("ens_name_unresolved"), false);
});

test("T05a linkToRecord(name,0) の後（x402-offer・envelope・addr が全部空）→ ens_offer_missing（語の優先で先頭）", async () => {
  const w = ensWorld();
  w.texts["seller-a.eth"] = {};
  delete w.addrs["seller-a.eth"];
  const { r } = await check(w);
  refused(r, "ens_offer_missing");
  assert.equal(r.reason_codes[0], "ens_offer_missing");
  assert.equal(r.offerRaw === null || r.offerRaw === "", true);
});

test("T05b 約束はあるが envelope だけ消えた → ens_attestation_missing", async () => {
  const w = ensWorld();
  w.texts["seller-a.eth"][KEY_ATST] = "";
  const { r } = await check(w);
  refused(r, "ens_attestation_missing");
  assert.equal(r.reason_codes.includes("ens_offer_missing"), false);
});

test("T06 他の名前の箱につなぐ（UR が seller-b.eth の有効な約束と envelope をそのまま返す）→ ens_attestation_signer_mismatch", { skip: !process.env.TOKYO_OPT_LINK }, async () => {
  const w = ensWorld();
  w.texts["seller-a.eth"] = { ...w.texts["seller-b.eth"] };
  // 対照: n2 の上では同じ組が VALID
  const n2 = await check(w, { name: "seller-b.eth" });
  assert.equal(n2.r.ok, true, JSON.stringify(n2.r.reason_codes));
  const { r } = await check(w);
  refused(r, "ens_attestation_signer_mismatch");
});

test("T07 別の名前 seller-b.eth に seller-a.eth 用の envelope を写した → ens_attestation_signer_mismatch", async () => {
  const w = ensWorld();
  w.texts["seller-b.eth"][KEY_ATST] = ENV_A_HEX;
  const { r } = await check(w, { name: "seller-b.eth" });
  refused(r, "ens_attestation_signer_mismatch");
});

test("T08 attester が鍵を替えた（resolveAddr(atst) が新アドレス・設定は旧）→ ens_attester_unpinned・比較まで進まない", async () => {
  const w = ensWorld();
  w.addrs["atst.vet402.eth"] = ROTATED;
  const { r } = await check(w);
  refused(r, "ens_attester_unpinned");
  assert.equal(r.reason_codes.includes("ens_attestation_signer_mismatch"), false);
  assert.equal(r.attestations[0].reason, "ens_attester_unpinned");
  assertTrace(r, 6);
});

test("T09 attester 名に addr が無い（resolveAddr → null）→ ens_attester_unresolved", async () => {
  const w = ensWorld();
  delete w.addrs["atst.vet402.eth"];
  const { r } = await check(w);
  refused(r, "ens_attester_unresolved");
  assert.equal(r.reason_codes.includes("ens_attestation_signer_mismatch"), false);
  assertTrace(r, 6);
});

test("T10 信頼していない attester（attestations[x402-offer][evil.eth] だけ）→ ens_attestation_missing", async () => {
  const w = ensWorld();
  delete w.texts["seller-a.eth"][KEY_ATST];
  w.texts["seller-a.eth"]["attestations[x402-offer][evil.eth]"] = ENV_A_HEX;
  w.addrs["evil.eth"] = ATST;
  const { r } = await check(w);
  refused(r, "ens_attestation_missing");
  assert.equal(r.attestations.some((a) => a.attester === "evil.eth" && a.valid), false);
});

test("T11 別の種類（com.x）だけを信じる attester の envelope は数えない → ens_attestation_missing", async () => {
  const w = ensWorld();
  const policy = ensPolicy(w, {
    trustedAttesters: [
      { name: "atst.vet402.eth", address: ATST, recordKeys: ["com.x"] },
      { name: "atst.second.eth", address: ATST2, recordKeys: ["x402-offer"] },
    ],
  });
  const { r } = await check(w, { policy });
  refused(r, "ens_attestation_missing");
  assert.equal(r.attestations.some((a) => a.attester === "atst.vet402.eth" && a.valid), false);
});

test("T12 古い証明（now − t = maxAgeSeconds + 1）→ ens_attestation_stale", async () => {
  const w = ensWorld({ now: T0 + 86_401 });
  const { r } = await check(w);
  refused(r, "ens_attestation_stale");
  assert.equal(r.reason_codes.includes("ens_attestation_signer_mismatch"), false);
});

test("T13 未来の証明（t = now + 301）→ ens_attestation_stale", async () => {
  const w = ensWorld({ now: T0 - 301 });
  const { r } = await check(w);
  refused(r, "ens_attestation_stale");
});

test("T14 未登録・RESERVED・wildcard のサブ名（findExactOwner → 0x0 の3枝）→ ens_name_unresolved・findNearestOwner 0 回", async () => {
  for (const name of ["seller-z.eth", "reserved-name.eth", "x.seller-a.eth"]) {
    const w = ensWorld();
    // wildcard の枝: 親のリゾルバが子の記録を肩代わりして返す（値だけ見ると「読めた」に見える）
    w.texts[name] = { ...w.texts["seller-a.eth"] };
    const { r, log } = await check(w, { name });
    refused(r, "ens_name_unresolved");
    assert.equal(r.reason_codes.includes("ens_attestation_signer_mismatch"), false, name);
    assert.equal(log.filter((c) => c.fn === "findNearestOwner").length, 0, `${name}: findNearestOwner を呼んだ`);
  }
});

test("T15 2系統で x402-offer が1文字違う（同じブロック）→ ens_evidence_unavailable", async () => {
  const w = ensWorld();
  const { r } = await check(w, { ps: { texts: { "seller-a.eth": { [KEY_OFFER]: OFFER_1CHAR } } } });
  refused(r, "ens_evidence_unavailable");
  assert.equal(r.reason_codes[0], "ens_evidence_unavailable");
  assert.equal(r.reason_codes.includes("ens_attestation_signer_mismatch"), false, "片系統の値で署名を比べない");
});

test("T16 head が古い（timestamp が 10 分前）／2系統の head が 4 ブロック離れている → 各 ens_evidence_unavailable", async () => {
  const w1 = ensWorld();
  const a = await check(w1, { pp: { timestamp: w1.now - 600 }, ps: { timestamp: w1.now - 600 } });
  refused(a.r, "ens_evidence_unavailable");
  const w2 = ensWorld();
  const b = await check(w2, { ps: { head: w2.head - 4n } });
  refused(b.r, "ens_evidence_unavailable");
  // 対照: 3 ブロック差は許す（|head₁−head₂| ≤ 3）。B は小さい方
  const w3 = ensWorld();
  const c = await check(w3, { ps: { head: w3.head - 3n } });
  assert.equal(c.r.ok, true, JSON.stringify(c.r.reason_codes));
  assert.equal(c.r.block.number, w3.head - 3n);
});

test("T17 RPC が落ちた（resolveText が throw）→ ens_evidence_unavailable", async () => {
  const w = ensWorld();
  const { r } = await check(w, { pp: { throwOn: (a) => a.functionName === "resolve" } });
  refused(r, "ens_evidence_unavailable");
});

test("T18 約束が JSON でない（証明は有効）→ ens_offer_malformed", async () => {
  const w = ensWorld();
  w.texts["seller-a.eth"][KEY_OFFER] = BAD_VALUE;
  w.texts["seller-a.eth"][KEY_ATST] = ENV_BAD_HEX;
  const { r } = await check(w);
  refused(r, "ens_offer_malformed");
  assert.equal(r.attestations[0].valid, true, "署名は有効（壊れているのは約束の中身）");
  assert.equal(r.reason_codes.includes("ens_attestation_signer_mismatch"), false);
});

test("T19 agent-endpoint[x402] が約束の resource と違う → ens_offer_mismatch", async () => {
  const w = ensWorld();
  w.texts["seller-a.eth"][KEY_EP] = "https://vet402.com/api/tokyo/sellet";
  const { r } = await check(w);
  refused(r, "ens_offer_mismatch");
  assert.equal(r.attestations[0].valid, true);
});

test("T24 閾値 2（minValid:2）で有効が1つ → ens_attestation_missing", async () => {
  const w = ensWorld();
  const policy = ensPolicy(w, {
    minValid: 2,
    trustedAttesters: [ATST_CFG, { name: "atst.second.eth", address: ATST2, recordKeys: ["x402-offer"] }],
  });
  const { r } = await check(w, { policy });
  refused(r, "ens_attestation_missing");
  assert.equal(r.attestations.filter((a) => a.valid).length, 1);
  // 対照: 2人目の envelope を足せば通る
  w.texts["seller-a.eth"][KEY_ATST2] = ENV_A2_HEX;
  const ok = await check(w, { policy });
  assert.equal(ok.r.ok, true, JSON.stringify(ok.r.reason_codes));
});
