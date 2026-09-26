// node --test test/scene.test.mjs   (Node >= 22.18 strips the types of ../src/**/*.ts)
// run.ts pay / cut-vet402 / scene3 (PLAN_v4.3 sections 3.3.3, 3.8, 3.10, 8.2, section 4 D-1..D-5).
// ENS is a fake world (the same shape as the ensWorld harness of observe-attester.test.mjs), the seller and the
// vet402 API are a fake fetch, Intercepta is a fake fetch behind the real screening.ts. The only sockets opened are
// on 127.0.0.1: the closed port and the throwaway 503 server that cut-vet402 uses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`network forbidden in tokyo tests: ${String(url)}`); };

// ==== harness (fake ENS; same shapes as test/observe-attester.test.mjs) ====
const UR = "0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe";
const ROOT = "0x9703DBD26dAB89504490994138cF2c575251a9cE";
const ZERO = "0x0000000000000000000000000000000000000000";
const W_ENS = "0xC0f58Df8753A4C53fD98c17e46e9f4CE6B8E9fa6";
const W_VET = "0x502B59FbfF30E21B02Ade06ed0328FE03B35b8e6";
const W_PAY = "0x90F79bf6EB2c4f870365E785982E1f101E93b906"; // anvil #3 address (no key used)
const P_A = "0xC54403186Db35B9D92cc393Ae665D3960117ac14";
const P_BC = "0xd6A089Fc08e5e97697a3293d02F40837CeA1d2bf";
const R_VET = "0x3368219EDdFdd1faC6409Fb9A1b8bF7D21598391";
const P_AG1 = "0xd3F4818c0bB93e54780525b21380D44D6D06bcd6";
const ANVIL0_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ATST = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // anvil #0
const RONIN = "0x098B716B8Aaf21512996dC57EB0615e2383E2f96";
const USDC_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RESOURCE = "https://vet402.com/api/tokyo/seller";
const API = "https://api.vet402.test/api/v1";
const KEY_OFFER = "x402-offer";
const KEY_ATST = "attestations[x402-offer][atst.vet402.eth]";
const KEY_EP = "agent-endpoint[x402]";
const mkOffer = (amount, payTo) => `{"v":1,"resource":"${RESOURCE}","method":"GET","network":"eip155:84532","asset":"${USDC_SEPOLIA}","amount":"${amount}","payTo":"${payTo}","output":{"required":["result","observed_at"]}}`;
const OFFER = mkOffer("10000", W_ENS);
const OFFER_1CHAR = mkOffer("10001", W_ENS);
const OFFER_E = mkOffer("10000", RONIN);
const POLICY_JSON = '{"v":1,"network":"eip155:84532","trust":["atst.vet402.eth"],"floors":{"minEnsAttestations":1,"minChainReceipts":1},"requireVet402Allow":false,"max":"50000","maxAgeSeconds":86400}';
const NOW = Math.floor(Date.now() / 1000);

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
  if (sel === "59d1d43c") {
    const off = parseInt(h.slice(72, 136), 16); const at = 8 + off * 2; const len = parseInt(h.slice(at, at + 64), 16);
    return { kind: "text", key: Buffer.from(h.slice(at + 64, at + 64 + len * 2), "hex").toString("utf8") };
  }
  if (sel === "3b3b57de") return { kind: "addr" };
  if (sel === "f1cb7e06") return { kind: "addr", coinType: BigInt("0x" + h.slice(72, 136)) };
  return { kind: "unknown", sel };
}

async function envelopeFor(name, offerRaw, t = NOW - 60) {
  const { loadEnsSdk } = await import("../src/lib/sdk.ts");
  const ens = await loadEnsSdk();
  const payload = ens.encodePayload({ n: name, a: W_ENS, k: KEY_OFFER, v: offerRaw, t }, "ensip29-draft");
  const sig = await privateKeyToAccount(ANVIL0_PK).signMessage({ message: { raw: keccak256(payload) } });
  return ens.encodeEnvelope({ version: 1, t, sig }, "base64");
}

