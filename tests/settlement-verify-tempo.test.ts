// ============================================================
// Tempo（MPP）の決済照合（2026-09-17）。
//
// settlement-verify.ts（Base）と同じ契約を、Tempo の event（Transfer / TransferWithMemo）で
// 検査する。RPC は偽物。守ること: chainId 4217 でなければ wrong_chain、確定数 64、
// 受取先・金額・payer の一致、memo（auth_nonce）を持つ行は TransferWithMemo の memo 一致を要求。
// verifyL1Settlement は eip155:4217 をこの照合器へ委譲する。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeMppAttributionMemo, MPP_CLIENT_ID, TEMPO_USDC_E } from "@/lib/observatory/mpp-payer";
import { TEMPO_TRANSFER_TOPIC, TEMPO_TRANSFER_WITH_MEMO_TOPIC, verifyTempoSettlement } from "@/lib/observatory/settlement-verify-tempo";
import { verifyL1Settlement, type EvmVerifyClient } from "@/lib/observatory/settlement-verify";

const PAYER = "0xc9c7b38C0942914fC8EA12063BC92dcd3b581670";
const PAY_TO = "0xca4e835F803cB0b7C428222B3A3B98518d4779Fe";
const TX = `0x${"11".repeat(32)}`;
const MEMO = encodeMppAttributionMemo({ challengeId: "p-1", realm: "fal.mpp.tempo.xyz", clientId: MPP_CLIENT_ID });
const pad = (addr: string) => `0x${"0".repeat(24)}${addr.slice(2).toLowerCase()}`;
const word = (n: bigint) => n.toString(16).padStart(64, "0");

function transferLog(value: bigint, over: Partial<{ address: string; from: string; to: string }> = {}) {
  return {
    address: over.address ?? TEMPO_USDC_E,
    topics: [TEMPO_TRANSFER_TOPIC, pad(over.from ?? PAYER), pad(over.to ?? PAY_TO)],
    data: `0x${word(value)}`,
  };
}
// 本番の形（2026-09-18 実測・tx 0xbd1049ed…95e8）: memo は indexed で topics[3]、data は amount の 1 語だけ。
function memoLog(value: bigint, memo: string) {
  return {
    address: TEMPO_USDC_E,
    topics: [TEMPO_TRANSFER_WITH_MEMO_TOPIC, pad(PAYER), pad(PAY_TO), memo],
    data: `0x${word(value)}`,
  };
}
/** 非 indexed の形（memo が data の 2 語目）。2026-09-17 の実装が決めつけていた形で、読めるままにしておく。 */
function memoLogInData(value: bigint, memo: string) {
  return {
    address: TEMPO_USDC_E,
    topics: [TEMPO_TRANSFER_WITH_MEMO_TOPIC, pad(PAYER), pad(PAY_TO)],
    data: `0x${word(value)}${memo.slice(2)}`,
  };
}

function fakeClient(over: { chainId?: number; tip?: bigint; receipt?: unknown; throwReceipt?: boolean } = {}): EvmVerifyClient {
  return {
    getChainId: async () => over.chainId ?? 4217,
    getBlockNumber: async () => over.tip ?? 40_000_000n,
    getTransactionReceipt: async () => {
      if (over.throwReceipt) throw new Error("not found");
      return (over.receipt ?? { status: "success", blockNumber: 39_999_000n, logs: [transferLog(25_000n), memoLog(25_000n, MEMO)] }) as never;
    },
    getBlock: async () => ({ timestamp: 1_789_000_000n }) as never,
  } as unknown as EvmVerifyClient;
}

const input = { txHash: TX, network: "eip155:4217", expectedPayTo: PAY_TO, expectedPayer: PAYER, expectedAmountUnits: "25000", expectedAuthNonce: MEMO };

test("ok: Transfer + TransferWithMemo with our memo, 64+ confirmations", async () => {
  const r = await verifyTempoSettlement(input, { client: fakeClient() });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.blockNumber, 39_999_000n);
    assert.equal(r.confirmations, 1001n);
    assert.equal(r.blockTimestamp?.toISOString(), new Date(1_789_000_000_000).toISOString());
  }
});

test("verifyL1Settlement dispatches eip155:4217 to the Tempo verifier (Base client untouched)", async () => {
  const r = await verifyL1Settlement(input, { tempoClient: fakeClient() });
  assert.equal(r.ok, true);
});

