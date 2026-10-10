// ============================================================
// L1 決済のオンチェーン照合 — Celo（2026-10-10・Celo レーン）。
//
// Celo の購入行（network eip155:42220）は、Base / Arc と同じ EVM の照合器を通る。期待するチェーン ID と
// USDC は x402-payer の表（EVM_PAY_CHAINS）から引き、売り手の受領証にも facilitator の申告にも頼らない。
//
// レシートの形は実物に合わせてある（2026-10-10 に forno で読んだ、facilitator 0x0d74…FB48 が出した
// 0xced7e783…12e8f3 など 3 本）: Celo の USDC（0xcebA…118C）が AuthorizationUsed(authorizer, nonce) と
// Transfer(from, to, value) を 1 本ずつ出す。Base と同じ形。
//
// 守ること:
//  1. 購入元 → 宣言の payTo へ、署名した額ちょうどの Celo USDC の Transfer と、我々の nonce の
//     AuthorizationUsed が、chainId 42220 を名乗る RPC から読めたときだけ settled。
//  2. 宛先・額・送り主・トークン・nonce のどれか 1 つでも違えば settled にしない。
//  3. その RPC が別のチェーンを名乗れば wrong_chain（読まない）。Base の RPC で Celo の行を読まない。
//  4. CELO_RPC_URL が無ければ chain_not_yet_verifiable（公開 RPC へ黙って倒れて「確認済み」を刻まない）。
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
import { ARC_USDC, BASE_USDC, CELO_USDC } from "@/lib/observatory/x402-payer";
import { INSTRUMENT_FAILURE_REASONS, TRANSIENT_REASONS, sellerNamedTxExpiryChain } from "@/lib/observatory/settlement-verifier";

const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));
const TX = `0x${"ce".repeat(32)}`;
/** 購入元（EVM の 3 チェーン共通の EOA）。 */
const PAYER = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
/** agent402.tools の payTo（Celo の accept が宣言する受取先）。 */
const PAY_TO = "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0";
const OTHER_PAY_TO = "0x242ba6d68ffeb4a098b591b32d370f973ff882b7";
const OTHER_PAYER = "0x902dcf34e53695bdea2ffb354b1a2e58bd598256";
const CELO_USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const AMOUNT = "1000";
const NONCE = `0x${"22".repeat(32)}`;
const OTHER_NONCE = `0x${"33".repeat(32)}`;
const pad = (addr: string) => `0x${addr.slice(2).toLowerCase().padStart(64, "0")}`;

const transferLog = (o: { token?: string; from?: string; to?: string; amount?: string } = {}) => ({
  address: (o.token ?? CELO_USDC).toLowerCase(),
  topics: [TRANSFER_TOPIC, pad(o.from ?? PAYER), pad(o.to ?? PAY_TO)],
  data: `0x${BigInt(o.amount ?? AMOUNT).toString(16).padStart(64, "0")}`,
});
const authUsedLog = (o: { token?: string; authorizer?: string; nonce?: string } = {}) => ({
  address: (o.token ?? CELO_USDC).toLowerCase(),
  topics: [AUTHORIZATION_USED_TOPIC, pad(o.authorizer ?? PAYER), o.nonce ?? NONCE],
  data: "0x",
});

function fakeClient(chainId: number, logs: unknown[], o: { tip?: bigint; block?: bigint; status?: string } = {}): EvmVerifyClient {
  return {
    getChainId: async () => chainId,
    getBlockNumber: async () => o.tip ?? 79_800_000n,
    getTransactionReceipt: async () => ({ status: o.status ?? "success", blockNumber: o.block ?? 79_700_000n, logs }),
    getBlock: async () => ({ timestamp: 1_760_000_000n }),
  } as never;
}

const run = (client: EvmVerifyClient, over: Partial<Parameters<typeof verifyL1Settlement>[0]> = {}) =>
  verifyL1Settlement(
    { txHash: TX, network: "eip155:42220", expectedPayTo: PAY_TO, expectedPayer: PAYER, expectedAmountUnits: AMOUNT, expectedAuthNonce: NONCE, ...over },
    { client },
  );
const reasonOf = async (p: ReturnType<typeof run>) => {
  const r = await p;
  return r.ok ? "ok" : r.reason;
};

test("Celo: Transfer + AuthorizationUsed on Celo USDC, read from a chainId-42220 RPC, is settled", async () => {
  const result = await run(fakeClient(42220, [authUsedLog(), transferLog()]));
  assert.equal(result.ok, true, result.ok === false ? `${result.reason}: ${result.detail ?? ""}` : "");
});