async function ensWorld(over = {}) {
  return {
    chainId: 11155111, head: 11_800_000n, now: NOW, lag: 12, rootUR: ROOT, rootUH: ROOT,
    owners: { "seller-a.eth": W_ENS, "seller-e.eth": W_ENS, "vet402.eth": W_VET, "agent-1.vet402.eth": W_VET },
    texts: {
      "seller-a.eth": { [KEY_OFFER]: OFFER, [KEY_ATST]: await envelopeFor("seller-a.eth", OFFER), [KEY_EP]: RESOURCE },
      "seller-e.eth": { [KEY_OFFER]: OFFER_E, [KEY_EP]: RESOURCE },
      "agent-1.vet402.eth": { "x402-policy": POLICY_JSON },
    },
    addrs: { "atst.vet402.eth": ATST, "seller-a.eth": W_ENS },
    resolvers: { "vet402.eth": R_VET, "atst.vet402.eth": R_VET, "agent-1.vet402.eth": P_AG1, "seller-e.eth": P_BC },
    ...over,
  };
}

function fakeRpc(w, log) {
  return {
    chain: { id: w.chainId },
    async readContract(a) {
      switch (a.functionName) {
        case "ROOT_REGISTRY": log.push("ROOT_REGISTRY"); return lc(a.address) === lc(UR) ? w.rootUR : w.rootUH;
        case "findExactOwner": { const n = dnsDecode(a.args[0]); log.push(`owner:${n}`); const o = w.owners[n] ?? ZERO; w.lastOwner = o; return o; }
        case "getState": { const o = w.lastOwner ?? ZERO; const st = o === ZERO ? 0 : 2; return Object.assign([1n, st, o, 1821178728n], { tokenId: 1n, status: st, latestOwner: o, expiry: 1821178728n }); }
        case "resolve": {
          const name = dnsDecode(a.args[0]); const c = decodeCall(a.args[1]); const resolver = w.resolvers[name] ?? P_A;
          if (c.kind === "text") { log.push(`text:${name}:${c.key}`); return [abiString(w.texts[name]?.[c.key] ?? ""), resolver]; }
          if (c.kind === "addr") {
            log.push(`addr:${name}`);
            const v = w.addrs[name];
            if (c.coinType !== undefined) return [abiDyn(v ? hexBuf(v) : Buffer.alloc(0)), resolver];
            return [abiAddress(v ?? ZERO), resolver];
          }
          throw new Error(`fake rpc: unexpected resolve selector ${c.sel}`);
        }
        default: throw new Error(`fake rpc: unexpected readContract ${a.functionName}`);
      }
    },
    async getBlock(a = {}) { return { number: a.blockNumber ?? w.head, timestamp: BigInt(w.now - w.lag) }; },
    async getBlockNumber() { return w.head; },
    async getChainId() { return w.chainId; },
  };
}
function ensClients(w) { const log = []; return { clients: { primary: fakeRpc(w, log), secondary: fakeRpc(w, log) }, log }; }
// ==== harness end ====

