// Circle Gateway on Arc. The rail signs only a pinned GatewayWalletBatched accept,
// and only when the live challenge has no signable native Arc USDC accept.
// A charge is not settled until the Gateway API names a batch tx whose debit matches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, keccak256, toBytes, type Address, type Hex } from "viem";

import {
  ARC_GATEWAY_DOMAIN,
  ARC_GATEWAY_MAX_TIMEOUT_SECONDS,
  ARC_GATEWAY_WALLET,
  GATEWAY_NOT_CHARGED_EXPIRED,
  GATEWAY_NOT_CHARGED_GRACE_SECONDS,
  arcGatewayAcceptOf,
  arcGatewayCapOpen,
  arcGatewayFundsOk,
  chainCapNetworkSql,
  gatewayAuthWindowOk,
  gatewayCandidateInclusionSql,
  gatewayLeafFacts,
  gatewayPrimaryExclusionSql,
  gatewaySignedStatus,
  hasSignableOtherRailAccept,
  isArcGatewayL1Enabled,
  parseGatewayUsdc,
  readArcGatewayAvailable,
  selectArcGatewayAccept,
  signArcGatewayPayment,
} from "@/lib/observatory/arc-gateway";
import { buildGatewayDayRecords, gatewayLeafV1, sortedMerkleRoot } from "@/lib/observatory/arc-gateway-root";
import {
  encodeSubmitBatchCalldata,
  gatewayAuthorizationRecovers,
  gatewayBuyerDebit,
  interpretGatewayTransfers,
  judgeGatewayBatch,
  planGatewayReconcile,
  readGatewayAuth,
  resolveGatewayDebit,
  type GatewayAuth,
  type GatewayClaimRow,
} from "@/lib/observatory/arc-gateway-verify";
import { ARC_USDC, BASE_USDC, hasSignableNativeArcAccept, selectAccept, MAX_PER_PURCHASE_UNITS } from "@/lib/observatory/x402-payer";
import { classifyRow, type SellerRowFacts } from "@/lib/sellers/fix-modes";
import { DECISION_STATUSES } from "@/lib/observatory/decisions";
import { cappedChainFor, chainDailyCapUnits } from "@/lib/observatory/budget";
import { defaultPayerUsdcBalance } from "@/lib/observatory/payer-funds";
import { settlementSourceSql } from "@/lib/observatory/settlement-source";

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const TEST_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const PAY_TO = "0x2222222222222222222222222222222222222222";
const BUYER = "0x1111111111111111111111111111111111111111";
const TX = `0x${"cd".repeat(32)}`;
const NONCE = `0x${"ab".repeat(32)}`;

