// ============================================================
// L1 決済のオンチェーン照合 — Avalanche C-Chain（2026-10-26・Avalanche レーン）。
//
// Avalanche の購入行（network eip155:43114）は、Base / Arc / Celo と同じ EVM の照合器を通る。期待するチェーン ID と
// USDC は x402-payer の表（EVM_PAY_CHAINS）から引き、売り手の受領証にも facilitator の申告にも頼らない。
//
// 守ること:
//  1. 購入元 → 宣言の payTo へ、署名した額ちょうどのネイティブ USDC の Transfer と、我々の nonce の
//     AuthorizationUsed が、chainId 43114 を名乗る RPC から読めたときだけ settled。
//  2. 宛先・額・送り主・トークン・nonce のどれか 1 つでも違えば settled にしない。USDC.e の Transfer は決済ではない。
//  3. その RPC が別のチェーンを名乗れば wrong_chain（読まない）。Base の RPC で Avalanche の行を読まない。
//  4. AVALANCHE_RPC_URL が無ければ chain_not_yet_verifiable（公開 RPC へ黙って倒れて「確認済み」を刻まない）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toBytes } from "viem";
import {
  AUTHORIZATION_USED_TOPIC,
  REQUIRED_CONFIRMATIONS,
  readAuthorizationNonces,
  readAuthorizationState,
  verifyL1Settlement,
  type AuthorizationStateClient,
  type EvmVerifyClient,
} from "@/lib/observatory/settlement-verify";
import { ARC_USDC, AVALANCHE_USDC, AVALANCHE_USDC_E, BASE_USDC } from "@/lib/observatory/x402-payer";
import { INSTRUMENT_FAILURE_REASONS, TRANSIENT_REASONS, sellerNamedTxExpiryChain } from "@/lib/observatory/settlement-verifier";

const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));
const TX = `0x${"ce".repeat(32)}`;
const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
const PAY_TO = "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0";
const OTHER_PAY_TO = "0x242ba6d68ffeb4a098b591b32d370f973ff882b7";
const OTHER_PAYER = "0x902dcf34e53695bdea2ffb354b1a2e58bd598256";
const AMOUNT = "1000";
const NONCE = `0x${"22".repeat(32)}`;
const OTHER_NONCE = `0x${"33".repeat(32)}`;
const pad = (addr: string) => `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`;

const transferLog = (o: { token?: string; from?: string; to?: string; amount?: string } = {}) => ({
  address: (o.token ?? AVALANCHE_USDC).toLowerCase(),
  topics: [TRANSFER_TOPIC, pad(o.from ?? PAYER), pad(o.to ?? PAY_TO)],
  data: `0x${BigInt(o.amount ?? AMOUNT).toString(16).padStart(64, "0")}`,
});
const authUsedLog = (o: { token?: string; authorizer?: string; nonce?: string } = {}) => ({
  address: (o.token ?? AVALANCHE_USDC).toLowerCase(),
  topics: [AUTHORIZATION_USED_TOPIC, pad(o.authorizer ?? PAYER), o.nonce ?? NONCE],
  data: "0x",
});

function fakeClient(chainId: number, logs: unknown[], o: { tip?: bigint; block?: bigint; status?: string } = {}): EvmVerifyClient {
  return {
    getChainId: async () => chainId,
    getBlockNumber: async () => o.tip ?? 517_200_000n,
    getTransactionReceipt: async () => ({ status: o.status ?? "success", blockNumber: o.block ?? 517_100_000n, logs }),
    getBlock: async () => ({ timestamp: 1_760_000_000n }),
  } as never;
}

const run = (client: EvmVerifyClient, over: Partial<Parameters<typeof verifyL1Settlement>[0]> = {}) =>
  verifyL1Settlement(
    { txHash: TX, network: "eip155:43114", expectedPayTo: PAY_TO, expectedPayer: PAYER, expectedAmountUnits: AMOUNT, expectedAuthNonce: NONCE, ...over },
    { client },
  );
const reasonOf = async (p: ReturnType<typeof run>) => {
  const r = await p;
  return r.ok ? "ok" : r.reason;
};

test("Avalanche: Transfer + AuthorizationUsed on native USDC, read from a chainId-43114 RPC, is settled", async () => {
  const result = await run(fakeClient(43114, [authUsedLog(), transferLog()]));
  assert.equal(result.ok, true, result.ok === false ? `${result.reason}: ${result.detail ?? ""}` : "");
});