test("Celo: a Transfer to another payee is not our settlement", async () => {
  assert.equal(await reasonOf(run(fakeClient(42220, [authUsedLog(), transferLog({ to: OTHER_PAY_TO })]))), "no_matching_transfer");
  // The declared payee received something — from someone else, in the same tx. Still not ours.
  assert.equal(
    await reasonOf(run(fakeClient(42220, [authUsedLog(), transferLog({ to: OTHER_PAY_TO }), transferLog({ from: OTHER_PAYER })]))),
    "no_matching_transfer",
  );
});

test("Celo: a Transfer of another amount is not our settlement (one unit more, one unit less, ten times)", async () => {
  for (const amount of ["1001", "999", "10000", "0"]) {
    assert.equal(await reasonOf(run(fakeClient(42220, [authUsedLog(), transferLog({ amount })]))), "no_matching_transfer", `amount ${amount}`);
  }
  // Two transfers that sum to the amount are not one transfer of the amount.
  assert.equal(
    await reasonOf(run(fakeClient(42220, [authUsedLog(), transferLog({ amount: "600" }), transferLog({ amount: "400" })]))),
    "no_matching_transfer",
  );
});

test("Celo: a Transfer from another payer, or in another token, is not our settlement", async () => {
  assert.equal(await reasonOf(run(fakeClient(42220, [authUsedLog(), transferLog({ from: OTHER_PAYER })]))), "no_matching_transfer");
  for (const token of [CELO_USDT, BASE_USDC, ARC_USDC]) {
    assert.equal(
      await reasonOf(run(fakeClient(42220, [authUsedLog({ token }), transferLog({ token })]))),
      "no_matching_transfer",
      `token ${token}`,
    );
  }
});

test("Celo: the right Transfer without our nonce is nonce_not_used — a past tx to the same payee cannot be replayed as this purchase", async () => {
  assert.equal(await reasonOf(run(fakeClient(42220, [transferLog()]))), "nonce_not_used");
  assert.equal(await reasonOf(run(fakeClient(42220, [authUsedLog({ nonce: OTHER_NONCE }), transferLog()]))), "nonce_not_used");
  assert.equal(await reasonOf(run(fakeClient(42220, [authUsedLog({ authorizer: OTHER_PAYER }), transferLog()]))), "nonce_not_used");
  assert.equal(await reasonOf(run(fakeClient(42220, [authUsedLog({ token: CELO_USDT }), transferLog()]))), "nonce_not_used");
});

test("Celo: a reverted tx, too few confirmations and a malformed hash are not settled", async () => {
  assert.equal(await reasonOf(run(fakeClient(42220, [authUsedLog(), transferLog()], { status: "reverted" }))), "tx_reverted");
  const tip = 79_700_000n + REQUIRED_CONFIRMATIONS - 2n;
  assert.equal(await reasonOf(run(fakeClient(42220, [authUsedLog(), transferLog()], { tip }))), "insufficient_confirmations");
  assert.equal(await reasonOf(run(fakeClient(42220, [authUsedLog(), transferLog()]), { txHash: "first-can" })), "malformed_tx");
});

test("Celo: an RPC that reports another chain id is wrong_chain — a Celo row is never read through the Base or Arc RPC", async () => {
  for (const chainId of [8453, 5042, 44787, 11142220]) {
    assert.equal(await reasonOf(run(fakeClient(chainId, [authUsedLog(), transferLog()]))), "wrong_chain", `chainId ${chainId}`);
  }
  // …and the reverse: a Base row through a Celo RPC.
  const base = await verifyL1Settlement(
    { txHash: TX, network: "eip155:8453", expectedPayTo: PAY_TO, expectedPayer: PAYER, expectedAmountUnits: AMOUNT, expectedAuthNonce: NONCE },
    { client: fakeClient(42220, [authUsedLog({ token: BASE_USDC }), transferLog({ token: BASE_USDC })]) },
  );
  assert.equal(base.ok === false && base.reason, "wrong_chain");
  // wrong_chain is an instrument failure of ours: transient, never a refutation of the seller.
  assert.ok(TRANSIENT_REASONS.has("wrong_chain") && INSTRUMENT_FAILURE_REASONS.has("wrong_chain"));
});

