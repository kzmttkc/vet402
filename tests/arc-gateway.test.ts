// Circle Gateway on Arc. The rail signs only a pinned GatewayWalletBatched accept,
// and only when the live challenge has no signable native Arc USDC accept.
// A charge is not settled until the Gateway API names a batch tx whose debit matches.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
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
  GATEWAY_RESOURCE_MAX_BYTES,
  gatewaySellerResource,
  chainCapNetworkSql,
  gatewayAuthWindowOk,
  gatewayCandidateInclusionSql,
  gatewayLeafFacts,
  gatewayPrimaryExclusionSql,
  gatewayRootWaitNote,
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
  GATEWAY_BATCH_CLOCK_SKEW_SECONDS,
  GATEWAY_RECONCILE_BUDGET_MS,
  GATEWAY_RECONCILE_ROW_LIMIT,
  GATEWAY_REREAD_SHARE_DENOMINATOR,
  GATEWAY_REREAD_SHARE_NUMERATOR,
  GATEWAY_VALID_AFTER_LEAD_SECONDS,
  gatewayAuthorizationRecovers,
  gatewayBuyerDebit,
  gatewayReadBudgetMs,
  gatewayReadSlots,
  gatewaySignatureTimeSec,
  interleaveGatewayRows,
  interpretGatewayTransfers,
  judgeGatewayBatch,
  planGatewayReconcile,
  readGatewayAuth,
  resolveGatewayDebit,
  unreadAuthorizationCanEnterBatch,
  type GatewayAuth,
  type GatewayClaimRow,
} from "@/lib/observatory/arc-gateway-verify";
import { ARC_USDC, BASE_USDC, hasSignableNativeArcAccept, selectAccept, MAX_PER_PURCHASE_UNITS } from "@/lib/observatory/x402-payer";
import { STELLAR_USDC_CLASSIC, STELLAR_USDC_SAC } from "@/lib/observatory/stellar402-payer";
import { createDeadline } from "@/lib/util/deadline";
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

test("Gateway の accepted は売り手の verifyingContract の表記をそのまま返す。署名のドメインはピンのまま", async () => {
  // 2026-10-27 本番: api.aisa.one は小文字の verifyingContract を出し、チェックサム形を返したら
  // payment_requirements_mismatch で断られた。売り手の accept をそのまま使う。
  const seller = {
    asset: "0x3600000000000000000000000000000000000000",
    extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee" },
    payTo: "0xBd7b9f3e0CD3E1f6e698D0eeBb99F96E093BdeE3",
    amount: "100000",
    scheme: "exact",
    network: "eip155:5042",
    maxTimeoutSeconds: 604900,
  };
  const accept = arcGatewayAcceptOf(seller);
  assert.ok(accept);
  assert.equal(accept.extra?.verifyingContract, seller.extra.verifyingContract);
  const account = privateKeyToAccount(TEST_PK);
  const signed = await signArcGatewayPayment({ account, accept, x402Version: 2, resourceUrl: "https://gw.example/api" });
  const decoded = JSON.parse(Buffer.from(signed.header.headerValue, "base64").toString("utf8")) as { accepted?: unknown };
  assert.deepEqual(decoded.accepted, seller);
  assert.equal(signed.verifyingContract, ARC_GATEWAY_WALLET);
  assert.equal(
    await gatewayAuthorizationRecovers({ ...signed.authorization, signature: signed.signature, verifyingContract: signed.verifyingContract }, account.address),
    true,
  );

  const upper = arcGatewayAcceptOf(gatewayRaw(PAY_TO, "1000", "0x77777777DCC4D5A8B6E418FD04D8997EF11000EE"));
  assert.equal(upper?.extra?.verifyingContract, "0x77777777DCC4D5A8B6E418FD04D8997EF11000EE");

  const other = "0x77777777dcc4d5a8b6e418fd04d8997ef11000ef";
  assert.equal(arcGatewayAcceptOf({ ...seller, extra: { ...seller.extra, verifyingContract: other } }), null);
  assert.equal(arcGatewayAcceptOf({ ...seller, extra: { name: "GatewayWalletBatched", version: "1" } }), null);
  for (const extra of [
    { name: "GatewayWalletBatched", version: "1", verifyingContract: other },
    { name: "GatewayWalletBatched", version: "1" },
    undefined,
  ]) {
    await assert.rejects(
      signArcGatewayPayment({ account, accept: { ...accept, extra }, x402Version: 2, resourceUrl: "https://gw.example/api" }),
      /gateway_verifying_contract_mismatch/,
    );
  }
});