const ACCEPT = { scheme: "exact", network: "eip155:84532", amount: "10000", asset: USDC_SEPOLIA, payTo: W_ENS, maxTimeoutSeconds: 60, extra: { assetTransferMethod: "eip3009", name: "USDC", version: "2" } };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
function resp(r) {
  const headers = new Headers(r.headers ?? {});
  return { ok: r.status >= 200 && r.status < 300, status: r.status, headers, json: async () => r.body, text: async () => JSON.stringify(r.body ?? null) };
}
/** The seller answers 402 without a payment; a request with a payment header must never reach it in dry-run. */
function sellerAndApi({ api }) {
  const calls = [];
  const paid = [];
  const fetch = async (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith("http://127.0.0.1:")) return realFetch(url, init); // cut-vet402: closed port or the 503 server
    if (u.startsWith(API)) { if (api instanceof Error) throw api; return resp(api); }
    if (u.startsWith(RESOURCE)) {
      const h = new Headers((init && init.headers) || {});
      if (h.get("PAYMENT-SIGNATURE") ?? h.get("X-PAYMENT")) { paid.push(u); return resp({ status: 500, body: {} }); }
      return resp({ status: 402, body: {}, headers: { "payment-required": b64({ x402Version: 2, accepts: [ACCEPT] }) } });
    }
    throw new Error(`forbidden call: ${u}`);
  };
  return { fetch, calls, paid };
}
function chainReader() {
  const log = { address: USDC_SEPOLIA, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", abiAddress(W_PAY), abiAddress(W_ENS)],
    data: "0x" + word(10000), transactionHash: "0x" + "5e".repeat(32), blockNumber: 30_999_500n, logIndex: 0 };
  return { getChainId: async () => 84532, getBlockNumber: async () => 31_000_000n, getLogs: async () => [log] };
}
/** The real screening.ts over a fake Intercepta. routes["activity:" + addr] answers check-activity (default: active). */
async function screener(routes) {
  const { screenPayment, QUICK_SCAN_BASE, CHECK_ACTIVITY_BASE } = await import("../src/screening.ts");
  const hits = [];
  const activityHits = [];
  const f = async (url) => {
    if (url.startsWith(CHECK_ACTIVITY_BASE + "/") && url.includes("/check-activity?")) {
      const addr = url.slice(CHECK_ACTIVITY_BASE.length + 1, url.indexOf("/check-activity?")).toLowerCase();
      activityHits.push(addr);
      const r = routes["activity:" + addr] ?? { status: 200, body: '{"hasActivity":true}' };
      return { status: r.status, text: async () => r.body };
    }
    const addr = url.slice(QUICK_SCAN_BASE.length + 1, -"/quick-scan".length).toLowerCase();
    hits.push(addr);
    const r = routes[addr] ?? { status: 200, body: '{"toxicScore":0,"traits":[]}' };
    return { status: r.status, text: async () => r.body };
  };
  return { hits, activityHits, screen: (a) => screenPayment(a, { fetch: f, readKey: () => "k", cache: new Map() }) };
}

async function pay({ name = "seller-a.eth", world, apiUrl = API, api = { status: 200, body: {} }, routes = {}, spyPay } = {}) {
  const { runPayFlow, dryPayer } = await import("../src/lib/pay-flow.ts");
  const w = world ?? (await ensWorld());
  const { clients, log } = ensClients(w);
  const net = sellerAndApi({ api });
  const s = await screener(routes);
  const payer = dryPayer(W_PAY);
  const lines = [];
  const out = await runPayFlow({
    name, agentName: "agent-1.vet402.eth", expectedResolver: P_AG1, ensClients: clients,
    localAttesters: [{ name: "atst.vet402.eth", address: ATST, recordKeys: ["x402-offer"] }],
    payer, payerAddress: W_PAY, screen: s.screen, fetch: net.fetch, apiUrl,
    chainReader: chainReader(), chainReaderCrossCheck: chainReader(), chainFromBlock: 30_999_000n,
    live: false, print: (l) => lines.push(l), ...(spyPay ? { payOrRefuse: spyPay } : {}),
  });
  return { out, lines, text: lines.join("\n"), net, ensLog: log, payer, screenHits: s.hits, activityHits: s.activityHits };
}