test("TEMPO_RPC_URL unset and no injected client → chain_not_yet_verifiable (no public-RPC fallback, review #7)", async () => {
  const saved = process.env.TEMPO_RPC_URL;
  try {
    delete process.env.TEMPO_RPC_URL;
    const r = await verifyTempoSettlement(input);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, "chain_not_yet_verifiable");
    assert.match((!r.ok && r.detail) || "", /TEMPO_RPC_URL_unset/);
    const viaDispatch = await verifyL1Settlement(input);
    assert.equal(!viaDispatch.ok && viaDispatch.reason, "chain_not_yet_verifiable");
  } finally {
    if (saved === undefined) delete process.env.TEMPO_RPC_URL;
    else process.env.TEMPO_RPC_URL = saved;
  }
});

test("wrong chain / reverted / not found / too few confirmations", async () => {
  assert.equal((await verifyTempoSettlement(input, { client: fakeClient({ chainId: 8453 }) })).ok, false);
  const wrong = await verifyTempoSettlement(input, { client: fakeClient({ chainId: 8453 }) });
  assert.equal(!wrong.ok && wrong.reason, "wrong_chain");
  const reverted = await verifyTempoSettlement(input, { client: fakeClient({ receipt: { status: "reverted", blockNumber: 1n, logs: [] } }) });
  assert.equal(!reverted.ok && reverted.reason, "tx_reverted");
  const missing = await verifyTempoSettlement(input, { client: fakeClient({ throwReceipt: true }) });
  assert.equal(!missing.ok && missing.reason, "tx_not_found");
  const shallow = await verifyTempoSettlement(input, { client: fakeClient({ tip: 39_999_010n }) });
  assert.equal(!shallow.ok && shallow.reason, "insufficient_confirmations");
  const malformed = await verifyTempoSettlement({ ...input, txHash: "nope" }, { client: fakeClient() });
  assert.equal(!malformed.ok && malformed.reason, "malformed_tx");
});

test("no matching transfer: wrong amount / wrong recipient / wrong token", async () => {
  const amount = await verifyTempoSettlement({ ...input, expectedAmountUnits: "30000" }, { client: fakeClient() });
  assert.equal(!amount.ok && amount.reason, "no_matching_transfer");
  const payee = await verifyTempoSettlement({ ...input, expectedPayTo: "0x0000000000000000000000000000000000000001" }, { client: fakeClient() });
  assert.equal(!payee.ok && payee.reason, "no_matching_transfer");
  const token = await verifyTempoSettlement(input, {
    client: fakeClient({ receipt: { status: "success", blockNumber: 39_999_000n, logs: [transferLog(25_000n, { address: "0x20c0000000000000000000000000000000000000" })] } }),
  });
  assert.equal(!token.ok && token.reason, "no_matching_transfer");
});

test("memo binding: a plain Transfer (or another purchase's memo) does not settle a row that carries our memo; rows without memo accept a plain Transfer", async () => {
  const plainOnly = fakeClient({ receipt: { status: "success", blockNumber: 39_999_000n, logs: [transferLog(25_000n)] } });
  const bound = await verifyTempoSettlement(input, { client: plainOnly });
  assert.equal(!bound.ok && bound.reason, "nonce_not_used");
  const other = encodeMppAttributionMemo({ challengeId: "p-other", realm: "fal.mpp.tempo.xyz", clientId: MPP_CLIENT_ID });
  const otherMemo = fakeClient({ receipt: { status: "success", blockNumber: 39_999_000n, logs: [transferLog(25_000n), memoLog(25_000n, other)] } });
  const reused = await verifyTempoSettlement(input, { client: otherMemo });
  assert.equal(!reused.ok && reused.reason, "nonce_not_used");
  const legacy = await verifyTempoSettlement({ ...input, expectedAuthNonce: null }, { client: plainOnly });
  assert.equal(legacy.ok, true);
});

