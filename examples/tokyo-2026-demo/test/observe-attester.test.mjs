// ETHGlobal Tokyo 2026 — B1 の red テスト: デモ側（観測ログ・attester・エージェントの名前空間）。
// 正典: PLAN_v4.3 §3.5・§3.6・§3.9（attester の手順）・§5（T36・T37・T49）。
// 規則: モジュールは各テストの中で await import する。期待は語の中身で書く。ネットワークに出ない。
//
// ここで決める呼び口（B4 以降の実装はこの形に合わせる。語は examples/ だけの語で SDK に入れない）:
//   src/observe.ts   planObservationWrite(decision, ctx) → { name, texts: Record<string,string> }
//                    ctx = { resource, method, source, rerun, pipelineCommit, purchaseBlock }
//                    last_purchase_id が無ければ throw "observation_without_purchase: …"
//   src/attester.ts  attestIfVerified({ name, manager, offerRaw, accept, purchaseBody, offerRawAfterPurchase, t, signer })
//                    → { envelope: string | null, reason: string | null }（条件を満たさなければ signer に触れない）
//   src/lib/agent.ts payAsAgent({ agentName, clients, expectedResolver, localAttesters, payOrRefuse, request })
//                    方針が読めなければ payOrRefuse を呼ばずに throw "agent_policy_missing: …"
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

// ---- 観測ログ（T36）----
const OBS_KEYS = new Set([
  "class", "description", "x402.resource", "x402.method", "x402.l2", "x402.declaration-sha256", "x402.response-sha256",
  "x402.purchase", "x402.purchase-block", "x402.observed-at", "x402.source", "x402.rerun", "x402.pipeline-commit",
  "x402.attested-name", "x402.attested-t",
]);
const THIRD_PARTY = "https://seller.example.test/api/v1/price"; // 第三者の売り手の URL（定数・fetch しない）
const fixedDecision = (l1 = { last_purchase_id: "eip155:8453:0x" + "cd".repeat(32) }) => ({
  subject: { type: "resource", id: "e".repeat(64) }, role: "payer", recommendation: "ALLOW", reason_codes: ["l1_delivered", "l2_conform"],
  facts: { l1: { n_delivered: 3, ...l1 }, l2: { status: "conform", declaration_hash: "0x" + "d1".repeat(32), response_hash: "0x" + "d2".repeat(32), observed_at: "2026-09-26T02:00:00Z" } },
  evidence: [], degraded: false,
});
const obsCtx = { resource: THIRD_PARTY, method: "GET", source: "https://api.vet402.test/api/v1/decision?role=payer", rerun: "node src/observe.ts --check", pipelineCommit: "751a1fe", purchaseBlock: 35_000_000 };