test("cut-vet402 (connection refused on 127.0.0.1): the SDK asks, gets no answer, and ALLOWs on the ENS proof up to the signature", async () => {
  const { startCut } = await import("../src/lib/scene.ts");
  const cut = await startCut("refused");
  const r = await pay({ apiUrl: cut.url });
  await cut.close();
  assert.equal(r.out.verdict, "ALLOW", r.text);
  assert.ok(r.out.reasons.includes("vet402_unreachable"), r.text);
  assert.ok(r.out.reasons.includes("allowed_by_caller_policy"), r.text);
  assert.equal(r.out.result.decision.verdict_source, "caller_policy");
  assert.equal(r.out.result.decision.policy_override.waived.source, "vet402_unreachable");
  assert.ok(r.out.api.length >= 1 && r.out.api.every((c) => c.unreachable), JSON.stringify(r.out.api));
  assert.ok(r.out.api.some((c) => c.path.includes("/decision")), "asked /decision");
  assert.ok(r.lines.some((l) => l.includes("vet402 API: unreachable (asked, no answer)")), r.text);
  assert.ok(!r.text.includes("vet402 API calls: 0"), "never print 'vet402 API calls: 0' (PLAN 10.6)");
  // stage order on screen: screening -> ENS 1..7 -> vet402 -> 402 -> recheck -> sign
  const idx = (p) => r.lines.findIndex((l) => l.startsWith(p));
  assert.ok(idx("[S]") < idx("[1]") && idx("[7]") < idx("[D]") && idx("[D]") < idx("[Q]") && idx("[Q]") < idx("[X]"), r.text);
  assert.ok(r.out.api.every((c) => c.outcome === "no answer (ECONNREFUSED)"), JSON.stringify(r.out.api));
  assert.equal(r.lines.filter((l) => /^\[[1-7]\] /.test(l)).length, 7);
  // stopped at the payer: asked once, nothing left the process
  assert.equal(r.payer.asked.length, 1);
  assert.equal(r.payer.asked[0].message.to, W_ENS);
  assert.equal(r.out.paymentBlocked, 1);
  assert.equal(r.out.paymentsSent, 0);
  assert.equal(r.net.paid.length, 0);
  assert.match(r.lines.at(-1), /^ALLOW vet402_unreachable, allowed_by_caller_policy/);
});

test("cut-vet402 --mode 503 (throwaway server): same ALLOW, the /decision call answered 503", async () => {
  const { startCut } = await import("../src/lib/scene.ts");
  const cut = await startCut("503");
  const r = await pay({ apiUrl: cut.url });
  await cut.close();
  assert.equal(r.out.verdict, "ALLOW", r.text);
  assert.ok(r.out.reasons.includes("vet402_unreachable") && r.out.reasons.includes("allowed_by_caller_policy"));
  assert.ok(r.out.api.some((c) => c.outcome === "HTTP 503"), JSON.stringify(r.out.api));
  assert.ok(r.lines.some((l) => l.includes("vet402 API: unreachable (asked, no answer)")));
  assert.equal(r.net.paid.length, 0);
});

test("one character later (amount 10001 on the name, envelope signed over 10000): REFUSE ens_attestation_signer_mismatch before vet402 is asked", async () => {
  const { startCut } = await import("../src/lib/scene.ts");
  const w = await ensWorld();
  w.texts["seller-a.eth"][KEY_OFFER] = OFFER_1CHAR;
  const cut = await startCut("refused");
  const r = await pay({ world: w, apiUrl: cut.url });
  await cut.close();
  assert.equal(r.out.verdict, "REFUSE", r.text);
  assert.ok(r.out.reasons.includes("ens_attestation_signer_mismatch"), r.text);
  assert.equal(r.out.api.length, 0, "the ENS gate refuses before /decision");
  assert.ok(r.lines.some((l) => l.includes("vet402 API: not asked")), r.text);
  assert.ok(!r.lines.some((l) => l.includes("unreachable (asked, no answer)")), "do not claim an ask that did not happen");
  assert.equal(r.payer.asked.length, 0);
});