test("Gateway の resource は売り手の 402 の文書のまま返す。無い・4KB 超は絶対 URL に戻す", async () => {
  // 2026-10-27 本番の api.aisa.one の PAYMENT-REQUIRED。相対 url を書き換えない。
  const prodResource = { url: "/apis/v2/apollo/emailer_campaigns/search", mimeType: "application/json", description: "Paid resource" };
  const seller = {
    scheme: "exact",
    network: "eip155:5042",
    asset: "0x3600000000000000000000000000000000000000",
    amount: "100000",
    payTo: "0xBd7b9f3e0CD3E1f6e698D0eeBb99F96E093BdeE3",
    maxTimeoutSeconds: 604900,
    extra: { name: "GatewayWalletBatched", version: "1", verifyingContract: "0x77777777dcc4d5a8b6e418fd04d8997ef11000ee" },
  };
  const b64 = (doc: unknown) => Buffer.from(JSON.stringify(doc)).toString("base64");
  const prodHeaders = new Headers({ "PAYMENT-REQUIRED": b64({ x402Version: 2, resource: prodResource, accepts: [seller] }) });
  const sellerResource = gatewaySellerResource({ bodyText: "{}", headers: prodHeaders });
  assert.deepEqual(sellerResource, prodResource);

  const accept = arcGatewayAcceptOf(seller);
  assert.ok(accept);
  const account = privateKeyToAccount(TEST_PK);
  const resourceUrl = "https://api.aisa.one/apis/v2/apollo/emailer_campaigns/search";
  const decode = (v: string) => JSON.parse(Buffer.from(v, "base64").toString("utf8")) as { resource?: unknown; accepted?: unknown };
  const signed = await signArcGatewayPayment({ account, accept, x402Version: 2, resourceUrl, sellerResource });
  assert.equal(JSON.stringify(decode(signed.header.headerValue).resource), JSON.stringify(prodResource));
  assert.deepEqual(decode(signed.header.headerValue).accepted, seller);

  for (const missing of [undefined, null]) {
    const fallback = await signArcGatewayPayment({ account, accept, x402Version: 2, resourceUrl, sellerResource: missing });
    assert.deepEqual(decode(fallback.header.headerValue).resource, { url: resourceUrl });
  }

  // 文書に resource が無い・object でない → null（絶対 URL の形に戻る）
  assert.equal(gatewaySellerResource({ bodyText: "", headers: new Headers({ "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [seller] }) }) }), null);
  for (const bad of ["/x", ["/x"], null, 1]) {
    assert.equal(gatewaySellerResource({ bodyText: JSON.stringify({ x402Version: 2, resource: bad, accepts: [seller] }), headers: new Headers() }), null);
  }
  // 4KB の境界
  const pad = (n: number) => ({ url: "/x", description: "d".repeat(n) });
  const base = Buffer.byteLength(JSON.stringify(pad(0)), "utf8");
  const atCap = pad(GATEWAY_RESOURCE_MAX_BYTES - base);
  const overCap = pad(GATEWAY_RESOURCE_MAX_BYTES - base + 1);
  assert.deepEqual(gatewaySellerResource({ bodyText: JSON.stringify({ x402Version: 2, resource: atCap, accepts: [seller] }), headers: new Headers() }), atCap);
  assert.equal(gatewaySellerResource({ bodyText: JSON.stringify({ x402Version: 2, resource: overCap, accepts: [seller] }), headers: new Headers() }), null);
  // accepts を読んだ文書の resource を使う（ヘッダが読めればヘッダ、読めなければ本文）
  const bodyDoc = JSON.stringify({ x402Version: 2, resource: { url: "/body" }, accepts: [seller] });
  assert.deepEqual(gatewaySellerResource({ bodyText: bodyDoc, headers: prodHeaders }), prodResource);
  assert.deepEqual(gatewaySellerResource({ bodyText: bodyDoc, headers: new Headers({ "PAYMENT-REQUIRED": "not-base64-json" }) }), { url: "/body" });
  assert.equal(gatewaySellerResource({ bodyText: bodyDoc, headers: new Headers({ "PAYMENT-REQUIRED": b64({ x402Version: 2, accepts: [seller] }) }) }), null);
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
  assert.deepEqual(judgeGatewayBatch({ rowSum: 1000n, debit: 999n, unresolved: true }), "refute");
  assert.deepEqual(judgeGatewayBatch({ rowSum: 1000n, debit: 1001n }), "defer");
  assert.deepEqual(judgeGatewayBatch({ rowSum: 1000n, debit: 1001n, unresolved: true }), "defer");

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
  const anchorEnv = { ...process.env, ARC_GATEWAY_RECORDER: BUYER, ARC_GATEWAY_PAYER: PAY_TO };
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
  once("src/lib/observatory/arc-gateway-verify.ts", 'if (input.debit === null) return "defer";');
  once("src/lib/observatory/arc-gateway-verify.ts", 'if (input.debit < input.rowSum) return "refute";');
  once("src/lib/observatory/arc-gateway-verify.ts", 'if (input.debit > input.rowSum) return "defer";');
  once("src/lib/observatory/arc-gateway-verify.ts", 'if (input.unresolved) return "defer";');
  once("src/lib/observatory/arc-gateway-verify.ts", 'if (input.debit === input.rowSum) return "settle";');
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
  once("src/lib/observatory/settlement-verifier.ts", "summary.gatewayExpired = gateway.expired");
  once("src/lib/observatory/settlement-verifier.ts", "summary.gatewayOverDebit = gateway.overDebit");
  once("src/lib/observatory/settlement-verifier.ts", "createDeadline(gatewayReadBudgetMs(deadline.remaining()))");
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
  once("src/lib/observatory/arc-gateway-verify.ts", "const unresolved = loaded.unresolved > 0 || buyersBlocked.has(buyer);");
  once("src/lib/observatory/arc-gateway-verify.ts", 'if (lookup.reason === "budget") break;');
  once("src/lib/observatory/arc-gateway-verify.ts", 'const expires = hit.kind !== "pending" && pastGrace(auth, nowSec);');
  once("src/lib/observatory/arc-gateway-verify.ts", "export const GATEWAY_RECONCILE_BUDGET_MS = 75_000;");
  once("src/lib/observatory/arc-gateway-verify.ts", "export const GATEWAY_RECONCILE_ROW_LIMIT = 2_000;");
  once("src/lib/observatory/arc-gateway-verify.ts", "export const GATEWAY_REREAD_SHARE_NUMERATOR = 1;");
  once("src/lib/observatory/arc-gateway-verify.ts", "export const GATEWAY_REREAD_SHARE_DENOMINATOR = 5;");
  once("src/lib/observatory/settlement-verifier.ts", "limit: GATEWAY_RECONCILE_ROW_LIMIT,");
  once("src/lib/observatory/arc-gateway-verify.ts", "for (const plan of plans) {");
  once("src/lib/observatory/arc-gateway-verify.ts", "AND pu.status IN ('settle_claimed', 'settle_failed', 'delivered_no_receipt', 'settle_claimed_unverifiable')");
  once("src/lib/observatory/l1-runner.ts", "if (!gatewayAuthWindowOk(gatewaySigned.authorization.validBefore, nowSec)) {");
  once("src/lib/observatory/l1-runner.ts", 'logServerErrorSafe("observatory.l1.arc_gateway_balance", error)');
  once("src/lib/observatory/l1-runner.ts", 'if (onlyEndpointId && isArcGatewayL1Enabled() && laneSelectable.get("arc_gateway") === true) {');
  once("ops/arc-gateway/DeliveryLedger.sol", "if (recorder_ == address(0)) revert ZeroRecorder();");
  once("ops/arc-gateway/DeliveryLedger.sol", "if (delivered > purchases) revert DeliveredExceedsPurchases();");
  once("src/lib/observatory/arc-gateway-root.ts", 'return { ok: false, reason: "missing_hash" };');
  once("scripts/arc-gateway-anchor.mjs", 'if (recorderAddress === "" || payerAddress === "") {');
  once("scripts/arc-gateway-anchor.mjs", "if (recorderAddress === payerAddress) {");
  once("src/lib/observatory/arc-gateway.ts", 'if (stellarRailConfigured() && network === "stellar:pubnet" && (asset === STELLAR_USDC_CLASSIC || asset === STELLAR_USDC_SAC)) return true;');
  once("scripts/arc-gateway-records.ts", "(${dayArg}::timestamp AT TIME ZONE 'UTC')");
  once("scripts/arc-gateway-records.ts", "gatewayRootWaitNote(dayArg)");
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
  assert.ok(block.includes("8 days and 100 seconds"));
  assert.ok(block.includes("pending row does not expire"));
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

test("T_B より前に署名した未照会はバッチを止め、後に署名した未照会は止めない", async () => {
  assert.equal(GATEWAY_VALID_AFTER_LEAD_SECONDS, 600);
  assert.equal(gatewaySignatureTimeSec("1000"), 1600n);
  assert.equal(gatewaySignatureTimeSec(null), null);
  assert.equal(gatewaySignatureTimeSec("10.5"), null);
  const block = 2_000_000_000n;
  const planFor = (signature: bigint) =>
    planGatewayReconcile({
      rows: [{ id: "row-1", status: "settle_claimed", payer: BUYER, circleGateway: auth() }],
      verifySignature: async () => true,
      readDebit: async () => 1000n,
      readBatchTime: async () => block,
      loadBatch: async () => ({
        rows: [],
        unresolved: 0,
        unread: { earliestValidAfter: (signature - 600n).toString(), unreadable: 0 },
      }),
      lookupNonce: async () => ({ ok: true, body: charged() }),
      nowSec: 1_700_000_000,
    });
  const blocked = await planFor(block - 10_000n);
  assert.equal(blocked[0]?.action, "defer");
  assert.equal(blocked[0] && "reason" in blocked[0] ? blocked[0].reason : "", "gateway_batch_unresolved");
  const open = await planFor(block + 10n);
  assert.equal(open[0]?.action, "settle");
  const onMargin = await planFor(block - 60n);
  assert.equal(onMargin[0]?.action, "defer");
  const pastMargin = await planFor(block - 59n);
  assert.equal(pastMargin[0]?.action, "settle");
  const unreadable = await planGatewayReconcile({
    rows: [{ id: "row-1", status: "settle_claimed", payer: BUYER, circleGateway: auth() }],
    verifySignature: async () => true,
    readDebit: async () => 1000n,
    readBatchTime: async () => block,
    loadBatch: async () => ({ rows: [], unresolved: 0, unread: { earliestValidAfter: null, unreadable: 1 } }),
    lookupNonce: async () => ({ ok: true, body: charged() }),
    nowSec: 1_700_000_000,
  });
  assert.equal(unreadable[0]?.action, "defer");
  assert.equal(unreadAuthorizationCanEnterBatch(null, block), true);
  assert.equal(unreadAuthorizationCanEnterBatch(block + 10n, null), true);
});

test("署名時刻とブロック時刻の余裕は境界で分かれる", () => {
  assert.equal(GATEWAY_BATCH_CLOCK_SKEW_SECONDS, 60);
  const block = 2_000_000_000n;
  assert.equal(unreadAuthorizationCanEnterBatch(block - 60n, block), true);
  assert.equal(unreadAuthorizationCanEnterBatch(block - 59n, block), false);
  assert.equal(unreadAuthorizationCanEnterBatch(block, block), false);
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
    assert.equal(JSON.stringify(gatewayCandidateInclusionSql()), JSON.stringify(sql`AND false`));
  });
  withEnv("OBSERVATORY_ARC_GATEWAY_L1_ENABLED", "true", () => {
    const exclusion = JSON.stringify(gatewayPrimaryExclusionSql());
    const inclusion = JSON.stringify(gatewayCandidateInclusionSql());
    assert.match(exclusion, /GatewayWalletBatched/);
    assert.match(exclusion, /eip155:8453/);
    assert.match(inclusion, /GatewayWalletBatched/);
    assert.match(inclusion, /eip155:8453/);
    assert.equal(/\bsource\b/.test(inclusion), false);
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
    env: { ...process.env, ARC_GATEWAY_RECORDER: BUYER, ARC_GATEWAY_PAYER: PAY_TO },
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
  const missingPayer = spawnSync(process.execPath, [join(ROOT, "scripts/arc-gateway-anchor.mjs")], {
    encoding: "utf8",
    env: { ...process.env, ARC_GATEWAY_RECORDER: BUYER, ARC_GATEWAY_PAYER: "" },
  });
  assert.equal(missingPayer.status, 2);
  assert.match(missingPayer.stderr, /ARC_GATEWAY_PAYER/);
  const missingRecorder = spawnSync(process.execPath, [join(ROOT, "scripts/arc-gateway-anchor.mjs")], {
    encoding: "utf8",
    env: { ...process.env, ARC_GATEWAY_RECORDER: "", ARC_GATEWAY_PAYER: PAY_TO },
  });
  assert.equal(missingRecorder.status, 2);
  assert.match(missingRecorder.stderr, /ARC_GATEWAY_RECORDER/);
  const send = spawnSync(join(ROOT, "node_modules/.bin/tsx"), [join(ROOT, "scripts/arc-gateway-records.ts"), "--send"], { encoding: "utf8" });
  assert.equal(send.status, 2);
  assert.match(send.stderr, /refusing to send/);
  const note = gatewayRootWaitNote("2026-10-25");
  assert.match(note, /8 days and 100 seconds/);
  assert.match(note, /pending charge does not expire/);
  assert.equal(/[;—–]/.test(note) || /--/.test(note), false);
  assert.equal(/\b(we|our|us)\b/i.test(note), false);
});

test("減額が行の合計より大きいときは refute せず、pending は期限切れにしない", async () => {
  const row = { id: "row-1", status: "settle_claimed", payer: BUYER, circleGateway: auth() };
  const base = {
    rows: [row],
    verifySignature: async () => true,
    loadBatch: async () => ({ rows: [] as GatewayClaimRow[], unresolved: 0 }),
    nowSec: 1_700_000_000,
  };
  const over = await planGatewayReconcile({
    ...base,
    lookupNonce: async () => ({ ok: true, body: charged() }),
    readDebit: async () => 1001n,
  });
  assert.equal(over[0]?.action, "defer");
  assert.equal(over[0] && "reason" in over[0] ? over[0].reason : "", "gateway_debit_exceeds_rows");
  const pending = await planGatewayReconcile({
    ...base,
    rows: [{ id: "row-1", status: "settle_claimed", payer: BUYER, circleGateway: auth({ validBefore: "100" }) }],
    lookupNonce: async () => ({ ok: true, body: { transfers: [{ nonce: NONCE, status: "batched" }] } }),
    readDebit: async () => 1000n,
    nowSec: 100 + GATEWAY_NOT_CHARGED_GRACE_SECONDS + 5,
  });
  assert.equal(pending[0]?.action, "defer");
  assert.equal(pending[0] && "reason" in pending[0] ? pending[0].reason : "", "gateway_pending");
  const failed = await planGatewayReconcile({
    ...base,
    rows: [{ id: "row-1", status: "settle_claimed", payer: BUYER, circleGateway: auth({ validBefore: "100" }) }],
    lookupNonce: async () => ({ ok: true, body: { transfers: [{ nonce: NONCE, status: "failed" }] } }),
    readDebit: async () => 1000n,
    nowSec: 100 + GATEWAY_NOT_CHARGED_GRACE_SECONDS + 5,
  });
  assert.equal(failed[0]?.action, "expire");
});

test("予算切れは購入元を止めず、判定済みの行は settle のまま残る", async () => {
  const first = { id: "row-1", status: "settle_claimed", payer: BUYER, circleGateway: auth() };
  const secondNonce = `0x${"ef".repeat(32)}`;
  const second = { id: "row-2", status: "settle_claimed", payer: BUYER, circleGateway: auth({ nonce: secondNonce }) };
  const plans = await planGatewayReconcile({
    rows: [first, second],
    verifySignature: async () => true,
    loadBatch: async () => ({ rows: [] as GatewayClaimRow[], unresolved: 0 }),
    readDebit: async () => 1000n,
    lookupNonce: async (nonce) => (nonce === secondNonce ? { ok: false, reason: "budget" } : { ok: true, body: charged() }),
    nowSec: 1_700_000_000,
  });
  assert.equal(plans.find((p) => p.id === "row-1")?.action, "settle");
  assert.equal(plans.find((p) => p.id === "row-2"), undefined);
  const blocked = await planGatewayReconcile({
    rows: [first, second],
    verifySignature: async () => true,
    loadBatch: async () => ({ rows: [] as GatewayClaimRow[], unresolved: 0 }),
    readDebit: async () => 500n,
    lookupNonce: async (nonce) =>
      nonce === NONCE
        ? { ok: false }
        : { ok: true, body: { transfers: [{ nonce: secondNonce, status: "confirmed", txHash: TX, from: BUYER, amount: "1000" }] } },
    nowSec: 1_700_000_000,
  });
  assert.equal(blocked.find((p) => p.id === "row-2")?.action, "refute");
});

test("API の失敗と不完全な頁は購入元を止めない。記録できない照会は止める", async () => {
  const first = { id: "row-1", status: "settle_claimed", payer: BUYER, circleGateway: auth() };
  const secondNonce = `0x${"ef".repeat(32)}`;
  const secondTx = `0x${"ab".repeat(32)}`;
  const second = { id: "row-2", status: "settle_claimed", payer: BUYER, circleGateway: auth({ nonce: secondNonce }) };
  const chargedSecond = {
    transfers: [{ nonce: secondNonce, status: "confirmed", txHash: secondTx, from: BUYER, amount: "1000" }],
  };
  const open = await planGatewayReconcile({
    rows: [first, second],
    verifySignature: async () => true,
    loadBatch: async () => ({ rows: [] as GatewayClaimRow[], unresolved: 0 }),
    readDebit: async () => 1000n,
    lookupNonce: async (nonce) => (nonce === NONCE ? { ok: false } : { ok: true, body: chargedSecond }),
    nowSec: 1_700_000_000,
  });
  const failed = open.find((p) => p.id === "row-1");
  assert.equal(failed?.action, "defer");
  assert.equal(failed && "reason" in failed ? failed.reason : "", "gateway_api_error");
  assert.equal(open.find((p) => p.id === "row-2")?.action, "settle");
  const full = Array.from({ length: 100 }, (_, i) => ({ nonce: `0x${i.toString(16).padStart(64, "0")}`, status: "confirmed", txHash: TX, amount: "1" }));
  const page = await planGatewayReconcile({
    rows: [first, second],
    verifySignature: async () => true,
    loadBatch: async () => ({ rows: [] as GatewayClaimRow[], unresolved: 0 }),
    readDebit: async () => 1000n,
    lookupNonce: async (nonce) => (nonce === NONCE ? { ok: true, body: { transfers: full } } : { ok: true, body: chargedSecond }),
    nowSec: 1_700_000_000,
  });
  const missed = page.find((p) => p.id === "row-1");
  assert.equal(missed?.action, "defer");
  assert.equal(missed && "reason" in missed ? missed.reason : "", "gateway_incomplete");
  assert.equal(page.find((p) => p.id === "row-2")?.action, "settle");
  const stillUnread = await planGatewayReconcile({
    rows: [first, second],
    verifySignature: async () => true,
    readDebit: async () => 1000n,
    readBatchTime: async () => 2_000_000_000n,
    loadBatch: async () => ({ rows: [] as GatewayClaimRow[], unresolved: 0, unread: { earliestValidAfter: "1000", unreadable: 0 } }),
    lookupNonce: async (nonce) => (nonce === NONCE ? { ok: false } : { ok: true, body: chargedSecond }),
    nowSec: 1_700_000_000,
  });
  const held = stillUnread.find((p) => p.id === "row-2");
  assert.equal(held?.action, "defer");
  assert.equal(held && "reason" in held ? held.reason : "", "gateway_batch_unresolved");
  const unstored = await planGatewayReconcile({
    rows: [first, second],
    verifySignature: async () => true,
    loadBatch: async () => ({ rows: [] as GatewayClaimRow[], unresolved: 0 }),
    readDebit: async () => 1000n,
    rememberLookup: async () => {
      throw new Error("remember_failed");
    },
    lookupNonce: async (nonce) => (nonce === NONCE ? { ok: true, body: charged() } : { ok: true, body: chargedSecond }),
    nowSec: 1_700_000_000,
  });
  const blocked = unstored.find((p) => p.id === "row-1");
  assert.equal(blocked?.action, "defer");
  assert.equal(blocked && "reason" in blocked ? blocked.reason : "", "gateway_batch_unresolved");
  assert.equal(unstored.find((p) => p.id === "row-2")?.action, "defer");
});

test("読み直しの枠は Gateway の limit の 5 分の 1 で、5 件未満は 0", () => {
  assert.equal(GATEWAY_RECONCILE_ROW_LIMIT, 2_000);
  assert.equal(GATEWAY_REREAD_SHARE_NUMERATOR, 1);
  assert.equal(GATEWAY_REREAD_SHARE_DENOMINATOR, 5);
  assert.deepEqual(gatewayReadSlots(0), { fresh: 0, reread: 0 });
  assert.deepEqual(gatewayReadSlots(-3), { fresh: 0, reread: 0 });
  assert.deepEqual(gatewayReadSlots(Number.NaN), { fresh: 0, reread: 0 });
  assert.deepEqual(gatewayReadSlots(Number.POSITIVE_INFINITY), { fresh: 0, reread: 0 });
  assert.deepEqual(gatewayReadSlots(1), { fresh: 1, reread: 0 });
  assert.deepEqual(gatewayReadSlots(4), { fresh: 4, reread: 0 });
  assert.deepEqual(gatewayReadSlots(4.9), { fresh: 4, reread: 0 });
  assert.deepEqual(gatewayReadSlots(5), { fresh: 4, reread: 1 });
  assert.deepEqual(gatewayReadSlots(5.9), { fresh: 4, reread: 1 });
  assert.deepEqual(gatewayReadSlots(200), { fresh: 160, reread: 40 });
  const production = gatewayReadSlots(GATEWAY_RECONCILE_ROW_LIMIT);
  assert.deepEqual(production, { fresh: 1_600, reread: 400 });
  assert.ok(production.fresh >= 1_500);
  assert.deepEqual(interleaveGatewayRows(["a", "b", "c", "d", "e"], ["r1", "r2"]), ["a", "b", "c", "d", "r1", "e", "r2"]);
  assert.deepEqual(interleaveGatewayRows(["u1", "u2"], []), ["u1", "u2"]);
  assert.deepEqual(interleaveGatewayRows([], ["p1"]), ["p1"]);
  assert.deepEqual(interleaveGatewayRows([], []), []);
});

test("Gateway の読み予算は 60 秒から 90 秒で、短い予算でもネイティブの 8 秒を残す", () => {
  assert.ok(GATEWAY_RECONCILE_BUDGET_MS >= 60_000 && GATEWAY_RECONCILE_BUDGET_MS <= 90_000);
  assert.equal(gatewayReadBudgetMs(240_000), GATEWAY_RECONCILE_BUDGET_MS);
  assert.equal(gatewayReadBudgetMs(25_000), 2_000);
  const tight = gatewayReadBudgetMs(20_000);
  assert.ok(tight > 0);
  assert.ok(20_000 - tight >= 8_000);
  assert.equal(createDeadline(tight).expired(), false);
});

test("Stellar は USDC だけを署名できる accept と数える", () => {
  const stellar = (asset: string) => ({
    scheme: "exact",
    network: "stellar:pubnet",
    amount: "1000",
    asset,
    payTo: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    maxTimeoutSeconds: 60,
    extra: {},
  });
  const names = ["OBSERVATORY_STELLAR_L1_ENABLED", "STELLAR_PAYER_SECRET", "STELLAR_RPC_URL", "STELLAR_HORIZON_URL"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = name === "OBSERVATORY_STELLAR_L1_ENABLED" ? "true" : "set";
  try {
    withEnv("OBSERVATORY_ARC_GATEWAY_L1_ENABLED", "true", () => {
      assert.equal(hasSignableOtherRailAccept([stellar("XLM")]), false);
      assert.equal(hasSignableOtherRailAccept([stellar(STELLAR_USDC_CLASSIC)]), true);
      assert.equal(hasSignableOtherRailAccept([stellar(STELLAR_USDC_SAC)]), true);
      const sqlText = JSON.stringify(gatewayPrimaryExclusionSql());
      assert.ok(sqlText.includes(STELLAR_USDC_CLASSIC));
      assert.ok(sqlText.includes(STELLAR_USDC_SAC));
    });
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("実物の Gateway バッチ tx の購入元の減額は公開ラウンドの額と一致する", () => {
  for (const file of ["tests/fixtures/arc-gateway-batch-r2.json", "tests/fixtures/arc-gateway-batch-r3.json"]) {
    const fixture = JSON.parse(read(file)) as {
      buyer: string;
      expectedDebit: string;
      transaction: { to: string; input: string };
      receipt: { status: string; to: string; logs: { address: string; topics: string[]; data: string }[] };
    };
    assert.equal(fixture.receipt.status, "0x1");
    const readDebit = gatewayBuyerDebit({
      status: "success",
      to: fixture.receipt.to,
      calldata: fixture.transaction.input,
      logs: fixture.receipt.logs,
      buyer: fixture.buyer,
      otherBuyerMovement: true,
    });
    assert.deepEqual(readDebit, { kind: "amount", debit: BigInt(fixture.expectedDebit) });
  }
});
