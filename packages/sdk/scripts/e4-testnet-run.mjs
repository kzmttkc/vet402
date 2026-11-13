#!/usr/bin/env node
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import {
  TESTNET_CHAIN_ID,
  PRICE_UNITS,
  TOTAL_CAP_UNITS,
  E4_TESTNET_SCENARIOS,
  preflight,
  resolveConfig,
  readPrivateKeyFile,
  assertSpendWithinCap,
  plannedBuyerOutflowUnits,
  assertNoSecretsInText,
  rpcOriginForRecord,
  minEthWei,
} from "./e4-testnet-config.mjs";

/** Populated during main for safe error output (no key material in stderr). */
const runSecrets = [];

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const ESCROW = "0xf96815976523E00e65Be8f34cA5e64b4f41EB19c";
const COLLECTOR = "0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88";
const PRICE = PRICE_UNITS.toString();
const MIN_USDC_UNITS = 20000n;
const GAS_UNITS_ESTIMATE = 450_000n;

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jsonReplacer(_k, v) {
  return typeof v === "bigint" ? v.toString() : v;
}

function nonEmptyCode(code) {
  return code && code !== "0x" && code.length > 2;
}

/** Exactly one tx per role and each status matches expectedStatus. */
function txsRolesPass(txs, roles) {
  if (txs.length !== roles.length) return false;
  for (const role of roles) {
    const matching = txs.filter((t) => t.role === role);
    if (matching.length !== 1) return false;
    const tx = matching[0];
    if (tx.status !== tx.expectedStatus) return false;
  }
  return true;
}

function expectedTxRoles(def) {
  if (def.expect === "capture") return ["authorize", "capture"];
  if (def.expect === "void") return ["authorize", "void"];
  if (def.expect === "operator_captured_undelivered") return ["authorize", "capture"];
  if (def.id === "ceiling_chain") return ["greedy_authorize"];
  if (def.id === "vanish_reclaim") return ["authorize", "reclaim"];
  return [];
}