test("seller-e: screening blocks (known_scammer) -> REFUSE payee_screening_blocked; no proof, no policy, no vet402 call", async () => {
  let sdkCalls = 0;
  const r = await pay({
    name: "seller-e.eth",
    routes: { [RONIN.toLowerCase()]: { status: 200, body: JSON.stringify({ toxicScore: 100, traits: [{ risk: 100, name: "known_scammer", txsCount: 3, description: "x" }, { risk: 90, name: "sanction_address" }, { risk: 90, name: "blacklist" }] }) } },
    spyPay: async () => { sdkCalls++; throw new Error("must not be called"); },
  });
  assert.equal(r.out.verdict, "REFUSE", r.text);
  assert.deepEqual(r.out.reasons, ["payee_screening_blocked"]);
  assert.equal(sdkCalls, 0);
  assert.equal(r.out.api.length, 0);
  assert.equal(r.net.calls.length, 0, "no seller, no vet402");
  assert.ok(r.lines.some((l) => l.includes("known_scammer (txsCount 3)") && l.includes("3 trait(s)")), r.text);
  assert.match(r.lines.at(-1), /^REFUSE payee_screening_blocked/);
  // ENS: the one x402-offer read for the payTo, nothing of the seven steps (no owner, no attestation, no policy)
  const reads = r.ensLog.filter((x) => x !== "ROOT_REGISTRY");
  assert.ok(reads.every((x) => x === "text:seller-e.eth:x402-offer"), JSON.stringify(reads));
  assert.deepEqual(r.screenHits.sort(), [RONIN.toLowerCase(), W_PAY.toLowerCase()].sort());
});

test("screening unavailable (Intercepta 503) -> REFUSE payee_screening_unavailable, the SDK is not called", async () => {
  let sdkCalls = 0;
  const r = await pay({ routes: { [W_ENS.toLowerCase()]: { status: 503, body: "" } }, spyPay: async () => { sdkCalls++; throw new Error("no"); } });
  assert.deepEqual(r.out.reasons, ["payee_screening_unavailable"]);
  assert.equal(sdkCalls, 0);
});

const UNKNOWN_ROUTE = { ["activity:" + W_ENS.toLowerCase()]: { status: 200, body: '{"hasActivity":false}' } };

test("unknown payee (no risk record, no Base activity) at 0.01 USDC with a VALID attestation: ALLOW, and the [U] line says why", async () => {
  const { startCut } = await import("../src/lib/scene.ts");
  const cut = await startCut("refused");
  let seen = null;
  const { loadPaySdk } = await import("../src/lib/sdk.ts");
  const real = (await loadPaySdk()).payOrRefuse;
  const r = await pay({ apiUrl: cut.url, routes: UNKNOWN_ROUTE, spyPay: async (input) => { seen = input; return real(input); } });
  await cut.close();
  assert.equal(r.out.verdict, "ALLOW", r.text);
  assert.equal(r.out.screening.verdict, "unknown");
  assert.ok(r.lines.some((l) => l.includes("UNKNOWN: toxicScore 0 (no risk record), no activity on Base (chainId 8453): unknown payee")), r.text);
  assert.ok(r.lines.some((l) => l.startsWith("[S] unknown") && l.includes("0.01 USDC (<= 0.01)")), r.text);
  const u = r.lines.find((l) => l.startsWith("[U]"));
  assert.match(u, /paying an unknown payee because the ENS attestation is VALID \(1\) and the amount 0\.01 USDC <= 0\.01 USDC/);
  assert.ok(r.lines.findIndex((l) => l.startsWith("[E]")) < r.lines.findIndex((l) => l.startsWith("[U]")), r.text);
  assert.equal(seen.policy.maxPerTxUsd, 0.01, "the ceiling is capped at 0.01 for an unknown payee (agent policy says 0.05)");
  assert.equal(seen.payeeName, "seller-a.eth");
  assert.deepEqual(r.activityHits, [W_ENS.toLowerCase()], "only the payTo is asked check-activity");
  assert.equal(r.net.paid.length, 0);
});

