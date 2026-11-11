// ============================================================
// E4 9a の統合試験（anvil のある手元だけ）。`npm run test:anvil`。
//
// Base Sepolia を fork したローカル anvil（127.0.0.1・chain 84532）に対して、
//   買い手 = この SDK の payOrRefuse（auth-capture の公式 client で署名 1 つ）
//   試験売り手 = node:http ＋ 公式の @x402/core x402ResourceServer ＋ @x402/evm auth-capture server（delegated・escrow・sync）
//   ローカル facilitator（operator）= 公式の @x402/core x402Facilitator ＋ @x402/evm auth-capture facilitator
// を繋ぎ、配備済みの commerce-payments v1.1 AuthCaptureEscrow で次を実際に通す:
//   - 届いた例は capture（売り手 +10000）
//   - 届かなかった例は void（買い手の差分 0）。500 は公式の門（Express ミドルウェアの status >= 400 で cancel）で void、
//     空の 200 と 202 は試験用の売り手の決まり（vet402 の届いた規則: 空でない 2xx かつ 202 以外だけ capture）で void
//   - 公式の門のままの売り手は 202 を capture する。SDK はそれを paid にせず operator_captured_undelivered の失敗で返す
//     （買い手の差分は -10000 のまま。戻すのは operator の refund だけ）
//   - 上限超え: SDK は署名しない。署名済みの上限を超える authorize は ExceedsMaxAmount で revert
//   - 売り手が消えた例は、期限後に買い手の財布が reclaim（買い手の差分 0）
//
// 鍵は Anvil の捨て鍵だけ（mnemonic "test test ... junk"）。書き込みはすべてローカル anvil。fork の読み取りにだけ
// 公開 RPC（既定 https://sepolia.base.org・E4_FORK_URL で替えられる）を使う。anvil は自分で起こし、自分の PID で止める。
// 手順は ~/Takeshi_Automation/output/1111/e4_proof/{common.sh,00_fund.sh,20_auth_capture_escrow.sh} と同じ。
// ============================================================
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { appendFileSync, writeFileSync } from "node:fs";

const ANVIL = process.env.ANVIL_BIN ?? "anvil";
const probe = spawnSync(ANVIL, ["--version"], { encoding: "utf8" });
const SKIP = probe.error || probe.status !== 0
  ? `anvil が見つからない（${ANVIL}）。この層は anvil のある手元だけで走る。foundry を入れるか ANVIL_BIN を指す`
  : false;
if (SKIP) console.log(`SKIP: ${SKIP}`);

const FORK_URL = process.env.E4_FORK_URL ?? "https://sepolia.base.org";
const LOG = process.env.E4_INTEGRATION_LOG ?? null;
function log(line) {
  console.log(line);
  if (LOG) appendFileSync(LOG, line + "\n");
}