test("Celo without CELO_RPC_URL and without an injected client is chain_not_yet_verifiable (no public-RPC fallback, no Base RPC)", async () => {
  const saved = { celo: process.env.CELO_RPC_URL, base: process.env.BASE_RPC_URL };
  try {
    delete process.env.CELO_RPC_URL;
    // If the verifier fell through to the Base client it would try this URL and answer rpc_unavailable.
    process.env.BASE_RPC_URL = "http://127.0.0.1:9";
    const result = await verifyL1Settlement({
      txHash: TX,
      network: "eip155:42220",
      expectedPayTo: PAY_TO,
      expectedPayer: PAYER,
      expectedAmountUnits: AMOUNT,
      expectedAuthNonce: NONCE,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "chain_not_yet_verifiable");
    assert.match((result.ok === false && result.detail) || "", /eip155:42220: CELO_RPC_URL_unset/);
    assert.ok(TRANSIENT_REASONS.has("chain_not_yet_verifiable"), "the row waits; the seller is not refuted");
    process.env.CELO_RPC_URL = "   ";
    const blank = await verifyL1Settlement({ txHash: TX, network: "eip155:42220", expectedPayTo: PAY_TO, expectedPayer: PAYER, expectedAmountUnits: AMOUNT });
    assert.equal(blank.ok === false && blank.reason, "chain_not_yet_verifiable", "a blank value is unset");
    // The authorization-state and nonce readers follow the same rule: no client, no answer.
    delete process.env.CELO_RPC_URL;
    assert.equal(await readAuthorizationState({ network: "eip155:42220", payer: PAYER, nonce: NONCE }), null);
    assert.equal(await readAuthorizationNonces({ network: "eip155:42220", txHash: TX, payer: PAYER }), null);
  } finally {
    if (saved.celo === undefined) delete process.env.CELO_RPC_URL;
    else process.env.CELO_RPC_URL = saved.celo;
    if (saved.base === undefined) delete process.env.BASE_RPC_URL;
    else process.env.BASE_RPC_URL = saved.base;
  }
});

test("Celo testnets are not in the pinned table: chain_not_yet_verifiable, whatever the RPC says", async () => {
  for (const network of ["eip155:11142220", "eip155:44787"]) {
    const r = await run(fakeClient(42220, [authUsedLog(), transferLog()]), { network });
    assert.equal(r.ok === false && r.reason, "chain_not_yet_verifiable", network);
  }
});

test("Celo: readAuthorizationState asks the pinned Celo USDC, and only on a chainId-42220 RPC", async () => {
  const asked: { address?: string; args?: readonly unknown[] }[] = [];
  const client = (chainId: number, used: unknown): AuthorizationStateClient =>
    ({
      getChainId: async () => chainId,
      readContract: async (q: { address: string; args: readonly unknown[] }) => {
        asked.push({ address: q.address, args: q.args });
        return used;
      },
    }) as never;
  assert.equal(await readAuthorizationState({ network: "eip155:42220", payer: PAYER, nonce: NONCE }, { client: client(42220, false) }), false);
  assert.equal(asked.at(-1)?.address, CELO_USDC);
  assert.deepEqual(asked.at(-1)?.args, [PAYER, NONCE]);
  assert.equal(await readAuthorizationState({ network: "eip155:42220", payer: PAYER, nonce: NONCE }, { client: client(42220, true) }), true);
  const before = asked.length;
  assert.equal(await readAuthorizationState({ network: "eip155:42220", payer: PAYER, nonce: NONCE }, { client: client(8453, false) }), null, "another chain's RPC answers nothing");
  assert.equal(asked.length, before, "the contract is not read on the wrong chain");
});

test("Celo: readAuthorizationNonces returns the nonces our payer consumed on Celo USDC in that tx, and nothing from other tokens or authorizers", async () => {
  const logs = [authUsedLog(), authUsedLog({ nonce: OTHER_NONCE, authorizer: OTHER_PAYER }), authUsedLog({ nonce: OTHER_NONCE, token: CELO_USDT }), transferLog()];
  assert.deepEqual(await readAuthorizationNonces({ network: "eip155:42220", txHash: TX, payer: PAYER }, { client: fakeClient(42220, logs) }), [NONCE]);
  assert.equal(await readAuthorizationNonces({ network: "eip155:42220", txHash: TX, payer: PAYER }, { client: fakeClient(8453, logs) }), null);
});

test("the seller-named-tx expiry covers exactly the pinned EVM chains: Base, Arc and Celo mainnet", () => {
  assert.equal(sellerNamedTxExpiryChain("eip155:42220"), true);
  assert.equal(sellerNamedTxExpiryChain("eip155:8453"), true);
  assert.equal(sellerNamedTxExpiryChain("eip155:5042"), true);
  assert.equal(sellerNamedTxExpiryChain("eip155:11142220"), false);
  assert.equal(sellerNamedTxExpiryChain("eip155:44787"), false);
  assert.equal(sellerNamedTxExpiryChain("eip155:4217"), false, "Tempo stays out");
  assert.equal(sellerNamedTxExpiryChain("celo"), false);
  assert.equal(sellerNamedTxExpiryChain(null), false);
});