test("T36 観測ログの組み立て: addr・contenthash を書かない・description に Not the seller's name・last_purchase_id が無ければ throw observation_without_purchase", async () => {
  const { planObservationWrite } = await import("../src/observe.ts");
  const plan = planObservationWrite(fixedDecision(), obsCtx);
  assert.match(plan.name, /^[0-9a-f]{64}\.obs\.vet402\.eth$/, "名前は <resourceId 64桁>.obs.vet402.eth");
  for (const k of ["addr", "contenthash", "coinType", "addresses"]) assert.equal(k in plan, false, `${k} を書かない`);
  const keys = Object.keys(plan.texts);
  for (const k of keys) assert.equal(OBS_KEYS.has(k), true, `許していないキー: ${k}`);
  assert.equal(plan.texts.class, "x402-observation");
  assert.match(plan.texts.description, /Not the seller's name/);
  assert.match(plan.texts.description, /Do not send funds here/);
  assert.equal(plan.texts["x402.resource"], THIRD_PARTY);
  assert.equal(plan.texts["x402.l2"], "conform");
  assert.equal(plan.texts["x402.purchase"], fixedDecision().facts.l1.last_purchase_id);
  assert.equal(plan.texts["x402.declaration-sha256"], fixedDecision().facts.l2.declaration_hash);
  assert.equal(plan.texts["x402.response-sha256"], fixedDecision().facts.l2.response_hash);
  assert.throws(() => planObservationWrite(fixedDecision({ last_purchase_id: null }), obsCtx), (e) => String(e && e.message).startsWith("observation_without_purchase"));
  assert.throws(() => planObservationWrite(fixedDecision({}), obsCtx), (e) => String(e && e.message).startsWith("observation_without_purchase"));
});

// ---- attester（T37）----
const ACCEPT_OK = { scheme: "exact", network: "eip155:84532", amount: "10000", asset: USDC_SEPOLIA, payTo: W_ENS, extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" } };
function watchedSigner() {
  const accessed = [];
  const signer = new Proxy({ address: ATST, signMessage: async () => SIG_A }, { get(t, p) { accessed.push(String(p)); return Reflect.get(t, p); } });
  return { signer, signs: () => accessed.filter((k) => k.startsWith("sign")) };
}
const attestArgs = (signer, over = {}) => ({
  name: "seller-a.eth", manager: W_ENS, offerRaw: OFFER, accept: ACCEPT_OK,
  purchaseBody: { result: "ok", observed_at: "2026-09-26T03:00:00Z" }, offerRawAfterPurchase: OFFER, t: T0, signer, ...over,
});

test("T37 attester は条件を満たさなければ署名しない（402 ≠ 約束／本文に required キー欠け／購入後に v が変わった）→ 各 envelope なし・signMessage 参照 0", async () => {
  const { attestIfVerified } = await import("../src/attester.ts");
  // 対照: 全部満たせば署名して envelope（79 バイト）を出す——0 回が配線ミスでないことの証明
  const ok = watchedSigner();
  const good = await attestIfVerified(attestArgs(ok.signer));
  assert.equal(typeof good.envelope, "string");
  assert.equal(ok.signs().includes("signMessage"), true);
  const branches = [
    ["402 の amount が約束と違う", { accept: { ...ACCEPT_OK, amount: "10001" } }],
    ["本文に observed_at が無い", { purchaseBody: { result: "ok" } }],
    ["購入後に v が1文字変わった", { offerRawAfterPurchase: OFFER_1CHAR }],
  ];
  for (const [label, over] of branches) {
    const w = watchedSigner();
    const r = await attestIfVerified(attestArgs(w.signer, over));
    assert.equal(r.envelope, null, `${label}: envelope を出さない`);
    assert.equal(typeof r.reason, "string", `${label}: 理由を返す`);
    assert.deepEqual(w.signs(), [], `${label}: K_atst の signMessage に触れない`);
  }
});

// ---- エージェントの名前空間（T49）----
const POLICY_JSON = '{"v":1,"network":"eip155:84532","trust":["atst.vet402.eth"],"floors":{"minEnsAttestations":1,"minChainReceipts":1},"requireVet402Allow":false,"max":"50000","maxAgeSeconds":86400}';
const LOCAL_ATTESTERS = [
  { name: "atst.vet402.eth", address: ATST, recordKeys: ["x402-offer"] },
  { name: "evil.eth", address: ROTATED, recordKeys: ["x402-offer"] },
];
function spyPay() {
  const calls = [];
  return { calls, fn: async (input) => { calls.push(input); return { status: "refused", decision: { reason_codes: ["spy"] } }; } };
}
async function runAgent(w, spy, localAttesters = LOCAL_ATTESTERS) {
  const { payAsAgent } = await import("../src/lib/agent.ts");
  const { clients } = ensClients(w);
  return payAsAgent({
    agentName: "agent-1.vet402.eth", clients, expectedResolver: P_AG1, localAttesters, payOrRefuse: spy.fn,
    request: { payeeName: "seller-a.eth", resource: RESOURCE, method: "GET", amountUsd: 0.01, fetch: async () => { throw new Error("no network"); } },
  });
}

test("T49 エージェントの方針が読めない（5枝）→ payOrRefuse を呼ばずに agent_policy_missing／(f) 方針から引数への写し", { skip: !process.env.TOKYO_OPT_AGENTNS }, async () => {
  const bad = [
    ["(a) 空", ""],
    ["(b) JSON でない", "{v:1"],
    ["(c) 7キーに足りない", '{"v":1,"network":"eip155:84532","trust":["atst.vet402.eth"]}'],
    ["(d) 知らないキー minL1Deliveries", POLICY_JSON.replace('"maxAgeSeconds":86400}', '"maxAgeSeconds":86400,"minL1Deliveries":1}')],
  ];
  for (const [label, value] of bad) {
    const w = ensWorld(); w.texts["agent-1.vet402.eth"] = { "x402-policy": value };
    const spy = spyPay();
    await assert.rejects(() => runAgent(w, spy), (e) => String(e && e.message).startsWith("agent_policy_missing"), label);
    assert.equal(spy.calls.length, 0, `${label}: payOrRefuse を呼ばない`);
  }
  // (e) 値は正しいが、答えたリゾルバが P_AG1 でない（親 R_vet の wildcard・§3.5.3 の罠）
  {
    const w = ensWorld(); w.texts["agent-1.vet402.eth"] = { "x402-policy": POLICY_JSON }; w.resolvers["agent-1.vet402.eth"] = R_VET;
    const spy = spyPay();
    await assert.rejects(() => runAgent(w, spy), (e) => String(e && e.message).startsWith("agent_policy_missing"), "(e) 値が有効な JSON でも拒否");
    assert.equal(spy.calls.length, 0);
  }
  // (f) 写し方（§3.5.2）: trust ∩ ローカル = atst.vet402.eth 1件だけ・アドレスはローカルの値
  {
    const w = ensWorld(); w.texts["agent-1.vet402.eth"] = { "x402-policy": POLICY_JSON };
    const spy = spyPay();
    await runAgent(w, spy);
    assert.equal(spy.calls.length, 1);
    const i = spy.calls[0];
    assert.equal(i.network, "base-sepolia");
    assert.equal(i.payeeName, "seller-a.eth");
    assert.equal(i.resource, RESOURCE);
    assert.equal(i.ens.policy.trustedAttesters.length, 1);
    assert.equal(i.ens.policy.trustedAttesters[0].name, "atst.vet402.eth");
    assert.equal(i.ens.policy.trustedAttesters[0].address, ATST);
    assert.equal(i.ens.policy.maxAgeSeconds, 86400);
    assert.equal(i.policy.maxPerTxUsd, 0.05);
    assert.equal(i.policy.requireVet402Allow, false);
    assert.equal(i.policy.evidence.minEnsAttestations, 1);
    assert.equal(i.policy.evidence.minChainReceipts, 1);
    // trust が空集合になる入力（方針が知らない名前だけを信じる）→ agent_policy_missing
    const w2 = ensWorld(); w2.texts["agent-1.vet402.eth"] = { "x402-policy": POLICY_JSON.replace('["atst.vet402.eth"]', '["stranger.eth"]') };
    const spy2 = spyPay();
    await assert.rejects(() => runAgent(w2, spy2), (e) => String(e && e.message).startsWith("agent_policy_missing"));
    assert.equal(spy2.calls.length, 0);
  }
});

test("attester flags: screening is the default; --no-screen is the dry-run \"before\"; --live-pay never skips it", async () => {
  const { parseArgs } = await import("../src/attester.ts");
  const d = parseArgs(["--names", "seller-a,seller-e"]);
  assert.equal(d.screen, true);
  assert.equal(d.allowUnknown, false);
  assert.deepEqual(d.names, ["seller-a.eth", "seller-e.eth"]);
  assert.equal(parseArgs(["--names", "seller-a", "--no-screen"]).screen, false);
  assert.equal(parseArgs(["--names", "seller-a", "--screen"]).screen, true);
  assert.equal(parseArgs(["--names", "seller-a", "--allow-unknown"]).allowUnknown, true);
  assert.throws(() => parseArgs(["--names", "seller-a", "--live-pay", "--no-screen"]), /dry-run だけ/);
  assert.throws(() => parseArgs(["--names", "seller-a", "--screen", "--no-screen"]), /同時に付けない/);
});