function withEnv(name: string, value: string | undefined, fn: () => void) {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

function once(file: string, needle: string) {
  const n = read(file).split(needle).length - 1;
  assert.equal(n, 1, `${file} anchor found ${n} times: ${needle.split("\n")[0]}`);
}

function gatewayRaw(payTo = PAY_TO, amount = "1000", verifyingContract = ARC_GATEWAY_WALLET) {
  return {
    scheme: "exact",
    network: "eip155:5042",
    amount,
    asset: ARC_USDC,
    payTo,
    maxTimeoutSeconds: 60,
    extra: { name: "GatewayWalletBatched", version: "1", verifyingContract },
  };
}

function nativeRaw(payTo = PAY_TO, amount = "1000") {
  return {
    scheme: "exact",
    network: "eip155:5042",
    amount,
    asset: ARC_USDC,
    payTo,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
  };
}

function auth(over: Partial<GatewayAuth> = {}): GatewayAuth {
  return {
    from: BUYER,
    to: PAY_TO,
    value: "1000",
    validAfter: "1",
    validBefore: "9999999999",
    nonce: NONCE,
    signature: `0x${"11".repeat(65)}`,
    verifyingContract: ARC_GATEWAY_WALLET,
    ...over,
  };
}

function charged(amount = "1000", tx = TX) {
  return { transfers: [{ nonce: NONCE, status: "confirmed", txHash: tx, from: BUYER, amount }] };
}

test("旗は正確に true のときだけ立つ", () => {
  for (const value of [undefined, "", "1", "TRUE", "on", "false", " true"]) {
    withEnv("OBSERVATORY_ARC_GATEWAY_L1_ENABLED", value, () => {
      assert.equal(isArcGatewayL1Enabled(), false, JSON.stringify(value));
    });
  }
  withEnv("OBSERVATORY_ARC_GATEWAY_L1_ENABLED", "true", () => assert.equal(isArcGatewayL1Enabled(), true));
});

test("Gateway の残高が足りない・読めない・0 円では署名しない", () => {
  assert.equal(arcGatewayFundsOk(null, 1n), false);
  assert.equal(arcGatewayFundsOk(0n, 1n), false);
  assert.equal(arcGatewayFundsOk(4n, 5n), false);
  assert.equal(arcGatewayFundsOk(5n, 0n), false);
  assert.equal(arcGatewayFundsOk(5n, 5n), true);
});

test("別枠 0 は Gateway を止める。eip155:5042 はネイティブ Arc の別枠のまま", () => {
  assert.equal(cappedChainFor("eip155:5042"), "arc");
  withEnv("L1_ARC_GATEWAY_DAILY_CAP_USD", "0", () => {
    assert.equal(arcGatewayCapOpen(0n), false);
    assert.equal(chainDailyCapUnits("arc"), 2_000_000n);
  });
  withEnv("L1_ARC_GATEWAY_DAILY_CAP_USD", undefined, () => {
    assert.equal(arcGatewayCapOpen(0n), true);
    assert.equal(arcGatewayCapOpen(2_000_000n), false);
  });
});

test("Gateway の accept だけを Gateway で選ぶ。ネイティブの accept は今までどおり", () => {
  assert.equal(arcGatewayAcceptOf(nativeRaw()), null);
  assert.equal(arcGatewayAcceptOf(gatewayRaw(PAY_TO, "1000", "0x0000000000000000000000000000000000000001")), null);
  const pinned = arcGatewayAcceptOf(gatewayRaw());
  assert.equal(pinned?.extra?.name, "GatewayWalletBatched");
  assert.equal(pinned?.extra?.verifyingContract, ARC_GATEWAY_WALLET);

  const both = [gatewayRaw(), nativeRaw()];
  assert.deepEqual(selectArcGatewayAccept(both, {
    nativeArcSignable: true,
    declaredAmount: "1000",
    declaredPayTo: PAY_TO,
    declaredNetwork: "eip155:5042",
    gatewayDeclaredPayTos: [PAY_TO],
  }), { accept: null, reason: "native_present" });

  const only = selectArcGatewayAccept([gatewayRaw()], {
    nativeArcSignable: false,
    declaredAmount: "1000",
    declaredPayTo: PAY_TO,
    declaredNetwork: "eip155:5042",
    gatewayDeclaredPayTos: [PAY_TO],
  });
  assert.equal(only.accept?.extra?.name, "GatewayWalletBatched");
  assert.equal(only.accept?.payTo, PAY_TO);

  withEnv("OBSERVATORY_ARC_L1_ENABLED", "true", () => {
    assert.equal(hasSignableNativeArcAccept([nativeRaw()]), true);
    assert.equal(hasSignableNativeArcAccept([gatewayRaw()]), false);
    const native = selectAccept([gatewayRaw(), nativeRaw()], {
      declaredAmount: "1000",
      declaredPayTo: PAY_TO,
      declaredNetwork: "eip155:5042",
      preferNetworks: ["eip155:5042"],
      declaredPayTosByNetwork: { "eip155:5042": [PAY_TO.toLowerCase()] },
    });
    assert.equal(native.accept?.extra?.name, "USDC");
    assert.notEqual(native.accept?.extra?.name, "GatewayWalletBatched");
  });
  withEnv("OBSERVATORY_ARC_L1_ENABLED", undefined, () => {
    assert.equal(hasSignableNativeArcAccept([nativeRaw()]), false);
    const refused = selectAccept([gatewayRaw()], {
      declaredAmount: "1000",
      declaredPayTo: PAY_TO,
      declaredNetwork: "eip155:5042",
    });
    assert.equal(refused.accept, null);
  });
});

test("Gateway の署名はピンしたドメインで、120 秒の窓には切らない", async () => {
  const account = privateKeyToAccount(TEST_PK);
  const accept = arcGatewayAcceptOf(gatewayRaw());
  assert.ok(accept);
  const signed = await signArcGatewayPayment({
    account,
    accept,
    x402Version: 2,
    resourceUrl: "https://gw.example/api",
  });
  const span = BigInt(signed.authorization.validBefore) - BigInt(signed.authorization.validAfter);
  assert.ok(span > 120n, `validity window ${span}s was clamped to the native 120s`);
  assert.equal(signed.authorization.value, "1000");
  assert.equal(signed.authorization.to.toLowerCase(), PAY_TO);
  assert.equal(signed.verifyingContract.toLowerCase(), ARC_GATEWAY_WALLET.toLowerCase());
  const header = signed.header.headerValue;
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    accepted?: { extra?: { name?: string; verifyingContract?: string } };
  };
  assert.equal(decoded.accepted?.extra?.name, "GatewayWalletBatched");
  assert.equal(decoded.accepted?.extra?.verifyingContract?.toLowerCase(), ARC_GATEWAY_WALLET.toLowerCase());
  const recovered = await gatewayAuthorizationRecovers(
    {
      ...signed.authorization,
      signature: signed.signature,
      verifyingContract: signed.verifyingContract,
    },
    account.address,
  );
  assert.equal(recovered, true);
});