test("Avalanche: a Transfer to another payee is not our settlement", async () => {
  assert.equal(await reasonOf(run(fakeClient(43114, [authUsedLog(), transferLog({ to: OTHER_PAY_TO })]))), "no_matching_transfer");
  assert.equal(
    await reasonOf(run(fakeClient(43114, [authUsedLog(), transferLog({ to: OTHER_PAY_TO }), transferLog({ from: OTHER_PAYER })]))),
    "no_matching_transfer",
  );
});

test("Avalanche: a Transfer of another amount is not our settlement (one unit more, one unit less, ten times)", async () => {
  for (const amount of ["1001", "999", "10000", "0"]) {
    assert.equal(await reasonOf(run(fakeClient(43114, [authUsedLog(), transferLog({ amount })]))), "no_matching_transfer", `amount ${amount}`);
  }
  assert.equal(
    await reasonOf(run(fakeClient(43114, [authUsedLog(), transferLog({ amount: "600" }), transferLog({ amount: "400" })]))),
    "no_matching_transfer",
  );
});

test("Avalanche: a Transfer from another payer, or in another token including USDC.e, is not our settlement", async () => {
  assert.equal(await reasonOf(run(fakeClient(43114, [authUsedLog(), transferLog({ from: OTHER_PAYER })]))), "no_matching_transfer");
  for (const token of [AVALANCHE_USDC_E, BASE_USDC, ARC_USDC]) {
    assert.equal(
      await reasonOf(run(fakeClient(43114, [authUsedLog({ token }), transferLog({ token })]))),
      "no_matching_transfer",
      `token ${token}`,
    );
  }
});

test("Avalanche: the right Transfer without our nonce is nonce_not_used — a past tx to the same payee cannot be replayed as this purchase", async () => {
  assert.equal(await reasonOf(run(fakeClient(43114, [transferLog()]))), "nonce_not_used");
  assert.equal(await reasonOf(run(fakeClient(43114, [authUsedLog({ nonce: OTHER_NONCE }), transferLog()]))), "nonce_not_used");
  assert.equal(await reasonOf(run(fakeClient(43114, [authUsedLog({ authorizer: OTHER_PAYER }), transferLog()]))), "nonce_not_used");
  assert.equal(await reasonOf(run(fakeClient(43114, [authUsedLog({ token: AVALANCHE_USDC_E }), transferLog()]))), "nonce_not_used");
});

test("Avalanche: a reverted tx, too few confirmations and a malformed hash are not settled", async () => {
  assert.equal(await reasonOf(run(fakeClient(43114, [authUsedLog(), transferLog()], { status: "reverted" }))), "tx_reverted");
  const tip = 517_100_000n + REQUIRED_CONFIRMATIONS - 2n;
  assert.equal(await reasonOf(run(fakeClient(43114, [authUsedLog(), transferLog()], { tip }))), "insufficient_confirmations");
  assert.equal(await reasonOf(run(fakeClient(43114, [authUsedLog(), transferLog()]), { txHash: "first-can" })), "malformed_tx");
});

test("Avalanche: an RPC that reports another chain id is wrong_chain — an Avalanche row is never read through the Base or Celo RPC", async () => {
  for (const chainId of [8453, 5042, 42220, 43113]) {
    assert.equal(await reasonOf(run(fakeClient(chainId, [authUsedLog(), transferLog()]))), "wrong_chain", `chainId ${chainId}`);
  }
  const base = await verifyL1Settlement(
    { txHash: TX, network: "eip155:8453", expectedPayTo: PAY_TO, expectedPayer: PAYER, expectedAmountUnits: AMOUNT, expectedAuthNonce: NONCE },
    { client: fakeClient(43114, [authUsedLog({ token: BASE_USDC }), transferLog({ token: BASE_USDC })]) },
  );
  assert.equal(base.ok === false && base.reason, "wrong_chain");
  assert.ok(TRANSIENT_REASONS.has("wrong_chain") && INSTRUMENT_FAILURE_REASONS.has("wrong_chain"));
});

