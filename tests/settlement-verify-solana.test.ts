// ============================================================
// Solana の L1 決済照合（settled を名乗らせる唯一の関門の Solana 側）。
//
// なぜ要るか: verifyL1Settlement は EVM 専用で、Solana は
// chain_not_yet_verifiable を返して止まっていた。その結果、本番の Solana L1
// 購入 38 件は settled 0 件・settle_claimed 26 件のまま滞留し、公開している
// 成立率に「払ったが確かめていない」行として残り続けた。
//
// EVM 版と同じ厳しさを Solana の形で要求する:
//   - 署名の形（base58）
//   - 正しいクラスタ（getGenesisHash が network の CAIP-2 参照と一致）
//   - tx が成功している（meta.err === null）
//   - 宛先・金額・支払元を **命令の parse ではなく残高差分**で見る
//     （Token-2022・複数命令・CPI に強い）
//   - finalized であること（未確定は not_final で未確認のまま置く）
//
// 測っていないものを「偽物」と言わない: 読めなかったものは一時的な理由で返し、
// 台帳の status を倒さない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  verifySolanaSettlement,
  type SolanaVerifyRpc,
  type SolanaTokenBalance,
} from "@/lib/observatory/settlement-verify-solana";
import { SOLANA_MAINNET_CAIP2, SOLANA_USDC_MINT } from "@/lib/observatory/sol402-payer";

const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wq3je9rb9jM";

/** 本番実在の署名（2026-08-31・200000 units）。形だけ借りる。 */
const SIG = "3NVyZKtTvvocwuMqqTjLswmhajnJugUKwCV2hAjcp4eDuYceQ2Q3hoNcR71N92EbFq5QBKonpdt93uVaqQxfkh69";
const PAYER = "34CMQ3HB3aDWPxwAbLSbQPrBtrFhi354zAsfbb3z5v2z";
const PAYEE = "GqSs5L9aPWGJwyRQe35YKQaWMDPh3R1dMqfSEPhSgkM";
const SLOT = 443_147_828;

const bal = (accountIndex: number, owner: string, amount: string, mint = SOLANA_USDC_MINT): SolanaTokenBalance => ({
  accountIndex,
  mint,
  owner,
  uiTokenAmount: { amount, decimals: 6 },
});

/** 支払元が `moved` 減り、受取先が `received` 増える最小の meta。 */
function balances(moved: bigint, received: bigint) {
  const payerBefore = 6_388_000n;
  const payeeBefore = 64_310_825n;
  return {
    pre: [bal(2, PAYER, String(payerBefore)), bal(3, PAYEE, String(payeeBefore))],
    post: [bal(2, PAYER, String(payerBefore - moved)), bal(3, PAYEE, String(payeeBefore + received))],
  };
}

function fakeRpc(overrides: Partial<SolanaVerifyRpc> & { moved?: bigint; received?: bigint } = {}): SolanaVerifyRpc {
  const { pre, post } = balances(overrides.moved ?? 200_000n, overrides.received ?? 200_000n);
  return {
    getGenesisHash: overrides.getGenesisHash ?? (async () => MAINNET_GENESIS),
    getSignatureStatus:
      overrides.getSignatureStatus ??
      (async () => ({
        contextSlot: SLOT + 900_000,
        value: { err: null, confirmationStatus: "finalized", slot: SLOT },
      })),
    getTransaction:
      overrides.getTransaction ??
      (async () => ({
        slot: SLOT,
        blockTime: 1_788_178_160,
        meta: { err: null, preTokenBalances: pre, postTokenBalances: post },
      })),
  };
}

const input = {
  txHash: SIG,
  network: SOLANA_MAINNET_CAIP2,
  expectedPayTo: PAYEE,
  expectedPayer: PAYER,
  expectedAmountUnits: "200000",
};

test("finalized の実 tx で、宛先・金額・支払元が一致すれば settled と判定する", async () => {
  const result = await verifySolanaSettlement(input, { rpc: fakeRpc() });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.blockNumber, BigInt(SLOT));
  assert.ok(result.confirmations > 0n, "slot 距離が 0 のまま返っている");
  assert.equal(result.blockTimestamp?.getTime(), 1_788_178_160 * 1000);
});

test("受取額が期待より少なければ amount_mismatch（多い分には通す）", async () => {
  const short = await verifySolanaSettlement(input, { rpc: fakeRpc({ moved: 199_999n, received: 199_999n }) });
  assert.equal(short.ok, false);
  if (short.ok) return;
  assert.equal(short.reason, "amount_mismatch");

  const over = await verifySolanaSettlement(input, { rpc: fakeRpc({ moved: 250_000n, received: 250_000n }) });
  assert.equal(over.ok, true);
});

test("期待した宛先が受け取っていなければ payee_mismatch", async () => {
  const result = await verifySolanaSettlement(
    { ...input, expectedPayTo: "HFYkH6SUuXLvzGbuB76vJ8u76NG3X25wdd1A7mDM4cSw" },
    { rpc: fakeRpc() },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "payee_mismatch");
});

test("支払元の残高が対応して減っていなければ payer_mismatch", async () => {
  const result = await verifySolanaSettlement(input, { rpc: fakeRpc({ moved: 0n, received: 200_000n }) });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "payer_mismatch");
});

test("USDC 以外の mint の残高差分は決済と読まない", async () => {
  const other = "So11111111111111111111111111111111111111112";
  const rpc = fakeRpc({
    getTransaction: async () => ({
      slot: SLOT,
      blockTime: null,
      meta: {
        err: null,
        preTokenBalances: [bal(2, PAYER, "6388000", other), bal(3, PAYEE, "0", other)],
        postTokenBalances: [bal(2, PAYER, "6188000", other), bal(3, PAYEE, "200000", other)],
      },
    }),
  });
  const result = await verifySolanaSettlement(input, { rpc });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "payee_mismatch");
});

