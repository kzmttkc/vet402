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
import { keccak256, toBytes, type Address } from "viem";

import {
  ARC_GATEWAY_WALLET,
  arcGatewayAcceptOf,
  arcGatewayCapOpen,
  arcGatewayFundsOk,
  chainCapNetworkSql,
  gatewayLeafFacts,
  isArcGatewayL1Enabled,
  selectArcGatewayAccept,
  signArcGatewayPayment,
} from "@/lib/observatory/arc-gateway";
import { gatewayLeafV1, sortedMerkleRoot } from "@/lib/observatory/arc-gateway-root";
import {
  gatewayAuthorizationRecovers,
  interpretGatewayTransfers,
  judgeGatewayBatch,
  planGatewayReconcile,
  readGatewayAuth,
  type GatewayAuth,
} from "@/lib/observatory/arc-gateway-verify";
import { ARC_USDC, hasSignableNativeArcAccept, selectAccept } from "@/lib/observatory/x402-payer";
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
  assert.deepEqual(judgeGatewayBatch({ apiSum: null, rowSum: 1000n, debit: 1000n }), "defer");
  assert.deepEqual(judgeGatewayBatch({ apiSum: 1000n, rowSum: 1000n, debit: null }), "defer");
  assert.deepEqual(judgeGatewayBatch({ apiSum: 1000n, rowSum: 1000n, debit: 1000n }), "settle");
  assert.deepEqual(judgeGatewayBatch({ apiSum: 1000n, rowSum: 1000n, debit: 999n }), "refute");

  const row = { id: "row-1", status: "settle_claimed", payer: BUYER, circleGateway: auth() };
  const base = {
    rows: [row],
    verifySignature: async () => true,
    readDebit: async () => 1000n,
    listFromBuyer: async () => ({ ok: true as const, body: charged() }),
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
  const ran = spawnSync(process.execPath, [join(ROOT, "scripts/arc-gateway-anchor.mjs"), file], { encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, new RegExp(`root ${one}`));
  assert.match(ran.stdout, /forge create/);
  assert.match(ran.stdout, /ARC_GATEWAY_DEPLOYER_KEY/);
  const refused = spawnSync(process.execPath, [join(ROOT, "scripts/arc-gateway-anchor.mjs"), "--broadcast"], { encoding: "utf8" });
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
  once("src/lib/observatory/arc-gateway-verify.ts", 'if (input.apiSum === null || input.apiSum !== input.rowSum || input.debit === null) return "defer"');
  once("src/lib/observatory/arc-gateway-verify.ts", 'if (input.debit === input.rowSum) return "settle"');
  once("src/lib/observatory/arc-gateway-verify.ts", 'if (!hit) return { kind: "absent" }');
  once("src/lib/observatory/budget.ts", 'networkLike: "circle-gateway:5042"');
  once("src/lib/observatory/budget.ts", 'if (network === "eip155:5042") return "arc"');
  once("src/lib/observatory/payer-funds.ts", 'if (chain === "arc_gateway") throw new Error("arc_gateway_balance_is_not_wallet_usdc")');
  once("src/lib/observatory/l1-runner.ts", '{ chain: "arc_gateway", ready: isArcGatewayL1Enabled() && !!process.env.ARC_RPC_URL?.trim() }');
  once("src/lib/observatory/l1-runner.ts", "if (!arcGatewayFundsOk(available, amount))");
  once("src/lib/observatory/l1-runner.ts", "arcGatewayCapOpen(spentNow)");
  once("src/lib/observatory/l1-runner.ts", "extraWhere: SQL = gatewayPrimaryExclusionSql()");
  once("src/lib/observatory/l1-runner.ts", 'const status = isArcGateway ? "settle_claimed"');
  once("src/lib/observatory/l1-runner.ts", "const claimedTx = isArcGateway ? null :");
  once("src/lib/observatory/l1-runner.ts", "nativeArcSignable: hasSignableNativeArcAccept(challenge.accepts)");
  once("src/lib/observatory/l1-runner.ts", 'if (!laneOpen("arc_gateway")) return []');
  once("src/lib/observatory/l1-runner.ts", 'const gatewayExclusions: SQL[] = laneExclusionChains.filter((x) => x.chain !== "arc")');
  once("src/lib/settlements/recover-late.ts", "AND coalesce(pu.raw_response_meta->>'circleGatewayRail', '') <> 'true'");
  once("src/lib/observatory/settlement-source.ts", "THEN 'circle_gateway'");
  once("src/lib/observatory/settlement-verifier.ts", "summary.verified += gateway.settled");
  once("src/lib/observatory/settlement-verifier.ts", "const gateway = await reconcileArcGatewayClaims(");
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
});