test("unknown payee above 0.01 USDC: REFUSE payee_unknown_needs_human before any proof, policy or vet402 call", async () => {
  const w = await ensWorld();
  w.texts["seller-a.eth"][KEY_OFFER] = OFFER_1CHAR; // amount 10001
  let sdkCalls = 0;
  const r = await pay({ world: w, routes: UNKNOWN_ROUTE, spyPay: async () => { sdkCalls++; throw new Error("must not be called"); } });
  assert.equal(r.out.verdict, "REFUSE", r.text);
  assert.deepEqual(r.out.reasons, ["payee_unknown_needs_human"]);
  assert.equal(r.out.stoppedAt, "screening");
  assert.equal(sdkCalls, 0);
  assert.equal(r.net.calls.length, 0);
  assert.match(r.lines.at(-1), /^REFUSE payee_unknown_needs_human/);
});

test("unknown payee without an attestation: the ENS gate refuses, nothing is signed", async () => {
  const w = await ensWorld();
  delete w.texts["seller-a.eth"][KEY_ATST];
  const r = await pay({ world: w, routes: UNKNOWN_ROUTE });
  assert.equal(r.out.verdict, "REFUSE", r.text);
  assert.ok(r.out.reasons.some((x) => x.startsWith("ens_")), r.text);
  assert.ok(!r.lines.some((l) => l.startsWith("[U]")), r.text);
  assert.equal(r.payer.asked.length, 0);
});

test("check-activity failing for the payTo is unavailable: REFUSE payee_screening_unavailable, the SDK is not called", async () => {
  let sdkCalls = 0;
  const r = await pay({ routes: { ["activity:" + W_ENS.toLowerCase()]: { status: 500, body: "" } }, spyPay: async () => { sdkCalls++; throw new Error("no"); } });
  assert.deepEqual(r.out.reasons, ["payee_screening_unavailable"]);
  assert.ok(r.lines.some((l) => l.includes("UNAVAILABLE: check-activity: HTTP 500")), r.text);
  assert.equal(sdkCalls, 0);
});

test("guardedFetch: in dry-run a request carrying a payment header throws before the network", async () => {
  const { guardedFetch } = await import("../src/lib/pay-flow.ts");
  let forwarded = 0;
  const g = guardedFetch(async () => { forwarded++; return resp({ status: 200, body: {} }); }, API, false);
  await assert.rejects(() => g.fetch(RESOURCE, { headers: { "PAYMENT-SIGNATURE": "x" } }), /dry_run_block/);
  await assert.rejects(() => g.fetch(RESOURCE, { headers: new Headers({ "X-PAYMENT": "x" }) }), /dry_run_block/);
  assert.equal(forwarded, 0);
  assert.equal(g.blocked(), 2);
});

test("scene3 order is fixed D-2 -> D-3 -> D-4 -> D-5 (clean-up last); D-1 / D-1r write 10001 / the K1-04 bytes", async () => {
  const { SCENE3 } = await import("../src/lib/scene.ts");
  const { demoTx, OFFER_A } = await import("../src/lib/sim-ens.ts");
  assert.deepEqual(SCENE3.map((s) => s.id), ["D-2", "D-3", "D-4", "D-5"]);
  assert.deepEqual(SCENE3.map((s) => s.admin.join(" ")), ["unlink seller-b.eth", "relink seller-b.eth", "link seller-c.eth 1", "relink seller-c.eth"]);
  assert.deepEqual(SCENE3.map((s) => s.expect), ["ens_offer_missing", "VALID", "ens_attestation_signer_mismatch", "VALID"]);
  assert.equal(OFFER_A, OFFER);
  assert.equal(Buffer.byteLength(OFFER_A), 266);
  const wOp = "0xE3BB99911A8037F22D4d6b3a4d955D1b02229080";
  const d1 = demoTx("D-1", wOp); const d1r = demoTx("D-1r", wOp);
  assert.equal(d1.from, wOp); assert.equal(d1.to, P_A);
  assert.ok(d1.data.includes(Buffer.from('"amount":"10001"').toString("hex")));
  assert.ok(d1r.data.includes(Buffer.from(OFFER).toString("hex")));
  for (const id of ["D-2", "D-3", "D-4", "D-5"]) { const t = demoTx(id, wOp); assert.equal(t.from, W_ENS); assert.equal(t.to, P_BC); }
});