test("devnet の RPC を mainnet の決済に使ったら wrong_chain（クラスタを読み違えない）", async () => {
  const result = await verifySolanaSettlement(input, {
    rpc: fakeRpc({ getGenesisHash: async () => DEVNET_GENESIS }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "wrong_chain");
  assert.match(result.detail ?? "", /EtWTRABZ/, "実際に読んだクラスタが理由に残っていない");
});

test("finalized でなければ not_final（未確認のまま置く・偽物とは言わない）", async () => {
  const result = await verifySolanaSettlement(input, {
    rpc: fakeRpc({
      getSignatureStatus: async () => ({
        contextSlot: SLOT + 2,
        value: { err: null, confirmationStatus: "confirmed", slot: SLOT },
      }),
    }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "not_final");
});

test("署名が見つからなければ tx_not_found", async () => {
  const result = await verifySolanaSettlement(input, {
    rpc: fakeRpc({ getSignatureStatus: async () => ({ contextSlot: SLOT, value: null }) }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "tx_not_found");
});

test("status は finalized でも getTransaction が返さなければ tx_not_found", async () => {
  const result = await verifySolanaSettlement(input, { rpc: fakeRpc({ getTransaction: async () => null }) });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "tx_not_found");
});

test("tx が失敗している（meta.err）なら tx_reverted", async () => {
  const { pre, post } = balances(200_000n, 200_000n);
  const result = await verifySolanaSettlement(input, {
    rpc: fakeRpc({
      getTransaction: async () => ({
        slot: SLOT,
        blockTime: null,
        meta: { err: { InstructionError: [2, "Custom"] }, preTokenBalances: pre, postTokenBalances: post },
      }),
    }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "tx_reverted");
});

test("署名の形が不正なら RPC を一度も叩かずに malformed_tx", async () => {
  let calls = 0;
  const rpc = fakeRpc({
    getGenesisHash: async () => {
      calls++;
      return MAINNET_GENESIS;
    },
  });
  const result = await verifySolanaSettlement({ ...input, txHash: "0xdeadbeef" }, { rpc });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "malformed_tx");
  assert.equal(calls, 0, "形が不正な署名で RPC を叩いている");
});

test("SOLANA_RPC_URL 未設定は公開 RPC へ黙って倒れず rpc_unavailable（fail-loud）", async () => {
  const saved = process.env.SOLANA_RPC_URL;
  delete process.env.SOLANA_RPC_URL;
  try {
    const result = await verifySolanaSettlement(input);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, "rpc_unavailable");
    assert.match(result.detail ?? "", /SOLANA_RPC_URL/);
  } finally {
    if (saved !== undefined) process.env.SOLANA_RPC_URL = saved;
  }
});

test("RPC が答えなければ rpc_unavailable（否定にしない）", async () => {
  const result = await verifySolanaSettlement(input, {
    rpc: fakeRpc({
      getTransaction: async () => {
        throw new Error("503 Service Unavailable");
      },
    }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "rpc_unavailable");
});

test("残高に owner が無い（帰属できない）なら rpc_unavailable——0 と読んで告発しない", async () => {
  const strip = (b: SolanaTokenBalance): SolanaTokenBalance => ({ ...b, owner: undefined });
  const { pre, post } = balances(200_000n, 200_000n);
  const result = await verifySolanaSettlement(input, {
    rpc: fakeRpc({
      getTransaction: async () => ({
        slot: SLOT,
        blockTime: null,
        meta: { err: null, preTokenBalances: pre.map(strip), postTokenBalances: post.map(strip) },
      }),
    }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "rpc_unavailable");
});

test("network が別クラスタの CAIP-2 なら、mainnet RPC で読んで wrong_chain", async () => {
  const result = await verifySolanaSettlement(
    { ...input, network: `solana:${DEVNET_GENESIS.slice(0, 32)}` },
    { rpc: fakeRpc() },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "wrong_chain");
});

test("verifyL1Settlement は solana: を照合器へ委譲する（chain_not_yet_verifiable で止めない）", async () => {
  const { verifyL1Settlement } = await import("@/lib/observatory/settlement-verify");
  const saved = process.env.SOLANA_RPC_URL;
  delete process.env.SOLANA_RPC_URL;
  try {
    const result = await verifyL1Settlement(input);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.notEqual(result.reason, "chain_not_yet_verifiable");
    assert.equal(result.reason, "rpc_unavailable");
  } finally {
    if (saved !== undefined) process.env.SOLANA_RPC_URL = saved;
  }
});

test("未知のチェーンは今までどおり chain_not_yet_verifiable（推測で照合しない）", async () => {
  const { verifyL1Settlement } = await import("@/lib/observatory/settlement-verify");
  const result = await verifyL1Settlement({ ...input, network: "algorand:mainnet" });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "chain_not_yet_verifiable");
});

test("not_final は一時的な理由として扱う（settle_claim_refuted へ倒さない）", async () => {
  const { readFileSync } = await import("node:fs");
  const j = readFileSync("src/lib/observatory/settlement-verifier.ts", "utf8");
  const transient = j.slice(j.indexOf("TRANSIENT_REASONS"), j.indexOf("export type VerifySettlementsSummary"));
  assert.match(transient, /"not_final"/, "not_final が一時扱いから外れている");
});