test("請求が無い行は settled にしない。請求があって残高の減りが違えば refute", async () => {
  assert.equal(interpretGatewayTransfers({ transfers: [] }, NONCE).kind, "absent");
  assert.equal(interpretGatewayTransfers({ transfers: [{ nonce: NONCE, status: "batched" }] }, NONCE).kind, "pending");
  assert.equal(interpretGatewayTransfers({ transfers: [{ nonce: NONCE, status: "failed", txHash: TX }] }, NONCE).kind, "failed");
  const full = Array.from({ length: 100 }, (_, i) => ({ nonce: `0x${i.toString(16).padStart(64, "0")}`, status: "confirmed", txHash: TX, amount: "1" }));
  assert.equal(interpretGatewayTransfers({ transfers: full }, NONCE).kind, "incomplete");
  assert.deepEqual(judgeGatewayBatch({ rowSum: 1000n, debit: 1000n, unresolved: true }), "defer");
  assert.deepEqual(judgeGatewayBatch({ rowSum: 1000n, debit: null }), "defer");
  assert.deepEqual(judgeGatewayBatch({ rowSum: 1000n, debit: 1000n }), "settle");
  assert.deepEqual(judgeGatewayBatch({ rowSum: 1000n, debit: 999n }), "refute");

  const row = { id: "row-1", status: "settle_claimed", payer: BUYER, circleGateway: auth() };
  const base = {
    rows: [row],
    verifySignature: async () => true,
    readDebit: async () => 1000n,
    loadBatch: async () => ({ rows: [] as GatewayClaimRow[], unresolved: 0 }),
    nowSec: 1_700_000_000,
  };
  const absent = await planGatewayReconcile({
    ...base,
    lookupNonce: async () => ({ ok: true, body: { transfers: [] } }),
  });
  assert.equal(absent[0]?.action, "defer");
  assert.equal(absent[0] && "reason" in absent[0] ? absent[0].reason : "", "gateway_not_charged");

  const down = await planGatewayReconcile({
    ...base,
    lookupNonce: async () => ({ ok: false }),
  });
  assert.equal(down[0]?.action, "defer");

  const noted = await planGatewayReconcile({
    ...base,
    verifySignature: async () => false,
    lookupNonce: async () => ({ ok: true, body: charged() }),
  });
  assert.deepEqual(noted[0], { id: "row-1", action: "note", reason: "gateway_signature_invalid" });

  const refuted = await planGatewayReconcile({
    ...base,
    lookupNonce: async () => ({ ok: true, body: charged() }),
    readDebit: async () => 999n,
  });
  assert.deepEqual(refuted[0], { id: "row-1", action: "refute", reason: "gateway_debit_mismatch" });

  const settled = await planGatewayReconcile({
    ...base,
    lookupNonce: async () => ({ ok: true, body: charged() }),
  });
  assert.equal(settled[0]?.action, "settle");
  if (settled[0]?.action === "settle") assert.equal(settled[0].batchTx, TX.toLowerCase());
  assert.ok(readGatewayAuth(auth()));
});

test("日次 root の葉はアンカーのスクリプトと同じ", () => {
  const facts = gatewayLeafFacts({
    resourceUrl: "https://gw.example/api",
    method: "GET",
    paidUrl: "https://gw.example/api",
    requestBody: "",
    responseBody: "{\"ok\":true}",
    httpStatus: 200,
  });
  assert.equal(gatewayLeafFacts({ ...{
    resourceUrl: "https://gw.example/api",
    method: "GET",
    paidUrl: "https://gw.example/api",
    requestBody: "",
    responseBody: "x",
    httpStatus: 70000,
  } }).httpStatus, 0);
  const leaf = {
    nonce: keccak256(toBytes("nonce-1")),
    from: "0x1111111111111111111111111111111111111111" as Address,
    to: PAY_TO as Address,
    value: 1000n,
    resourceHash: facts.resourceHash,
    requestHash: facts.requestHash,
    httpStatus: facts.httpStatus,
    responseHash: facts.responseHash,
  };
  const one = gatewayLeafV1(leaf);
  assert.equal(sortedMerkleRoot([one]), one);
  const two = gatewayLeafV1({ ...leaf, nonce: keccak256(toBytes("nonce-2")) });
  assert.equal(sortedMerkleRoot([one, two]), sortedMerkleRoot([two, one]));
  assert.throws(() => sortedMerkleRoot([]), /empty_merkle/);

  const dir = mkdtempSync(join(tmpdir(), "arc-gateway-root-"));
  const file = join(dir, "records.json");
  writeFileSync(file, JSON.stringify({
    records: [{
      authorization: { nonce: leaf.nonce, from: leaf.from, to: leaf.to, value: leaf.value.toString() },
      resourceHash: leaf.resourceHash,
      requestHash: leaf.requestHash,
      responseHash: leaf.responseHash,
      httpStatus: leaf.httpStatus,
    }],
  }));
  const anchorEnv = { ...process.env, ARC_GATEWAY_RECORDER: "", ARC_GATEWAY_PAYER: "" };
  const ran = spawnSync(process.execPath, [join(ROOT, "scripts/arc-gateway-anchor.mjs"), file], { encoding: "utf8", env: anchorEnv });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, new RegExp(`root ${one}`));
  assert.match(ran.stdout, /forge create/);
  assert.match(ran.stdout, /ARC_GATEWAY_DEPLOYER_KEY/);
  const refused = spawnSync(process.execPath, [join(ROOT, "scripts/arc-gateway-anchor.mjs"), "--broadcast"], { encoding: "utf8", env: anchorEnv });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /refusing to broadcast/);
});