async function main() {
  const viem = await import("viem");
  const { privateKeyToAccount, generatePrivateKey, nonceManager } = await import("viem/accounts");
  const { baseSepolia } = await import("viem/chains");
  const { x402Facilitator } = await import("@x402/core/facilitator");
  const { x402ResourceServer } = await import("@x402/core/server");
  const { toFacilitatorEvmSigner } = await import("@x402/evm");
  const { AuthCaptureEvmScheme: FacilitatorScheme } = await import("@x402/evm/auth-capture/facilitator");
  const { AuthCaptureEvmScheme: ServerScheme } = await import("@x402/evm/auth-capture/server");
  const { payOrRefuse, reclaimAuthCapture } = await import("../dist/index.js");

  const cfgEnv = resolveConfig(process.env);
  const rpc = cfgEnv.rpc;
  const transport = viem.http(rpc);
  const chain = { ...baseSepolia, id: TESTNET_CHAIN_ID, rpcUrls: { default: { http: [rpc] } } };
  const pub = viem.createPublicClient({ chain, transport });

  const cfg = await preflight(process.env, {
    fetchChainId: () => pub.getChainId(),
    readKeyFile: (path) => {
      const pk = readPrivateKeyFile(path, readFileSync);
      runSecrets.push(pk);
      return pk;
    },
  });

  function safeLog(line) {
    assertNoSecretsInText(line, runSecrets);
    console.log(line);
  }

  let buyerPk = cfg.buyerKey;
  let operatorPk = cfg.operatorKey;
  const buyerAcct = privateKeyToAccount(buyerPk, { nonceManager });
  const operatorAcct = privateKeyToAccount(operatorPk, { nonceManager });
  buyerPk = undefined;
  operatorPk = undefined;

  const authorizerPk = generatePrivateKey();
  runSecrets.push(authorizerPk);
  const authorizerAcct = privateKeyToAccount(authorizerPk);

  const sellerPayTo = viem.getAddress(cfg.sellerPayTo ?? operatorAcct.address);
  const wallet = (a) => viem.createWalletClient({ chain, transport, account: a });

  const startedAt = new Date().toISOString();
  const startBlock = await pub.getBlockNumber();

  const report = {
    kind: "e4-9a-testnet-run",
    startedAt,
    finishedAt: null,
    rpc: rpcOriginForRecord(rpc),
    chainId: String(cfg.chainId),
    startBlock: startBlock.toString(),
    endBlock: null,
    contracts: { usdc: USDC, escrow: ESCROW, collector: COLLECTOR },
    addresses: {
      buyer: buyerAcct.address,
      operator: operatorAcct.address,
      sellerPayTo,
      receiverAuthorizer: authorizerAcct.address,
    },
    balancesBefore: null,
    balancesAfter: null,
    scenarios: [],
    paidRequestsSeen: "0",
    sdkCallsWithPayment: "0",
    // Max extra payment-signature requests per signed call (measured on the test seller).
    resendsPerCall: "0",
    ethSpentWei: { buyer: "0", operator: "0" },
    usdcSpentUnits: "0",
    stopped: null,
    allPass: false,
  };

  function writeReport(partial = {}) {
    Object.assign(report, partial);
    report.finishedAt = new Date().toISOString();
    const body = JSON.stringify(report, jsonReplacer, 2);
    assertNoSecretsInText(body, runSecrets);
    writeFileSync(cfg.outPath, body);
  }

  const escCode = await pub.getCode({ address: ESCROW });
  const colCode = await pub.getCode({ address: COLLECTOR });
  if (!nonEmptyCode(escCode) || !nonEmptyCode(colCode)) {
    report.stopped = "contract_code_empty";
    writeReport();
    process.exit(1);
  }

  assertSpendWithinCap(plannedBuyerOutflowUnits());

  const balUsdc = (a, blockNumber) => {
    const req = { address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [a] };
    if (blockNumber != null && BigInt(blockNumber) !== 0n) {
      req.blockNumber = BigInt(blockNumber);
    }
    return pub.readContract(req);
  };
  const balEth = (a) => pub.getBalance({ address: a });
  const balanceBlockAfterWait = () => (minSeenBlock === 0n ? undefined : minSeenBlock);

  const buyerUsdc0 = await balUsdc(buyerAcct.address);
  if (buyerUsdc0 < MIN_USDC_UNITS) {
    report.stopped = "usdc_low";
    writeReport();
    process.exit(1);
  }

  let minSeenBlock = 0n;
  const bumpMinBlock = (bn) => {
    if (bn != null && BigInt(bn) > minSeenBlock) minSeenBlock = BigInt(bn);
  };

  async function waitThroughBlock(atLeast) {
    const target = BigInt(atLeast ?? minSeenBlock);
    if (target === 0n) return;
    for (let i = 0; i < 600; i++) {
      const now = await pub.getBlockNumber();
      if (now >= target) return;
      await sleep(2000);
    }
    throw new Error("e4_testnet_block_wait_timeout");
  }

  const lagAwarePub = {
    ...pub,
    readContract: async (args) => {
      await waitThroughBlock(minSeenBlock);
      return pub.readContract(args);
    },
  };

  const opWallet = wallet(operatorAcct);
  const lagAwareRead = async (args) => {
    await waitThroughBlock(minSeenBlock);
    return pub.readContract(args);
  };
  const facSigner = toFacilitatorEvmSigner({
    address: operatorAcct.address,
    readContract: (a) => lagAwareRead(a),
    verifyTypedData: (a) => pub.verifyTypedData(a),
    writeContract: (a) => opWallet.writeContract({ ...a, chain, account: operatorAcct }),
    sendTransaction: (a) => opWallet.sendTransaction({ ...a, chain, account: operatorAcct }),
    waitForTransactionReceipt: async (a) => {
      const rc = await pub.waitForTransactionReceipt(a);
      bumpMinBlock(rc.blockNumber);
      return rc;
    },
    getCode: (a) => pub.getCode(a),
  });
  const facilitator = new x402Facilitator().register(`eip155:${TESTNET_CHAIN_ID}`, new FacilitatorScheme(facSigner));
  const facilitatorTxs = [];
  const facilitatorClient = {
    verify: (p, r) => facilitator.verify(p, r),
    settle: async (p, r) => {
      const out = await facilitator.settle(p, r);
      facilitatorTxs.push({
        type: p.payload?.type ?? "authorize",
        success: out.success,
        tx: out.transaction,
        errorReason: out.errorReason,
      });
      return out;
    },
    getSupported: async () => facilitator.getSupported(),
  };

  const server = new x402ResourceServer(facilitatorClient).register(
    `eip155:${TESTNET_CHAIN_ID}`,
    new ServerScheme({ receiverAuthorizerSigner: authorizerAcct }),
  );
  await server.initialize();

  const chainNow = async () => Number((await pub.getBlock()).timestamp);

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
  async function buildReqForPath(path) {
    const route = ROUTES[path];
    const t0 = Math.max(Math.floor(Date.now() / 1000), await chainNow());
    const captureDeadline = route?.vanish ? t0 + 100 : t0 + 600;
    const refundDeadline = captureDeadline + 600;
    reqsByRoute[path] = await server.buildPaymentRequirements({
      scheme: "auth-capture",
      payTo: sellerPayTo,
      price: { amount: PRICE, asset: USDC, extra: { name: "USDC", version: "2" } },
      network: `eip155:${TESTNET_CHAIN_ID}`,
      maxTimeoutSeconds: 60,
      extra: {
        authCaptureEscrow: ESCROW,
        operatorType: "delegated",
        paymentFlow: "escrow",
        captureMode: "sync",
        captureDeadline,
        refundDeadline,
        minFeeBps: 0,
        maxFeeBps: 0,
        feeRecipient: viem.zeroAddress,
        assetTransferMethod: "eip3009",
      },
    });
  }

  const events = [];
  const b64 = (o) => Buffer.from(JSON.stringify(o, jsonReplacer)).toString("base64");
  const paymentHeadersByRoute = {};

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const route = ROUTES[url.pathname];
    const reqs = reqsByRoute[url.pathname];
    try {
      const sig = req.headers["payment-signature"];
      if (sig) {
        paymentHeadersByRoute[url.pathname] = (paymentHeadersByRoute[url.pathname] ?? 0) + 1;
      }
      if (!sig) {
        const pr = await server.createPaymentRequiredResponse(reqs, {
          url: `http://127.0.0.1${url.pathname}`,
          description: "e4 testnet",
          mimeType: "application/json",
        });
        res.writeHead(402, { "PAYMENT-REQUIRED": b64(pr), "content-type": "application/json" });
        res.end("{}");
        return;
      }
      const payload = JSON.parse(Buffer.from(String(sig), "base64").toString("utf8"));
      const match = server.findMatchingRequirements(reqs, payload);
      if (!match) {
        res.writeHead(402);
        res.end("no match");
        return;
      }
      const verified = await server.verifyPayment(payload, match);
      if (!verified.isValid) {
        events.push({ route: url.pathname, verify: verified });
        res.writeHead(402);
        res.end(JSON.stringify(verified));
        return;
      }
      if (route.greedy) {
        const a = payload.payload.authorization;
        const pi = {
          operator: operatorAcct.address,
          payer: a.from,
          receiver: sellerPayTo,
          token: USDC,
          maxAmount: BigInt(PRICE),
          preApprovalExpiry: Number(a.validBefore),
          authorizationExpiry: match.extra.captureDeadline,
          refundExpiry: match.extra.refundDeadline,
          minFeeBps: 0,
          maxFeeBps: 0,
          feeReceiver: viem.zeroAddress,
          salt: BigInt(payload.payload.salt),
        };
        const over = BigInt(PRICE) + 1n;
        let errorName = null;
        try {
          await pub.simulateContract({
            address: ESCROW,
            abi: ESCROW_AUTHORIZE_ABI,
            functionName: "authorize",
            args: [pi, over, COLLECTOR, payload.payload.signature],
            account: operatorAcct.address,
          });
        } catch (e) {
          errorName = e?.walk?.((x) => x?.data?.errorName)?.data?.errorName ?? e?.cause?.data?.errorName ?? String(e?.shortMessage ?? e);
        }
        const hash = await opWallet.writeContract({
          address: ESCROW,
          abi: ESCROW_AUTHORIZE_ABI,
          functionName: "authorize",
          args: [pi, over, COLLECTOR, payload.payload.signature],
          gas: 400_000n,
          chain,
          account: operatorAcct,
        });
        const rc = await pub.waitForTransactionReceipt({ hash });
        bumpMinBlock(rc.blockNumber);
        events.push({ route: url.pathname, greedy: { errorName, tx: hash, status: rc.status, amount: over.toString() } });
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":"not served"}');
        return;
      }
      const authorize = await server.settlePayment(payload, match, undefined, undefined, undefined, "before-handler");
      events.push({ route: url.pathname, authorize });
      if (!authorize.success) {
        res.writeHead(402);
        res.end(JSON.stringify(authorize));
        return;
      }
      if (route.vanish) {
        return;
      }
      events.push({ route: url.pathname, handler: { status: route.status, bodyLength: route.body.length, at: Date.now() } });
      const capture = route.rule === "official"
        ? route.status < 400
        : route.status >= 200 && route.status < 300 && route.status !== 202 && route.body.trim().length > 0;
      let finalize;
      if (capture) {
        finalize = await server.settlePayment(payload, match, undefined, undefined, undefined, "after-handler");
      } else {
        const dispatcher = server.createPaymentCancellationDispatcher(payload, match, undefined, undefined, ["before-handler"]);
        finalize = await dispatcher.cancel({ reason: "handler_failed", responseStatus: route.status });
      }
      events.push({ route: url.pathname, finalize: finalize ?? null, delivered: capture });
      res.writeHead(route.status, { ...(finalize ? { "PAYMENT-RESPONSE": b64(finalize) } : {}), "content-type": "application/json" });
      res.end(route.body);
    } catch (e) {
      events.push({ route: url.pathname, error: String(e?.message ?? e) });
      res.writeHead(500);
      res.end("error");
    }
  });

  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const sellerPort = httpServer.address().port;

  const eth0 = {
    buyer: await balEth(buyerAcct.address),
    operator: await balEth(operatorAcct.address),
  };
  const usdc0 = {
    buyer: await balUsdc(buyerAcct.address),
    operator: await balUsdc(operatorAcct.address),
    sellerPayTo: await balUsdc(sellerPayTo),
  };
  report.balancesBefore = {
    buyer: { usdc: usdc0.buyer.toString(), eth: eth0.buyer.toString() },
    operator: { usdc: usdc0.operator.toString(), eth: eth0.operator.toString() },
    sellerPayTo: { usdc: usdc0.sellerPayTo.toString() },
  };

  const ALLOW = {
    subject: { type: "resource", id: "a".repeat(64) },
    role: "payer",
    recommendation: "ALLOW",
    reason_codes: ["l0_pass"],
    facts: { l0: { status: "pass" }, l1: { n_delivered: 1, n_attempts: 1 }, l2: { status: "undeclared" } },
    evidence: [],
    degraded: false,
    policy: "allow_only",
    rules_version: "2026-09-02.1",
  };

  const sdkFetch = async (u, init) => {
    const s = String(u);
    if (s.includes("/decision")) {
      return new Response(JSON.stringify(ALLOW), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (!s.startsWith(`http://127.0.0.1:${sellerPort}/`)) {
      throw new Error(`outbound call refused: ${s}`);
    }
    return fetch(u, init);
  };

  const lastEvent = (path, key) => [...events].reverse().find((e) => e.route === path && key in e)?.[key];

  async function ethPreflight() {
    const gasPrice = await pub.getGasPrice();
    const need = minEthWei(gasPrice * 2n, GAS_UNITS_ESTIMATE);
    const [bEth, oEth] = await Promise.all([balEth(buyerAcct.address), balEth(operatorAcct.address)]);
    if (bEth < need || oEth < need) {
      return false;
    }
    return true;
  }

  async function txStatus(hash) {
    const rc = await pub.getTransactionReceipt({ hash });
    bumpMinBlock(rc.blockNumber);
    return { status: rc.status === "success" ? 1 : 0, block: rc.blockNumber.toString() };
  }

  let sdkCallsWithPayment = 0;

  function paymentHeadersSince(path, baseline) {
    return (paymentHeadersByRoute[path] ?? 0) - baseline;
  }

  function plannedScenarioOutflow(def) {
    if (def.expect === "capture" || def.expect === "operator_captured_undelivered") {
      return PRICE_UNITS;
    }
    return 0n;
  }

  async function runPay(path, over = {}) {
    await buildReqForPath(path);
    const deliveryTimeoutMs = over.deliveryTimeoutMs ?? 90_000;
    return payOrRefuse({
      payee: sellerPayTo,
      resource: `http://127.0.0.1:${sellerPort}${path}`,
      amountUsd: 0.01,
      network: "base-sepolia",
      account: buyerAcct,
      fetch: sdkFetch,
      authCapture: { stateReader: lagAwarePub, deliveryTimeoutMs, ...(over.authCapture ?? {}) },
      ...(over.policy ? { policy: over.policy } : {}),
    });
  }

  let cumulativeBuyerOutflow = 0n;

  for (const def of E4_TESTNET_SCENARIOS) {
    if (cumulativeBuyerOutflow + plannedScenarioOutflow(def) > TOTAL_CAP_UNITS) {
      report.stopped = "spend_cap";
      break;
    }
    if (!(await ethPreflight())) {
      report.stopped = "eth_low";
      report.scenarios = report.scenarios;
      break;
    }

    const path = def.path;
    const payTrackPath = def.id === "ceiling_sdk" ? "/delivered" : path;
    const hdrBaseline = paymentHeadersByRoute[payTrackPath] ?? 0;
    const scenario = {
      id: def.id,
      expect: def.expect,
      txs: [],
      sdk: null,
      buyerDelta: "0",
      sellerDelta: "0",
      pass: false,
      notes: null,
    };
    const scenarioStartBlock = await pub.getBlockNumber();
    const bBefore = await balUsdc(buyerAcct.address, scenarioStartBlock);
    const sBefore = await balUsdc(sellerPayTo, scenarioStartBlock);

    try {
      if (def.id === "ceiling_sdk") {
        const r = await runPay("/delivered", { policy: def.policy });
        sdkCallsWithPayment += 1;
        scenario.sdk = {
          status: r.status,
          outcome: r.authCapture?.outcome ?? null,
          deliveryFailure: r.authCapture?.deliveryFailure ?? null,
          reasons: r.decision?.reason_codes ?? [],
          signed: r.signed,
        };
        scenario.paymentHeadersSeen = String(paymentHeadersSince(payTrackPath, hdrBaseline));
        scenario.pass =
          r.status === "refused"
          && r.signed === false
          && scenario.paymentHeadersSeen === "0";
        report.scenarios.push(scenario);
        safeLog(`${def.id} pass=${scenario.pass} txs=none buyerΔ=0 sellerΔ=0`);
        continue;
      }

      if (def.id === "ceiling_chain") {
        const r = await runPay("/greedy");
        sdkCallsWithPayment += 1;
        const g = lastEvent("/greedy", "greedy");
        if (g?.tx) {
          const ts = await txStatus(g.tx);
          scenario.txs.push({
            role: "greedy_authorize",
            hash: g.tx,
            expectedStatus: 0,
            status: ts.status,
            block: ts.block,
          });
        }
        scenario.sdk = {
          status: r.status,
          outcome: r.authCapture?.outcome ?? null,
          deliveryFailure: r.authCapture?.deliveryFailure ?? null,
          reasons: r.decision?.reason_codes ?? [],
          signed: r.signed,
        };
        await waitThroughBlock(minSeenBlock);
        const afterBn = balanceBlockAfterWait();
        const bAfter = await balUsdc(buyerAcct.address, afterBn);
        const sAfter = await balUsdc(sellerPayTo, afterBn);
        scenario.buyerDelta = (bAfter - bBefore).toString();
        scenario.sellerDelta = (sAfter - sBefore).toString();
        scenario.revertError = g?.errorName ?? null;
        scenario.paymentHeadersSeen = String(paymentHeadersSince(payTrackPath, hdrBaseline));
        const rolesOk = txsRolesPass(scenario.txs, ["greedy_authorize"]);
        scenario.pass =
          rolesOk
          && g?.errorName === "ExceedsMaxAmount"
          && g?.status === "reverted"
          && r.status === "failed"
          && scenario.revertError === "ExceedsMaxAmount"
          && scenario.paymentHeadersSeen === "1"
          && scenario.buyerDelta === "0"
          && scenario.sellerDelta === "0";
        report.scenarios.push(scenario);
        const h = g?.tx ?? "none";
        safeLog(`${def.id} pass=${scenario.pass} tx=${h} buyerΔ=${scenario.buyerDelta} sellerΔ=${scenario.sellerDelta}`);
        continue;
      }

      if (def.id === "vanish_reclaim") {
        const r = await runPay("/vanish", { deliveryTimeoutMs: def.deliveryTimeoutMs });
        sdkCallsWithPayment += 1;
        const auth = lastEvent("/vanish", "authorize");
        if (auth?.transaction) {
          const ts = await txStatus(auth.transaction);
          scenario.txs.push({
            role: "authorize",
            hash: auth.transaction,
            expectedStatus: 1,
            status: ts.status,
            block: ts.block,
          });
        }
        scenario.sdk = {
          status: r.status,
          outcome: r.authCapture?.outcome ?? null,
          deliveryFailure: r.authCapture?.deliveryFailure ?? null,
          reasons: r.decision?.reason_codes ?? [],
          signed: r.signed,
        };
        const pi = r.authCapture?.paymentInfo;
        const buyerWallet = wallet(buyerAcct);
        let reclaimNote = null;
        let earlyReclaimRefused = false;
        try {
          await reclaimAuthCapture({ wallet: buyerWallet, paymentInfo: pi, nowSec: await chainNow() });
          reclaimNote = "reclaim_unexpected_success";
        } catch (e) {
          if (String(e?.message ?? e).includes("reclaim_before_deadline")) {
            earlyReclaimRefused = true;
          } else {
            reclaimNote = "reclaim_early_error";
          }
        }
        scenario.earlyReclaimRefused = earlyReclaimRefused;
        const deadline = Number(pi?.authorizationExpiry ?? 0);
        const tStart = Date.now();
        while ((await chainNow()) <= deadline) {
          if ((Date.now() - tStart) / 1000 > cfg.reclaimWaitMaxSec) {
            reclaimNote = "reclaim_wait_exceeded";
            break;
          }
          await sleep(5000);
        }
        if (!reclaimNote) {
          try {
            const { txHash } = await reclaimAuthCapture({ wallet: buyerWallet, paymentInfo: pi, nowSec: await chainNow() });
            const ts = await txStatus(txHash);
            scenario.txs.push({
              role: "reclaim",
              hash: txHash,
              expectedStatus: 1,
              status: ts.status,
              block: ts.block,
            });
          } catch (e) {
            reclaimNote = `reclaim_failed:${String(e?.message ?? e).slice(0, 80)}`;
          }
        }
        scenario.notes = reclaimNote;
        await waitThroughBlock(minSeenBlock);
        const afterBn = balanceBlockAfterWait();
        const bAfter = await balUsdc(buyerAcct.address, afterBn);
        const sAfter = await balUsdc(sellerPayTo, afterBn);
        scenario.buyerDelta = (bAfter - bBefore).toString();
        scenario.sellerDelta = (sAfter - sBefore).toString();
        scenario.paymentHeadersSeen = String(paymentHeadersSince(payTrackPath, hdrBaseline));
        const rolesOk = txsRolesPass(scenario.txs, ["authorize", "reclaim"]);
        scenario.pass =
          rolesOk
          && r.status === "failed"
          && r.authCapture?.deliveryFailure === "timeout"
          && reclaimNote === null
          && bAfter - bBefore === 0n
          && earlyReclaimRefused === true
          && scenario.paymentHeadersSeen === "1";
        if (reclaimNote) scenario.pass = false;
        report.scenarios.push(scenario);
        const txLine = scenario.txs.map((t) => t.hash).join(",") || "none";
        safeLog(`${def.id} pass=${scenario.pass} tx=${txLine} buyerΔ=${scenario.buyerDelta} sellerΔ=${scenario.sellerDelta}`);
        continue;
      }

      const payPath = path;
      const r = await runPay(payPath, { policy: def.policy, deliveryTimeoutMs: def.deliveryTimeoutMs });
      sdkCallsWithPayment += 1;

      const auth = lastEvent(path, "authorize");
      const fin = lastEvent(path, "finalize");
      if (auth?.transaction) {
        const ts = await txStatus(auth.transaction);
        scenario.txs.push({
          role: "authorize",
          hash: auth.transaction,
          expectedStatus: 1,
          status: ts.status,
          block: ts.block,
        });
      }
      if (def.expect === "capture" && r.txHash) {
        const ts = await txStatus(r.txHash);
        scenario.txs.push({
          role: "capture",
          hash: r.txHash,
          expectedStatus: 1,
          status: ts.status,
          block: ts.block,
        });
      }
      if (def.expect === "void" && fin?.transaction) {
        const ts = await txStatus(fin.transaction);
        scenario.txs.push({
          role: "void",
          hash: fin.transaction,
          expectedStatus: 1,
          status: ts.status,
          block: ts.block,
        });
      }
      if (def.expect === "operator_captured_undelivered" && fin?.transaction) {
        const ts = await txStatus(fin.transaction);
        scenario.txs.push({
          role: "capture",
          hash: fin.transaction,
          expectedStatus: 1,
          status: ts.status,
          block: ts.block,
        });
      }

      await waitThroughBlock(minSeenBlock);
      const afterBn = balanceBlockAfterWait();
      const bAfter = await balUsdc(buyerAcct.address, afterBn);
      const sAfter = await balUsdc(sellerPayTo, afterBn);
      scenario.buyerDelta = (bAfter - bBefore).toString();
      scenario.sellerDelta = (sAfter - sBefore).toString();
      scenario.sdk = {
        status: r.status,
        outcome: r.authCapture?.outcome ?? null,
        deliveryFailure: r.authCapture?.deliveryFailure ?? null,
        reasons: r.decision?.reason_codes ?? [],
        signed: r.signed,
      };

      scenario.paymentHeadersSeen = String(paymentHeadersSince(payTrackPath, hdrBaseline));
      const headersOk = scenario.paymentHeadersSeen === "1";
      const rolesOk = txsRolesPass(scenario.txs, expectedTxRoles(def));

      if (def.expect === "capture") {
        scenario.pass =
          rolesOk
          && r.status === "paid"
          && r.authCapture?.outcome === "captured"
          && sAfter - sBefore === PRICE_UNITS
          && bAfter - bBefore === -PRICE_UNITS
          && headersOk;
      } else if (def.expect === "void") {
        scenario.pass =
          rolesOk
          && r.status === "failed"
          && r.authCapture?.outcome === "voided"
          && bAfter - bBefore === 0n
          && sAfter - sBefore === 0n
          && headersOk;
      } else if (def.expect === "operator_captured_undelivered") {
        scenario.pass =
          rolesOk
          && r.status === "failed"
          && (r.decision?.reason_codes ?? []).includes("operator_captured_undelivered")
          && bAfter - bBefore === -PRICE_UNITS
          && sAfter - sBefore === PRICE_UNITS
          && headersOk;
      }

      const bd = BigInt(scenario.buyerDelta);
      if (bd < 0n) cumulativeBuyerOutflow += -bd;

      report.scenarios.push(scenario);
      const txLine = scenario.txs.map((t) => t.hash).join(",") || (r.txHash ?? "none");
      safeLog(`${def.id} pass=${scenario.pass} tx=${txLine} buyerΔ=${scenario.buyerDelta} sellerΔ=${scenario.sellerDelta}`);
    } catch (e) {
      scenario.notes = String(e?.message ?? e);
      scenario.pass = false;
      report.scenarios.push(scenario);
      safeLog(`${def.id} pass=false tx=error buyerΔ=0 sellerΔ=0`);
    }
  }

  httpServer.closeAllConnections?.();
  httpServer.close();

  const eth1 = {
    buyer: await balEth(buyerAcct.address),
    operator: await balEth(operatorAcct.address),
  };
  const usdc1 = {
    buyer: await balUsdc(buyerAcct.address),
    operator: await balUsdc(operatorAcct.address),
    sellerPayTo: await balUsdc(sellerPayTo),
  };
  report.balancesAfter = {
    buyer: { usdc: usdc1.buyer.toString(), eth: eth1.buyer.toString() },
    operator: { usdc: usdc1.operator.toString(), eth: eth1.operator.toString() },
    sellerPayTo: { usdc: usdc1.sellerPayTo.toString() },
  };
  report.ethSpentWei = {
    buyer: (eth0.buyer - eth1.buyer).toString(),
    operator: (eth0.operator - eth1.operator).toString(),
  };
  report.usdcSpentUnits = (usdc0.buyer - usdc1.buyer).toString();
  let paidHeaderTotal = 0;
  let maxResends = 0;
  for (const s of report.scenarios) {
    const seen = Number(s.paymentHeadersSeen ?? 0);
    paidHeaderTotal += seen;
    if (s.id !== "ceiling_sdk") {
      maxResends = Math.max(maxResends, Math.max(0, seen - 1));
    }
  }
  report.paidRequestsSeen = String(paidHeaderTotal);
  report.resendsPerCall = String(maxResends);
  report.sdkCallsWithPayment = String(sdkCallsWithPayment);
  report.endBlock = (await pub.getBlockNumber()).toString();
  report.allPass = report.scenarios.length > 0 && report.scenarios.every((s) => s.pass) && !report.stopped;
  writeReport();

  if (!report.allPass) process.exit(1);
}

main().catch((e) => {
  const msg = String(e?.message ?? e);
  try {
    assertNoSecretsInText(msg, runSecrets);
    console.error(msg);
  } catch {
    console.error("e4_testnet_secret_in_output");
  }
  process.exit(1);
});