test("production receipt shape (2026-09-18): memo is the indexed topics[3] — a real settlement is verified, not refuted", async () => {
  // 本番の実物をそのまま: fal.mpp.tempo.xyz への 40000 units・memo 0xef1ed712018bdbf8…9206。
  const payer = "0xc9c7b38c0942914fc8ea12063bc92dcd3b581670";
  const payTo = "0xca4e835f803cb0b7c428222b3a3b98518d4779fe";
  const memo = "0xef1ed712018bdbf8cc304c4816750e6065bcf287cc18ca700fbeb5c7584f9206";
  const tx = "0xbd1049edadb1b676fe51f65246b2b919ffb677ebff10a3d8a3ea6241aede95e8";
  const p32 = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`;
  const logs = [
    { address: TEMPO_USDC_E, topics: [TEMPO_TRANSFER_TOPIC, p32(payer), p32(payTo)], data: `0x${word(40_000n)}` },
    { address: TEMPO_USDC_E, topics: [TEMPO_TRANSFER_WITH_MEMO_TOPIC, p32(payer), p32(payTo), memo], data: `0x${word(40_000n)}` },
    // ガスの肩代わり（売り手側 → fee 受け）。無関係なログは無視される。
    { address: "0x20c0000000000000000000000000000000000000", topics: [TEMPO_TRANSFER_TOPIC, p32("0x58aa7ce42e1d13b2919e2ac7e006c4fbc171442c"), p32("0xfeec000000000000000000000000000000000000")], data: `0x${word(34n)}` },
  ];
  const client = fakeClient({ receipt: { status: "success", blockNumber: 39_973_670n, logs } });
  const result = await verifyTempoSettlement({ txHash: tx, network: "eip155:4217", expectedPayTo: payTo, expectedAmountUnits: "40000", expectedPayer: payer, expectedAuthNonce: memo }, { client });
  assert.equal(result.ok, true);
  // 別の購入の memo（topics[3] が違う）は、同じ受取先・同じ額でも通さない。
  const other = await verifyTempoSettlement({ txHash: tx, network: "eip155:4217", expectedPayTo: payTo, expectedAmountUnits: "40000", expectedPayer: payer, expectedAuthNonce: `0x${"ab".repeat(32)}` }, { client });
  assert.equal(other.ok, false);
  assert.equal((other as { reason: string }).reason, "nonce_not_used");
});

test("a non-indexed memo (second data word) is still read", async () => {
  const client = fakeClient({ receipt: { status: "success", blockNumber: 39_999_000n, logs: [transferLog(25_000n), memoLogInData(25_000n, MEMO)] } });
  const result = await verifyTempoSettlement({ ...input }, { client });
  assert.equal(result.ok, true);
});


// ------------------------------------------------------------
// 2026-09-19（横断監査 W4）: rpc_unavailable の detail に RPC の URL を残さない。
//
// detail は x402_l1_purchases.settlement_verify_reason として DB に残る。viem の transport
// エラーは本文に URL を含み、TEMPO_RPC_URL / SOLANA_RPC_URL は `…/v2/<key>` の形を取りうる。
// payer-funds は 2026-09-17 から redactForLog を通していたが、照合器の側は素通しだった。
// ------------------------------------------------------------
const RPC_ERROR = new Error("HTTP request failed. URL: https://tempo.example/v2/SECRETKEY. Details: fetch failed");

test("rpc_unavailable の detail は RPC の URL を伏字にする（chainId が読めない側）", async () => {
  const client = {
    getChainId: async () => {
      throw RPC_ERROR;
    },
    getBlockNumber: async () => 40_000_000n,
    getTransactionReceipt: async () => ({}) as never,
    getBlock: async () => ({}) as never,
  } as unknown as EvmVerifyClient;
  const r = await verifyTempoSettlement(input, { client });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "rpc_unavailable");
    assert.equal(r.detail?.includes("SECRETKEY"), false, `detail に鍵が残っている: ${r.detail}`);
    assert.ok(r.detail?.includes("<url>"), `伏字が入っていない: ${r.detail}`);
  }
});

test("Base（settlement-verify.ts）の rpc_unavailable も同じく伏字にする", async () => {
  const client = {
    getChainId: async () => {
      throw RPC_ERROR;
    },
    getBlockNumber: async () => 30_000_000n,
    getTransactionReceipt: async () => ({}) as never,
    getBlock: async () => ({}) as never,
  } as unknown as EvmVerifyClient;
  const r = await verifyL1Settlement(
    { txHash: TX, network: "eip155:8453", expectedPayTo: PAY_TO, expectedPayer: PAYER, expectedAmountUnits: "25000" },
    { client },
  );
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.reason, "rpc_unavailable");
    assert.equal(r.detail?.includes("SECRETKEY"), false, `detail に鍵が残っている: ${r.detail}`);
    assert.ok(r.detail?.includes("<url>"), `伏字が入っていない: ${r.detail}`);
  }
});