// Anvil の既定アカウント（捨て鍵）。
const KEYS = {
  minter: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  buyer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  seller: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  operator: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  authorizer: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
};
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ESCROW = "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c";
const COLLECTOR = "0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88";
const PRICE = "10000"; // 0.01 USDC（署名する上限 = PaymentInfo.maxAmount）

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on("error", reject);
  });
}

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "masterMinter", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "configureMinter", stateMutability: "nonpayable", inputs: [{ name: "m", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
];
const PI_COMPONENTS = [
  { name: "operator", type: "address" }, { name: "payer", type: "address" }, { name: "receiver", type: "address" },
  { name: "token", type: "address" }, { name: "maxAmount", type: "uint120" }, { name: "preApprovalExpiry", type: "uint48" },
  { name: "authorizationExpiry", type: "uint48" }, { name: "refundExpiry", type: "uint48" }, { name: "minFeeBps", type: "uint16" },
  { name: "maxFeeBps", type: "uint16" }, { name: "feeReceiver", type: "address" }, { name: "salt", type: "uint256" },
];
const ESCROW_AUTHORIZE_ABI = [
  {
    type: "function", name: "authorize", stateMutability: "nonpayable",
    inputs: [{ name: "paymentInfo", type: "tuple", components: PI_COMPONENTS }, { name: "amount", type: "uint256" }, { name: "tokenCollector", type: "address" }, { name: "collectorData", type: "bytes" }],
    outputs: [],
  },
  { type: "error", name: "ExceedsMaxAmount", inputs: [{ name: "amount", type: "uint256" }, { name: "maxAmount", type: "uint256" }] },
];

test("E4 9a 統合（Base Sepolia fork の anvil・公式の auth-capture server と facilitator）", { skip: SKIP, timeout: 300_000 }, async (t) => {
  const viem = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { baseSepolia } = await import("viem/chains");
  const { x402Facilitator } = await import("@x402/core/facilitator");
  const { x402ResourceServer } = await import("@x402/core/server");
  const { toFacilitatorEvmSigner } = await import("@x402/evm");
  const { AuthCaptureEvmScheme: FacilitatorScheme } = await import("@x402/evm/auth-capture/facilitator");
  const { AuthCaptureEvmScheme: ServerScheme } = await import("@x402/evm/auth-capture/server");
  const { payOrRefuse, reclaimAuthCapture } = await import("../../dist/index.js");

  if (LOG) writeFileSync(LOG, "");
  const port = await freePort();
  const RPC = `http://127.0.0.1:${port}`;
  // 書き込み先はローカル anvil だけ（127.0.0.1 以外へは書かない）。
  assert.match(RPC, /^http:\/\/127\.0\.0\.1:\d+$/);
  const anvil = spawn(ANVIL, ["--fork-url", FORK_URL, "--port", String(port), "--chain-id", "84532", "--silent"], { stdio: "ignore" });
  t.after(() => { try { process.kill(anvil.pid, "SIGTERM"); } catch {} });
  const transport = viem.http(RPC);
  const chain = { ...baseSepolia, rpcUrls: { default: { http: [RPC] } } };
  const pub = viem.createPublicClient({ chain, transport });
  const testClient = viem.createTestClient({ chain, transport, mode: "anvil" });
  for (let i = 0; ; i++) {
    try { if ((await pub.getChainId()) === 84532) break; } catch {}
    if (i > 120) throw new Error("anvil did not come up");
    await new Promise((r) => setTimeout(r, 500));
  }
  // anvil であることの確認（公開 RPC は anvil_nodeInfo に答えない）。
  const nodeInfo = await pub.request({ method: "anvil_nodeInfo" });
  const forkBlock = nodeInfo?.forkConfig?.forkBlockNumber ?? (await pub.getBlockNumber());
  const acct = Object.fromEntries(Object.entries(KEYS).map(([k, pk]) => [k, privateKeyToAccount(pk)]));
  const wallet = (a) => viem.createWalletClient({ chain, transport, account: a });
  log(`# E4 9a SDK integration ${new Date().toISOString()}`);
  log(`anvil pid=${anvil.pid} rpc=${RPC} chainId=84532 fork=${FORK_URL} forkBlock=${forkBlock}`);
  log(`escrow ${ESCROW} codesize=${((await pub.getCode({ address: ESCROW })) ?? "0x").length / 2 - 1} collector ${COLLECTOR} codesize=${((await pub.getCode({ address: COLLECTOR })) ?? "0x").length / 2 - 1}`);
  log(`buyer=${acct.buyer.address} seller=${acct.seller.address} operator=${acct.operator.address} receiverAuthorizer=${acct.authorizer.address}`);

  // ---- 資金（00_fund.sh と同じ: ローカル fork の上で USDC の masterMinter を借りて試験 USDC を刷る）----
  for (const a of Object.values(acct)) await testClient.setBalance({ address: a.address, value: 10n ** 20n });
  const mm = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "masterMinter" });
  await testClient.impersonateAccount({ address: mm });
  await testClient.setBalance({ address: mm, value: 10n ** 20n });
  const mmWallet = viem.createWalletClient({ chain, transport, account: mm });
  await pub.waitForTransactionReceipt({ hash: await mmWallet.writeContract({ address: USDC, abi: ERC20_ABI, functionName: "configureMinter", args: [acct.minter.address, 10n ** 9n] }) });
  await testClient.stopImpersonatingAccount({ address: mm });
  await pub.waitForTransactionReceipt({ hash: await wallet(acct.minter).writeContract({ address: USDC, abi: ERC20_ABI, functionName: "mint", args: [acct.buyer.address, 10_000_000n] }) });
  const bal = (a) => pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [a] });
  log(`funded buyer USDC=${await bal(acct.buyer.address)} seller USDC=${await bal(acct.seller.address)}`);

  // ---- ローカル facilitator（operator = facilitator 自身・delegated）----
  const opWallet = wallet(acct.operator);
  const facSigner = toFacilitatorEvmSigner({
    address: acct.operator.address,
    readContract: (a) => pub.readContract(a),
    verifyTypedData: (a) => pub.verifyTypedData(a),
    writeContract: (a) => opWallet.writeContract({ ...a, chain, account: acct.operator }),
    sendTransaction: (a) => opWallet.sendTransaction({ ...a, chain, account: acct.operator }),
    waitForTransactionReceipt: (a) => pub.waitForTransactionReceipt(a),
    getCode: (a) => pub.getCode(a),
  });
  const facilitator = new x402Facilitator().register("eip155:84532", new FacilitatorScheme(facSigner));
  const facilitatorTxs = [];
  const facilitatorClient = {
    verify: (p, r) => facilitator.verify(p, r),
    settle: async (p, r) => {
      const out = await facilitator.settle(p, r);
      facilitatorTxs.push({ type: p.payload?.type ?? "authorize", success: out.success, tx: out.transaction, errorReason: out.errorReason });
      return out;
    },
    getSupported: async () => facilitator.getSupported(),
  };

  // ---- 試験売り手（公式の resource server・delegated・escrow・sync）----
  const server = new x402ResourceServer(facilitatorClient).register(
    "eip155:84532",
    new ServerScheme({ receiverAuthorizerSigner: acct.authorizer }),
  );
  await server.initialize();
  const chainNow = async () => Number((await pub.getBlock()).timestamp);
  // rule "official": x402-foundation/x402 d3eb19d0 typescript/packages/http/express/src/index.ts の門と同じ
  //   （handler の後 res.statusCode >= 400 なら cancel、400 未満は after-handler settle = capture）。
  // rule "delivery": 試験用の売り手の決まり（空でない 2xx かつ 202 以外だけ capture、それ以外は void）。公式の挙動ではない。
  const ROUTES = {
    "/delivered": { status: 200, body: '{"answer":"42"}', rule: "delivery" },
    "/fail500": { status: 500, body: '{"error":"upstream"}', rule: "official" },
    "/empty200": { status: 200, body: "", rule: "delivery" },
    "/accepted202": { status: 202, body: "", rule: "delivery" },
    "/official202": { status: 202, body: "", rule: "official" },
    "/greedy": { greedy: true },
    "/vanish": { vanish: true },
  };
  const reqsByRoute = {};
  async function buildReqs() {
    const t0 = Math.max(Math.floor(Date.now() / 1000), await chainNow());
    for (const path of Object.keys(ROUTES)) {
      reqsByRoute[path] = await server.buildPaymentRequirements({
        scheme: "auth-capture",
        payTo: acct.seller.address,
        price: { amount: PRICE, asset: USDC, extra: { name: "USDC", version: "2" } },
        network: "eip155:84532",
        maxTimeoutSeconds: 60,
        extra: {
          authCaptureEscrow: ESCROW,
          operatorType: "delegated",
          paymentFlow: "escrow",
          captureMode: "sync",
          captureDeadline: t0 + 600,
          refundDeadline: t0 + 1200,
          minFeeBps: 0,
          maxFeeBps: 0,
          feeRecipient: viem.zeroAddress,
          assetTransferMethod: "eip3009",
        },
      });
    }
  }
  await buildReqs();
  const b64 = (o) => Buffer.from(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toString("base64");
  const events = [];
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const route = ROUTES[url.pathname];
    const reqs = reqsByRoute[url.pathname];
    try {
      const sig = req.headers["payment-signature"];
      if (!sig) {
        const pr = await server.createPaymentRequiredResponse(reqs, { url: `http://127.0.0.1${url.pathname}`, description: "e4 test", mimeType: "application/json" });
        res.writeHead(402, { "PAYMENT-REQUIRED": b64(pr), "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const payload = JSON.parse(Buffer.from(String(sig), "base64").toString("utf8"));
      const match = server.findMatchingRequirements(reqs, payload);
      if (!match) { res.writeHead(402); res.end("no match"); return; }
      const verified = await server.verifyPayment(payload, match);
      if (!verified.isValid) { events.push({ route: url.pathname, verify: verified }); res.writeHead(402); res.end(JSON.stringify(verified)); return; }
      if (route.greedy) {
        // operator が、買い手の署名した上限（maxAmount）を超えて hold しようとする。コントラクトが ExceedsMaxAmount で止める。
        const a = payload.payload.authorization;
        const pi = {
          operator: acct.operator.address, payer: a.from, receiver: acct.seller.address, token: USDC, maxAmount: BigInt(PRICE),
          preApprovalExpiry: Number(a.validBefore), authorizationExpiry: match.extra.captureDeadline, refundExpiry: match.extra.refundDeadline,
          minFeeBps: 0, maxFeeBps: 0, feeReceiver: viem.zeroAddress, salt: BigInt(payload.payload.salt),
        };
        const over = BigInt(PRICE) + 1n;
        let errorName = null;
        try {
          await pub.simulateContract({ address: ESCROW, abi: ESCROW_AUTHORIZE_ABI, functionName: "authorize", args: [pi, over, COLLECTOR, payload.payload.signature], account: acct.operator.address });
        } catch (e) {
          errorName = e?.walk?.((x) => x?.data?.errorName)?.data?.errorName ?? e?.cause?.data?.errorName ?? String(e?.shortMessage ?? e);
        }
        // 実際に失敗する tx を 1 本掘る（ガス固定で送る。status 0 が残る）。
        const hash = await opWallet.writeContract({ address: ESCROW, abi: ESCROW_AUTHORIZE_ABI, functionName: "authorize", args: [pi, over, COLLECTOR, payload.payload.signature], gas: 400_000n, chain, account: acct.operator });
        const rc = await pub.waitForTransactionReceipt({ hash });
        events.push({ route: url.pathname, greedy: { errorName, tx: hash, status: rc.status, amount: over.toString() } });
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":"not served"}');
        return;
      }
      // before-handler: authorize（hold）
      const authorize = await server.settlePayment(payload, match, undefined, undefined, undefined, "before-handler");
      events.push({ route: url.pathname, authorize });
      if (!authorize.success) { res.writeHead(402); res.end(JSON.stringify(authorize)); return; }
      if (route.vanish) {
        // 売り手が答えを返さず、capture も void もしない（operator が消えた形）。接続は開けたまま。
        return;
      }
      events.push({ route: url.pathname, handler: { status: route.status, bodyLength: route.body.length, at: Date.now() } });
      const capture = route.rule === "official"
        ? route.status < 400
        : route.status >= 200 && route.status < 300 && route.status !== 202 && route.body.trim().length > 0;
      const delivered = capture;
      let finalize;
      if (capture) {
        finalize = await server.settlePayment(payload, match, undefined, undefined, undefined, "after-handler");
      } else {
        const dispatcher = server.createPaymentCancellationDispatcher(payload, match, undefined, undefined, ["before-handler"]);
        finalize = await dispatcher.cancel({ reason: "handler_failed", responseStatus: route.status });
      }
      events.push({ route: url.pathname, finalize: finalize ?? null, delivered });
      res.writeHead(route.status, { ...(finalize ? { "PAYMENT-RESPONSE": b64(finalize) } : {}), "content-type": "application/json" });
      res.end(route.body);
    } catch (e) {
      events.push({ route: url.pathname, error: String(e?.stack ?? e) });
      res.writeHead(500); res.end(String(e));
    }
  });
  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const sellerPort = httpServer.address().port;
  t.after(() => { httpServer.closeAllConnections?.(); httpServer.close(); });

  // ---- 買い手（SDK）。vet402 の /decision だけ手元で答え、それ以外の外向きの呼び出しは throw ----
  const ALLOW = { subject: { type: "resource", id: "a".repeat(64) }, role: "payer", recommendation: "ALLOW", reason_codes: ["l0_pass"], facts: { l0: { status: "pass" }, l1: { n_delivered: 1, n_attempts: 1 }, l2: { status: "undeclared" } }, evidence: [], degraded: false, policy: "allow_only", rules_version: "2026-09-02.1" };
  const sdkFetch = async (u, init) => {
    const s = String(u);
    if (s.includes("/decision")) return new Response(JSON.stringify(ALLOW), { status: 200, headers: { "content-type": "application/json" } });
    if (!s.startsWith(`http://127.0.0.1:${sellerPort}/`)) throw new Error(`outbound call refused in the integration test: ${s}`);
    return fetch(u, init);
  };
  const pay = (path, over = {}) => payOrRefuse({
    payee: acct.seller.address,
    resource: `http://127.0.0.1:${sellerPort}${path}`,
    amountUsd: 0.01,
    network: "base-sepolia",
    account: acct.buyer,
    fetch: sdkFetch,
    authCapture: { stateReader: pub, deliveryTimeoutMs: 20_000, ...(over.authCapture ?? {}) },
    ...(over.policy ? { policy: over.policy } : {}),
  });
  const short = (h) => (typeof h === "string" && h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-6)}` : String(h));
  const lastEvent = (route, key) => [...events].reverse().find((e) => e.route === route && key in e)?.[key];

  // 1. 届いた → capture
  await t.test("届いた例は capture（売り手 +10000・買い手 -10000）", async () => {
    const [b0, s0] = [await bal(acct.buyer.address), await bal(acct.seller.address)];
    const r = await pay("/delivered");
    const [b1, s1] = [await bal(acct.buyer.address), await bal(acct.seller.address)];
    const auth = lastEvent("/delivered", "authorize");
    log(`[capture] sdk status=${r.status} outcome=${r.authCapture?.outcome} state=${JSON.stringify(r.authCapture?.state)} authorize=${auth?.transaction} capture=${r.txHash} buyerΔ=${b1 - b0} sellerΔ=${s1 - s0}`);
    assert.equal(r.status, "paid");
    assert.equal(r.authCapture.state.source, "chain");
    assert.equal(r.authCapture.outcome, "captured");
    assert.equal(r.authCapture.delivered, true);
    assert.match(r.txHash, /^0x[0-9a-f]{64}$/);
    assert.equal(s1 - s0, 10000n);
    assert.equal(b1 - b0, -10000n);
    const rc = await pub.getTransactionReceipt({ hash: r.txHash });
    assert.equal(rc.status, "success");
    // 順序: authorize（hold）の tx が capture の tx より前のブロック、capture は売り手の handler が答えを作った後。
    const ra = await pub.getTransactionReceipt({ hash: auth.transaction });
    assert.equal(ra.status, "success");
    assert.ok(ra.blockNumber < rc.blockNumber, `authorize ${ra.blockNumber} < capture ${rc.blockNumber}`);
    const seq = events.filter((e) => e.route === "/delivered").map((e) => Object.keys(e).find((k) => k !== "route"));
    assert.deepEqual(seq, ["authorize", "handler", "finalize"]);
    log(`[capture order] authorize block=${ra.blockNumber} < capture block=${rc.blockNumber}, seller order=${seq.join(">")}, sdk read the body (bodyLength=${r.authCapture.bodyLength}) then the escrow (state.source=${r.authCapture.state.source})`);
  });

  // 2. 届かなかった → void
  for (const [path, failure] of [["/fail500", "http_status"], ["/empty200", "empty_body"], ["/accepted202", "accepted_202"]]) {
    await t.test(`届かなかった例（${path}・${ROUTES[path].rule === "official" ? "公式の門" : "試験用の売り手の決まり"}）は void（買い手の差分 0・売り手 0）`, async () => {
      const [b0, s0] = [await bal(acct.buyer.address), await bal(acct.seller.address)];
      const r = await pay(path);
      const [b1, s1] = [await bal(acct.buyer.address), await bal(acct.seller.address)];
      const auth = lastEvent(path, "authorize");
      const fin = lastEvent(path, "finalize");
      log(`[void ${path} rule=${ROUTES[path].rule}] sdk status=${r.status} delivered=${r.authCapture?.delivered} failure=${r.authCapture?.deliveryFailure} outcome=${r.authCapture?.outcome} authorize=${auth?.transaction} void=${fin?.transaction} buyerΔ=${b1 - b0} sellerΔ=${s1 - s0}`);
      assert.equal(r.status, "failed");
      assert.equal(r.txHash, null);
      assert.equal(r.authCapture.deliveryFailure, failure);
      assert.equal(r.authCapture.outcome, "voided");
      assert.deepEqual(r.authCapture.recovery, { state: "uncaptured", fundsWithBuyer: true, void: null, reclaim: null });
      assert.equal(r.decision.reason_codes.includes("operator_captured_undelivered"), false);
      assert.match(fin.transaction, /^0x[0-9a-f]{64}$/);
      assert.equal(b1 - b0, 0n);
      assert.equal(s1 - s0, 0n);
    });
  }

  // 2b. 公式の門のままの売り手は 202 を capture する（9a-2 の合格ではない）。SDK は paid にせず印を付けて失敗で返す。
  await t.test("公式の門の 202 は capture される → SDK は paid にせず operator_captured_undelivered（買い手 -10000・戻すのは operator の refund）", async () => {
    const [b0, s0] = [await bal(acct.buyer.address), await bal(acct.seller.address)];
    const r = await pay("/official202");
    const [b1, s1] = [await bal(acct.buyer.address), await bal(acct.seller.address)];
    const fin = lastEvent("/official202", "finalize");
    log(`[official202 rule=official] sdk status=${r.status} reasons=${r.decision.reason_codes.join(",")} outcome=${r.authCapture?.outcome} recovery=${JSON.stringify(r.authCapture?.recovery)} capture=${fin?.transaction} buyerΔ=${b1 - b0} sellerΔ=${s1 - s0}`);
    assert.equal(r.status, "failed");
    assert.equal(r.txHash, null);
    assert.equal(r.authCapture.outcome, "captured");
    assert.equal(r.authCapture.capturedUndelivered, true);
    assert.equal(r.decision.reason_codes.includes("operator_captured_undelivered"), true);
    assert.deepEqual(r.authCapture.recovery, { state: "captured", refund: { by: "operator" } });
    assert.equal(b1 - b0, -10000n);
    assert.equal(s1 - s0, 10000n);
  });

  // 3. 上限超え
  await t.test("上限超え: SDK は署名しない／署名した上限を超える authorize は ExceedsMaxAmount", async () => {
    const b0 = await bal(acct.buyer.address);
    const refused = await pay("/delivered", { policy: { maxPerTxUsd: 0.005 } });
    log(`[ceiling sdk] status=${refused.status} signed=${refused.signed} nonce=${refused.nonce} reasons=${refused.decision.reason_codes.join(",")}`);
    assert.equal(refused.status, "refused");
    assert.equal(refused.signed, false);
    assert.equal(refused.nonce, null);
    assert.equal(refused.decision.reason_codes.includes("price_above_ceiling"), true);
    const r = await pay("/greedy");
    const g = lastEvent("/greedy", "greedy");
    const b1 = await bal(acct.buyer.address);
    log(`[ceiling chain] operator authorize amount=${g.amount} (signed max ${PRICE}) → ${g.errorName} tx=${g.tx} status=${g.status} sdk status=${r.status} outcome=${r.authCapture?.outcome} buyerΔ=${b1 - b0}`);
    assert.equal(g.errorName, "ExceedsMaxAmount");
    assert.equal(g.status, "reverted");
    assert.equal(r.status, "failed");
    assert.equal(r.authCapture.outcome, "not_authorized");
    assert.equal(b1 - b0, 0n);
  });

  // 4. 売り手が消えた → 期限後に買い手が reclaim
  await t.test("売り手が消えた例は、期限後に買い手の財布が reclaim（買い手の差分 0）", async () => {
    const b0 = await bal(acct.buyer.address);
    const r = await pay("/vanish", { authCapture: { deliveryTimeoutMs: 3_000 } });
    const held = await bal(acct.buyer.address);
    const auth = lastEvent("/vanish", "authorize");
    log(`[reclaim] sdk status=${r.status} failure=${r.authCapture?.deliveryFailure} outcome=${r.authCapture?.outcome} authorize=${auth?.transaction} buyerΔ(held)=${held - b0} reclaimAt=${r.authCapture?.recovery?.reclaim?.availableAt}`);
    assert.equal(r.status, "failed");
    assert.equal(r.authCapture.deliveryFailure, "timeout");
    assert.equal(r.authCapture.outcome, "held");
    assert.equal(r.authCapture.recovery.state, "uncaptured");
    assert.equal(r.authCapture.recovery.reclaim.by, "payer");
    assert.equal(held - b0, -10000n);
    const pi = r.authCapture.paymentInfo;
    const buyerWallet = wallet(acct.buyer);
    // 期限前は SDK が送る前に止める。
    await assert.rejects(reclaimAuthCapture({ wallet: buyerWallet, paymentInfo: pi, nowSec: await chainNow() }), /reclaim_before_deadline/);
    const wait = pi.authorizationExpiry - (await chainNow()) + 5;
    await testClient.increaseTime({ seconds: wait });
    await testClient.mine({ blocks: 1 });
    const { txHash } = await reclaimAuthCapture({ wallet: buyerWallet, paymentInfo: pi, nowSec: await chainNow() });
    const rc = await pub.waitForTransactionReceipt({ hash: txHash });
    const b1 = await bal(acct.buyer.address);
    log(`[reclaim] time +${wait}s → buyer reclaim tx=${txHash} status=${rc.status} buyerΔ=${b1 - b0}`);
    assert.equal(rc.status, "success");
    assert.equal(b1 - b0, 0n);
  });

  log(`facilitator settles: ${facilitatorTxs.map((x) => `${x.type}:${x.success ? short(x.tx) : "fail(" + x.errorReason + ")"}`).join(" ")}`);
  log(`payment re-sends per SDK call: 1 (the seller handled ${events.filter((e) => "authorize" in e || "greedy" in e).length} paid requests for 7 paid calls)`);
});