test("ウォレット USDC の読み手は Gateway の残高を読まない", async () => {
  await assert.rejects(
    defaultPayerUsdcBalance({ chain: "arc_gateway", owner: BUYER }),
    /arc_gateway_balance_is_not_wallet_usdc/,
  );
});

test("別枠の SQL は印でネイティブ Arc と Gateway を分ける", () => {
  const native = chainCapNetworkSql("arc", "eip155:5042");
  const gateway = chainCapNetworkSql("arc_gateway", "circle-gateway:5042");
  const nativeText = JSON.stringify(native);
  const gatewayText = JSON.stringify(gateway);
  assert.match(nativeText, /circleGatewayRail/);
  assert.match(gatewayText, /circleGatewayRail/);
  assert.notEqual(nativeText, gatewayText);
});

test("関門の文は 1 箇所だけ（変異が文字列を消したら落ちる）", () => {
  once("src/lib/observatory/arc-gateway.ts", 'return process.env.OBSERVATORY_ARC_GATEWAY_L1_ENABLED === "true"');
  once("src/lib/observatory/arc-gateway.ts", "return available !== null && amount > 0n && available >= amount");
  once("src/lib/observatory/arc-gateway.ts", 'return spent < chainDailyCapUnits("arc_gateway")');
  once("src/lib/observatory/arc-gateway.ts", 'if (options.nativeArcSignable) return { accept: null, reason: "native_present" };');
  once("src/lib/observatory/arc-gateway.ts", "if (extra.verifyingContract.toLowerCase() !== ARC_GATEWAY_WALLET.toLowerCase()) return null;");
  once("src/lib/observatory/arc-gateway.ts", "return sql`network = 'eip155:5042' AND raw_response_meta->>'circleGatewayRail' = 'true'`");
  once("src/lib/observatory/arc-gateway-verify.ts", 'if (input.unresolved || input.debit === null) return "defer"');
  once("src/lib/observatory/arc-gateway-verify.ts", 'if (input.debit === input.rowSum) return "settle"');
  once("src/lib/observatory/arc-gateway-verify.ts", 'if (!hit) return { kind: "absent" }');
  once("src/lib/observatory/budget.ts", 'networkLike: "circle-gateway:5042"');
  once("src/lib/observatory/budget.ts", 'if (network === "eip155:5042") return "arc"');
  once("src/lib/observatory/payer-funds.ts", 'if (chain === "arc_gateway") throw new Error("arc_gateway_balance_is_not_wallet_usdc")');
  once("src/lib/observatory/l1-runner.ts", '{ chain: "arc_gateway", ready: isArcGatewayL1Enabled() && !!process.env.ARC_RPC_URL?.trim() }');
  once("src/lib/observatory/l1-runner.ts", "if (!arcGatewayFundsOk(available, amount))");
  once("src/lib/observatory/l1-runner.ts", "arcGatewayCapOpen(spentNow)");
  once("src/lib/observatory/l1-runner.ts", "extraWhere: SQL = gatewayPrimaryExclusionSql()");
  once("src/lib/observatory/arc-gateway.ts", 'if (paid === null) return "settle_failed"; // gateway_no_seller_response');
  once("src/lib/observatory/arc-gateway.ts", 'if (claimedSettlement) return "settle_claimed"; // gateway_receipt_not_settled');
  once("src/lib/observatory/l1-runner.ts", "const claimedTx = isArcGateway ? null :");
  once("src/lib/observatory/l1-runner.ts", "nativeArcSignable: hasSignableNativeArcAccept(challenge.accepts)");
  once("src/lib/observatory/l1-runner.ts", 'if (!laneOpen("arc_gateway")) return []');
  once("src/lib/observatory/l1-runner.ts", 'const gatewayExclusions: SQL[] = laneExclusionChains.filter((x) => x.chain !== "arc")');
  once("src/lib/settlements/recover-late.ts", "AND coalesce(pu.raw_response_meta->>'circleGatewayRail', '') <> 'true'");
  once("src/lib/observatory/settlement-source.ts", "THEN 'circle_gateway'");
  once("src/lib/observatory/settlement-verifier.ts", "summary.verified += gateway.settled");
  once("src/lib/observatory/settlement-verifier.ts", "summary.gatewayDeferred = gateway.deferred");
  once("src/lib/observatory/settlement-verifier.ts", "summary.gatewayNoted = gateway.noted");
  once("src/lib/observatory/settlement-verifier.ts", "const gateway = await reconcileArcGatewayClaims(");
  once("src/lib/observatory/arc-gateway.ts", "if (typeof rec.maxTimeoutSeconds === \"number\" && rec.maxTimeoutSeconds > ARC_GATEWAY_MAX_TIMEOUT_SECONDS) return null;");
  once("src/lib/observatory/arc-gateway.ts", 'if (!gatewayAuthWindowOk(authorization.validBefore, nowSec)) throw new Error("gateway_validity_window");');
  once("src/lib/observatory/arc-gateway.ts", 'if (options.otherChainSignable) return { accept: null, reason: "native_present" };');
  once("src/lib/observatory/arc-gateway.ts", "if (!isArcGatewayL1Enabled()) return sql``;");
  once("src/lib/observatory/arc-gateway.ts", 'if (anyOverCap) return { accept: null, reason: "over_cap" };');
  once("src/lib/observatory/arc-gateway.ts", 'body: JSON.stringify({ token: "USDC", sources: [{ depositor, domain: ARC_GATEWAY_DOMAIN }] })');
  once("src/lib/observatory/arc-gateway.ts", 'if (paid.status === 402 || paid.status >= 500) return "settle_failed"; // gateway_seller_refused');
  once("src/lib/observatory/arc-gateway-words.ts", 'export const GATEWAY_NOT_CHARGED_EXPIRED = "gateway_not_charged_expired";');
  once("src/lib/observatory/arc-gateway-verify.ts", "if (input.otherBuyerMovement) return { kind: \"defer\" };");
  once("src/lib/observatory/arc-gateway-verify.ts", "const signal = AbortSignal.timeout(budget);");
  once("src/lib/observatory/arc-gateway-verify.ts", 'if (decoded.kind === "amount") return decoded;');
  once("src/lib/observatory/arc-gateway-verify.ts", "if (read.kind === \"use_balance\" && balanceDelta !== null && balanceDelta >= 0n) return balanceDelta;");
  once("src/lib/observatory/arc-gateway-verify.ts", "if (loaded.unresolved > 0) {");
  once("src/lib/observatory/arc-gateway-verify.ts", "AND pu.status IN ('settle_claimed', 'settle_failed', 'delivered_no_receipt', 'settle_claimed_unverifiable')");
  once("src/lib/observatory/l1-runner.ts", "if (!gatewayAuthWindowOk(gatewaySigned.authorization.validBefore, nowSec)) {");
  once("src/lib/observatory/l1-runner.ts", 'logServerErrorSafe("observatory.l1.arc_gateway_balance", error)');
  once("src/lib/observatory/l1-runner.ts", 'if (onlyEndpointId && isArcGatewayL1Enabled() && laneSelectable.get("arc_gateway") === true) {');
  once("ops/arc-gateway/DeliveryLedger.sol", "if (recorder_ == address(0)) revert ZeroRecorder();");
  once("ops/arc-gateway/DeliveryLedger.sol", "if (delivered > purchases) revert DeliveredExceedsPurchases();");
  once("src/lib/observatory/arc-gateway-root.ts", 'return { ok: false, reason: "missing_hash" };');
  once("scripts/arc-gateway-anchor.mjs", 'if (recorderAddress !== "" && payerAddress !== "" && recorderAddress === payerAddress) {');
  assert.equal(read("src/lib/observatory/settlement-verifier.ts").includes("summary.scanned += gateway"), false);
  once("src/lib/observatory/reader.ts", "settlementSourceOf({ txHash: rest.txHash, lateSettlement, circleGateway })");
  const sqlText = settlementSourceSql("pu");
  assert.ok(sqlText.indexOf("'circle_gateway'") < sqlText.indexOf("tx_hash IS NULL"));
  assert.ok(read("public/llms.txt").includes("`circle_gateway` (a Circle Gateway batch transaction kept beside the row)"));
  assert.ok(read("docs/openapi.yaml").includes("circle_gateway"));
  assert.ok(!read("src/components/site/supported-chains-data.ts").includes('chain: "Circle Gateway"'));
  const env = read(".env.example");
  const block = env.slice(env.indexOf("# Circle Gateway on Arc"), env.indexOf("# Celo mainnet"));
  assert.ok(block.includes("OBSERVATORY_ARC_GATEWAY_L1_ENABLED=false"));
  assert.ok(block.includes("L1_ARC_GATEWAY_DAILY_CAP_USD="));
  assert.ok(!/[;—–]/.test(block) && !/--/.test(block), "the new env block keeps the public punctuation rules");
  assert.ok(!/\b(we|our|us)\b/i.test(block));
  assert.ok(block.includes("604900"));
  assert.ok(block.includes("7 days + 100 seconds"));
  assert.equal(block.includes("getBalances"), false);
  const absent = "This value is absent while the Arc Gateway lane flag is off.";
  assert.ok(read("public/llms.txt").includes(absent));
  assert.ok(read("docs/openapi.yaml").includes(absent));
  assert.equal(read("src/lib/observatory/l1-runner.ts").includes("gateway_not_charged_expired"), false);
  assert.equal(read("src/lib/observatory/decisions.ts").includes("gateway_not_charged_expired"), false);
});

