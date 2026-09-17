// ============================================================
// L1 決済のオンチェーン照合 — Arc（2026-09-17・Arc レーン）。
//
// 照合器は Base 固定（chainId 8453・Base USDC）だった。Arc の購入行（network
// eip155:5042）をそのまま通すと、Base の RPC に Arc の tx ハッシュを問い、永遠に
// tx_not_found で滞留する——「別チェーンの決済を Base の作法で読む」は一番静かな
// 失敗なので、期待するチェーン ID と USDC を x402-payer の表から引くようにした。
//
// 守ること:
//  1. Arc の行は chainId 5042 を名乗る RPC でだけ照合し、USDC は 0x3600…。
//  2. その RPC が 8453 を名乗れば wrong_chain（読まない）。
//  3. 表に無い EVM（eip155:137 など）は chain_not_yet_verifiable のまま（否定しない）。
//  4. Base の照合は従来どおり。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import { verifyL1Settlement, AUTHORIZATION_USED_TOPIC, type EvmVerifyClient } from "@/lib/observatory/settlement-verify";
import { ARC_USDC, BASE_USDC } from "@/lib/observatory/x402-payer";

const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));
const TX = `0x${"cd".repeat(32)}`;
const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
const PAY_TO = "0xb98ef29eb2be19ae646a8fc0248255b90a332dbc";
const AMOUNT = "10000";
const NONCE = `0x${"11".repeat(32)}`;
const pad = (addr: string) => `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`;

const transferLog = (token: string) => ({
  address: token.toLowerCase(),
  topics: [TRANSFER_TOPIC, pad(PAYER), pad(PAY_TO)],
  data: `0x${BigInt(AMOUNT).toString(16).padStart(64, "0")}`,
});
const authUsedLog = (token: string) => ({
  address: token.toLowerCase(),
  topics: [AUTHORIZATION_USED_TOPIC, pad(PAYER), NONCE],
  data: "0x",
});

function fakeClient(chainId: number, logs: unknown[]): EvmVerifyClient {
  return {
    getChainId: async () => chainId,
    getBlockNumber: async () => 1_000_000n,
    getTransactionReceipt: async () => ({ status: "success", blockNumber: 900_000n, logs }),
    getBlock: async () => ({ timestamp: 1_758_000_000n }),
  } as never;
}

const run = (network: string, client: EvmVerifyClient) =>
  verifyL1Settlement(
    { txHash: TX, network, expectedPayTo: PAY_TO, expectedPayer: PAYER, expectedAmountUnits: AMOUNT, expectedAuthNonce: NONCE },
    { client },
  );

test("Arc: a Transfer + AuthorizationUsed on Arc USDC, read from a chainId-5042 RPC, is settled", async () => {
  const result = await run("eip155:5042", fakeClient(5042, [authUsedLog(ARC_USDC), transferLog(ARC_USDC)]));
  assert.equal(result.ok, true, result.ok === false ? `${result.reason}: ${result.detail ?? ""}` : "");
});

test("Arc: the same logs on Base's USDC address are no_matching_transfer (the token is pinned per chain)", async () => {
  const result = await run("eip155:5042", fakeClient(5042, [authUsedLog(BASE_USDC), transferLog(BASE_USDC)]));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "no_matching_transfer");
});

test("Arc: an RPC that reports chainId 8453 is wrong_chain — an Arc row is never read through the Base RPC", async () => {
  const result = await run("eip155:5042", fakeClient(8453, [authUsedLog(ARC_USDC), transferLog(ARC_USDC)]));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "wrong_chain");
});

test("Base: a Base row read from a chainId-5042 RPC is wrong_chain (unchanged discipline)", async () => {
  const result = await run("eip155:8453", fakeClient(5042, [authUsedLog(BASE_USDC), transferLog(BASE_USDC)]));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "wrong_chain");
  const ok = await run("eip155:8453", fakeClient(8453, [authUsedLog(BASE_USDC), transferLog(BASE_USDC)]));
  assert.equal(ok.ok, true);
});

// ---- 2026-09-17 review 3: the verifier needs ARC_RPC_URL; it never falls back to the public RPC ----
test("Arc without ARC_RPC_URL and without an injected client is chain_not_yet_verifiable (no public-RPC fallback)", async () => {
  const saved = process.env.ARC_RPC_URL;
  try {
    delete process.env.ARC_RPC_URL;
    const result = await verifyL1Settlement({
      txHash: TX,
      network: "eip155:5042",
      expectedPayTo: PAY_TO,
      expectedPayer: PAYER,
      expectedAmountUnits: AMOUNT,
      expectedAuthNonce: NONCE,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "chain_not_yet_verifiable");
    assert.match((result.ok === false && result.detail) || "", /ARC_RPC_URL_unset/);
  } finally {
    if (saved === undefined) delete process.env.ARC_RPC_URL;
    else process.env.ARC_RPC_URL = saved;
  }
});

test("an EVM chain not in the pinned table stays chain_not_yet_verifiable (no refutation on evidence we do not hold)", async () => {
  const result = await run("eip155:137", fakeClient(137, [authUsedLog(BASE_USDC), transferLog(BASE_USDC)]));
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "chain_not_yet_verifiable");
});