test("Avalanche without AVALANCHE_RPC_URL and without an injected client is chain_not_yet_verifiable (no public-RPC fallback, no Base RPC)", async () => {
  const saved = { arb: process.env.AVALANCHE_RPC_URL, base: process.env.BASE_RPC_URL };
  try {
    delete process.env.AVALANCHE_RPC_URL;
    process.env.BASE_RPC_URL = "http://127.0.0.1:9";
    const result = await verifyL1Settlement({
      txHash: TX,
      network: "eip155:43114",
      expectedPayTo: PAY_TO,
      expectedPayer: PAYER,
      expectedAmountUnits: AMOUNT,
      expectedAuthNonce: NONCE,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "chain_not_yet_verifiable");
    assert.match((result.ok === false && result.detail) || "", /eip155:43114: AVALANCHE_RPC_URL_unset/);
    assert.ok(TRANSIENT_REASONS.has("chain_not_yet_verifiable"), "the row waits; the seller is not refuted");
    process.env.AVALANCHE_RPC_URL = "   ";
    const blank = await verifyL1Settlement({ txHash: TX, network: "eip155:43114", expectedPayTo: PAY_TO, expectedPayer: PAYER, expectedAmountUnits: AMOUNT });
    assert.equal(blank.ok === false && blank.reason, "chain_not_yet_verifiable", "a blank value is unset");
    delete process.env.AVALANCHE_RPC_URL;
    assert.equal(await readAuthorizationState({ network: "eip155:43114", payer: PAYER, nonce: NONCE }), null);
    assert.equal(await readAuthorizationNonces({ network: "eip155:43114", txHash: TX, payer: PAYER }), null);
  } finally {
    if (saved.arb === undefined) delete process.env.AVALANCHE_RPC_URL;
    else process.env.AVALANCHE_RPC_URL = saved.arb;
    if (saved.base === undefined) delete process.env.BASE_RPC_URL;
    else process.env.BASE_RPC_URL = saved.base;
  }
});

test("Avalanche testnets are not in the pinned table: chain_not_yet_verifiable, whatever the RPC says", async () => {
  for (const network of ["eip155:43113", "eip155:43115"]) {
    const r = await run(fakeClient(43114, [authUsedLog(), transferLog()]), { network });
    assert.equal(r.ok === false && r.reason, "chain_not_yet_verifiable", network);
  }
});

test("Avalanche: readAuthorizationState asks the pinned native USDC, and only on a chainId-43114 RPC", async () => {
  const asked: { address?: string; args?: readonly unknown[] }[] = [];
  const client = (chainId: number, used: unknown): AuthorizationStateClient =>
    ({
      getChainId: async () => chainId,
      readContract: async (q: { address: string; args: readonly unknown[] }) => {
        asked.push({ address: q.address, args: q.args });
        return used;
      },
    }) as never;
  assert.equal(await readAuthorizationState({ network: "eip155:43114", payer: PAYER, nonce: NONCE }, { client: client(43114, false) }), false);
  assert.equal(asked.at(-1)?.address, AVALANCHE_USDC);
  assert.deepEqual(asked.at(-1)?.args, [PAYER, NONCE]);
  assert.equal(await readAuthorizationState({ network: "eip155:43114", payer: PAYER, nonce: NONCE }, { client: client(43114, true) }), true);
  const before = asked.length;
  assert.equal(await readAuthorizationState({ network: "eip155:43114", payer: PAYER, nonce: NONCE }, { client: client(8453, false) }), null, "another chain's RPC answers nothing");
  assert.equal(asked.length, before, "the contract is not read on the wrong chain");
});

test("Avalanche: readAuthorizationNonces returns the nonces our payer consumed on native USDC in that tx, and nothing from other tokens or authorizers", async () => {
  const logs = [authUsedLog(), authUsedLog({ nonce: OTHER_NONCE, authorizer: OTHER_PAYER }), authUsedLog({ nonce: OTHER_NONCE, token: AVALANCHE_USDC_E }), transferLog()];
  assert.deepEqual(await readAuthorizationNonces({ network: "eip155:43114", txHash: TX, payer: PAYER }, { client: fakeClient(43114, logs) }), [NONCE]);
  assert.equal(await readAuthorizationNonces({ network: "eip155:43114", txHash: TX, payer: PAYER }, { client: fakeClient(8453, logs) }), null);
});

test("the seller-named-tx expiry covers Avalanche C-Chain mainnet among the pinned EVM chains", () => {
  assert.equal(sellerNamedTxExpiryChain("eip155:43114"), true);
  assert.equal(sellerNamedTxExpiryChain("eip155:8453"), true);
  assert.equal(sellerNamedTxExpiryChain("eip155:43113"), false);
  assert.equal(sellerNamedTxExpiryChain("eip155:43115"), false);
  assert.equal(sellerNamedTxExpiryChain("avalanche"), false);
  assert.equal(sellerNamedTxExpiryChain(null), false);
});