function facts(over: Partial<SellerRowFacts>): SellerRowFacts {
  return {
    endpointId: "ep",
    status: "settle_failed",
    httpStatusPaid: null,
    txHash: null,
    attemptedAt: "2026-10-01T00:00:00Z",
    network: "eip155:5042",
    method: "GET",
    meta: null,
    schema: null,
    unpaidStatus: null,
    selection: null,
    verifyReason: null,
    ...over,
  };
}

function addrTopic(addr: string): Hex {
  return `0x${addr.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

test("購入元の履歴が 100 件でも、nonce の請求と自社の行の合計で照合する", async () => {
  const sibling = { id: "row-2", status: "settled", payer: BUYER, circleGateway: auth({ value: "500", nonce: `0x${"cd".repeat(32)}` }), settled: true };
  const settled = await planGatewayReconcile({
    rows: [{ id: "row-1", status: "settle_claimed", payer: BUYER, circleGateway: auth() }],
    verifySignature: async () => true,
    readDebit: async () => 1500n,
    loadBatch: async () => ({ rows: [sibling], unresolved: 0 }),
    lookupNonce: async () => ({ ok: true, body: charged() }),
    nowSec: 1_700_000_000,
  });
  assert.equal(settled[0]?.action, "settle");
  const waiting = await planGatewayReconcile({
    rows: [{ id: "row-1", status: "settle_claimed", payer: BUYER, circleGateway: auth() }],
    verifySignature: async () => true,
    readDebit: async () => 1000n,
    loadBatch: async () => ({ rows: [], unresolved: 1 }),
    lookupNonce: async () => ({ ok: true, body: charged() }),
    nowSec: 1_700_000_000,
  });
  assert.equal(waiting[0]?.action, "defer");
  assert.equal(waiting[0] && "reason" in waiting[0] ? waiting[0].reason : "", "gateway_batch_unresolved");
});

test("長い timeout の accept には署名しない。署名後の窓が上限を超えたら出さない", async () => {
  const huge = gatewayRaw();
  huge.maxTimeoutSeconds = 1e12;
  assert.equal(arcGatewayAcceptOf(huge), null);
  const refused = selectArcGatewayAccept([huge], {
    nativeArcSignable: false,
    declaredAmount: "1000",
    declaredPayTo: PAY_TO,
    declaredNetwork: "eip155:5042",
    gatewayDeclaredPayTos: [PAY_TO],
  });
  assert.deepEqual(refused, { accept: null, reason: "timeout_too_long" });
  const accept = arcGatewayAcceptOf(gatewayRaw());
  assert.ok(accept);
  accept.maxTimeoutSeconds = 1e12;
  await assert.rejects(
    signArcGatewayPayment({ account: privateKeyToAccount(TEST_PK), accept, x402Version: 2, resourceUrl: "https://gw.example/api" }),
    /gateway_validity_window/,
  );
  const now = 1_800_000_000;
  assert.equal(gatewayAuthWindowOk(String(now + ARC_GATEWAY_MAX_TIMEOUT_SECONDS), now), true);
  assert.equal(gatewayAuthWindowOk(String(now + ARC_GATEWAY_MAX_TIMEOUT_SECONDS + 1), now), false);
  assert.equal(gatewayAuthWindowOk(String(now), now), false);
  const realNow = Date.now;
  let tick = 0;
  const start = 1_800_000_000_000;
  Date.now = () => start - tick++ * 5_000;
  try {
    const capped = arcGatewayAcceptOf(gatewayRaw());
    assert.ok(capped);
    await assert.rejects(
      signArcGatewayPayment({ account: privateKeyToAccount(TEST_PK), accept: capped, x402Version: 2, resourceUrl: "https://gw.example/api" }),
      /gateway_validity_window/,
    );
  } finally {
    Date.now = realNow;
  }
});

test("応答なし・402・500 は settle_claimed にしない", () => {
  assert.equal(gatewaySignedStatus(null, false), "settle_failed");
  assert.equal(gatewaySignedStatus(null, true), "settle_failed");
  assert.equal(gatewaySignedStatus({ status: 402 }, true), "settle_failed");
  assert.equal(gatewaySignedStatus({ status: 500 }, true), "settle_failed");
  assert.equal(gatewaySignedStatus({ status: 200 }, false), "delivered_no_receipt");
  assert.equal(gatewaySignedStatus({ status: 200 }, true), "settle_claimed");
});

test("請求が無い行は期限のあと gateway_not_charged_expired になり、refuted とは混ぜない", async () => {
  const expired = await planGatewayReconcile({
    rows: [{ id: "row-1", status: "settle_claimed", payer: BUYER, circleGateway: auth({ validBefore: "100" }) }],
    verifySignature: async () => true,
    readDebit: async () => 1000n,
    loadBatch: async () => ({ rows: [], unresolved: 0 }),
    lookupNonce: async () => ({ ok: true, body: { transfers: [] } }),
    nowSec: 100 + GATEWAY_NOT_CHARGED_GRACE_SECONDS + 1,
  });
  assert.equal(expired[0]?.action, "expire");
  assert.equal(expired[0] && "reason" in expired[0] ? expired[0].reason : "", "gateway_not_charged_expired");
  const fresh = await planGatewayReconcile({
    rows: [{ id: "row-1", status: "settle_claimed", payer: BUYER, circleGateway: auth({ validBefore: "100" }) }],
    verifySignature: async () => true,
    readDebit: async () => 1000n,
    loadBatch: async () => ({ rows: [], unresolved: 0 }),
    lookupNonce: async () => ({ ok: true, body: { transfers: [] } }),
    nowSec: 100 + GATEWAY_NOT_CHARGED_GRACE_SECONDS,
  });
  assert.equal(fresh[0]?.action, "defer");
  const row = classifyRow(facts({ status: GATEWAY_NOT_CHARGED_EXPIRED, verifyReason: GATEWAY_NOT_CHARGED_EXPIRED }));
  assert.equal(row.bucket, "unsorted");
  assert.equal(row.mode?.key, "other");
  assert.equal(row.held, null);
  const byReason = classifyRow(facts({ status: "settle_failed", verifyReason: GATEWAY_NOT_CHARGED_EXPIRED }));
  assert.equal(byReason.bucket, "unsorted");
  assert.equal(DECISION_STATUSES.includes(GATEWAY_NOT_CHARGED_EXPIRED), false);
  assert.equal(DECISION_STATUSES.includes("settle_claim_refuted"), true);
});

test("同じブロックの別の動きでは refute しない", () => {
  const calldata = encodeSubmitBatchCalldata({
    deltas: [
      { depositor: BUYER as `0x${string}`, value: -1000n },
      { depositor: "0x3333333333333333333333333333333333333333", value: 5000n },
    ],
    token: ARC_USDC as `0x${string}`,
    wallet: ARC_GATEWAY_WALLET as `0x${string}`,
  });
  const mixed = gatewayBuyerDebit({ status: "success", to: ARC_GATEWAY_WALLET, calldata, logs: [], buyer: BUYER, otherBuyerMovement: true });
  assert.deepEqual(mixed, { kind: "amount", debit: 1000n });
  const absent = encodeSubmitBatchCalldata({
    deltas: [{ depositor: "0x3333333333333333333333333333333333333333", value: -1000n }],
    token: ARC_USDC as `0x${string}`,
    wallet: ARC_GATEWAY_WALLET as `0x${string}`,
  });
  assert.deepEqual(
    gatewayBuyerDebit({ status: "success", to: ARC_GATEWAY_WALLET, calldata: absent, logs: [], buyer: BUYER, otherBuyerMovement: false }),
    { kind: "defer" },
  );
  const topic = keccak256(toBytes("InsufficientBalance(address,address,uint256,uint256,uint256)"));
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [2000n, 400n, 100n]);
  const short = gatewayBuyerDebit({
    status: "success",
    to: ARC_GATEWAY_WALLET,
    calldata,
    logs: [{ address: ARC_GATEWAY_WALLET, topics: [topic, addrTopic(ARC_USDC), addrTopic(BUYER)], data }],
    buyer: BUYER,
    otherBuyerMovement: true,
  });
  assert.deepEqual(short, { kind: "amount", debit: 500n });
  const undecoded = gatewayBuyerDebit({ status: "success", to: ARC_GATEWAY_WALLET, calldata: "0xdead", logs: [], buyer: BUYER, otherBuyerMovement: true });
  assert.deepEqual(undecoded, { kind: "defer" });
  const isolated = gatewayBuyerDebit({ status: "success", to: ARC_GATEWAY_WALLET, calldata: "0xdead", logs: [], buyer: BUYER, otherBuyerMovement: false });
  assert.deepEqual(isolated, { kind: "use_balance" });
  assert.equal(resolveGatewayDebit(isolated, -1n), null);
  assert.equal(resolveGatewayDebit(isolated, 1000n), 1000n);
});

test("旗 off の候補 SQL は Gateway の句を足さない。Base で払える出品は Gateway で選ばない", () => {
  withEnv("OBSERVATORY_ARC_GATEWAY_L1_ENABLED", undefined, () => {
    assert.equal(JSON.stringify(gatewayPrimaryExclusionSql()).includes("GatewayWalletBatched"), false);
    assert.equal(JSON.stringify(gatewayCandidateInclusionSql()).includes("GatewayWalletBatched"), false);
  });
  withEnv("OBSERVATORY_ARC_GATEWAY_L1_ENABLED", "true", () => {
    const exclusion = JSON.stringify(gatewayPrimaryExclusionSql());
    const inclusion = JSON.stringify(gatewayCandidateInclusionSql());
    assert.match(exclusion, /GatewayWalletBatched/);
    assert.match(exclusion, /eip155:8453/);
    assert.match(inclusion, /GatewayWalletBatched/);
    assert.match(inclusion, /eip155:8453/);
  });
  const base = {
    scheme: "exact",
    network: "eip155:8453",
    amount: "1000",
    asset: BASE_USDC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
  };
  assert.equal(hasSignableOtherRailAccept([base]), true);
  assert.equal(hasSignableOtherRailAccept([gatewayRaw()]), false);
  const picked = selectArcGatewayAccept([gatewayRaw(), base], {
    nativeArcSignable: false,
    otherChainSignable: true,
    declaredAmount: "1000",
    declaredPayTo: PAY_TO,
    declaredNetwork: "eip155:5042",
    gatewayDeclaredPayTos: [PAY_TO],
  });
  assert.deepEqual(picked, { accept: null, reason: "native_present" });
});

test("硬上限を超える額は over_cap。価格が違っていても先に返す", () => {
  const amount = (MAX_PER_PURCHASE_UNITS + 1n).toString();
  const picked = selectArcGatewayAccept([gatewayRaw(PAY_TO, amount)], {
    nativeArcSignable: false,
    declaredAmount: "1000",
    declaredPayTo: PAY_TO,
    declaredNetwork: "eip155:5042",
    gatewayDeclaredPayTos: [PAY_TO],
  });
  assert.deepEqual(picked, { accept: null, reason: "over_cap" });
});

test("Gateway の残高は残高 API だけで読む", async () => {
  assert.equal(parseGatewayUsdc("1.5"), 1_500_000n);
  assert.equal(parseGatewayUsdc("1e6"), null);
  const prev = globalThis.fetch;
  let seen: { url: string; method: string; body: string } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = { url: String(input), method: init?.method ?? "GET", body: String(init?.body ?? "") };
    return new Response(JSON.stringify({ balances: [{ balance: "1.5" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await readArcGatewayAvailable(BUYER), 1_500_000n);
  } finally {
    globalThis.fetch = prev;
  }
  const shot = seen as { url: string; method: string; body: string } | null;
  assert.ok(shot);
  assert.match(shot.url, /\/v1\/balances$/);
  assert.equal(shot.method, "POST");
  assert.match(shot.body, new RegExp(`"domain":${ARC_GATEWAY_DOMAIN}`));
  assert.equal(shot.body.includes("eth_"), false);
  assert.equal(read("src/lib/observatory/arc-gateway.ts").includes("getBalances"), false);
});

test("日次 records の root はアンカーと一致し、ハッシュが欠けたら出さない", () => {
  const factsLeaf = gatewayLeafFacts({
    resourceUrl: "https://gw.example/api",
    method: "GET",
    paidUrl: "https://gw.example/api",
    requestBody: "",
    responseBody: "ok",
    httpStatus: 200,
  });
  const nonce = keccak256(toBytes("day-nonce"));
  const built = buildGatewayDayRecords("2026-10-25", [{
    attemptedAt: "2026-10-25T00:00:00.000Z",
    resourceUrl: "https://gw.example/api",
    method: "GET",
    httpStatus: 200,
    circleGateway: {
      nonce,
      from: BUYER,
      to: PAY_TO,
      value: "1000",
      validAfter: "1",
      validBefore: "2",
      resourceHash: factsLeaf.resourceHash,
      requestHash: factsLeaf.requestHash,
      responseHash: factsLeaf.responseHash,
      httpStatus: 200,
    },
  }]);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.document.purchases, 1);
  assert.equal(built.document.delivered, 1);
  assert.equal(built.document.delivered <= built.document.purchases, true);
  const dir = mkdtempSync(join(tmpdir(), "arc-gateway-day-"));
  const file = join(dir, "records.json");
  writeFileSync(file, JSON.stringify(built.document));
  const ran = spawnSync(process.execPath, [join(ROOT, "scripts/arc-gateway-anchor.mjs"), file], {
    encoding: "utf8",
    env: { ...process.env, ARC_GATEWAY_RECORDER: "", ARC_GATEWAY_PAYER: "" },
  });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, new RegExp(`root ${built.document.root}`));
  const missing = buildGatewayDayRecords("2026-10-25", [{
    attemptedAt: "2026-10-25T00:00:00.000Z",
    resourceUrl: "https://gw.example/api",
    method: "GET",
    httpStatus: 200,
    circleGateway: { nonce, from: BUYER, to: PAY_TO, value: "1000" },
  }]);
  assert.deepEqual(missing, { ok: false, reason: "missing_hash" });
  assert.deepEqual(buildGatewayDayRecords("2026-10-25", []), { ok: false, reason: "empty" });
  const same = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
  const stopped = spawnSync(process.execPath, [join(ROOT, "scripts/arc-gateway-anchor.mjs")], {
    encoding: "utf8",
    env: { ...process.env, ARC_GATEWAY_RECORDER: same, ARC_GATEWAY_PAYER: same },
  });
  assert.equal(stopped.status, 2);
  assert.match(stopped.stderr, /recorder address matches the payer address/);
  const send = spawnSync(join(ROOT, "node_modules/.bin/tsx"), [join(ROOT, "scripts/arc-gateway-records.ts"), "--send"], { encoding: "utf8" });
  assert.equal(send.status, 2);
  assert.match(send.stderr, /refusing to send/);
});
