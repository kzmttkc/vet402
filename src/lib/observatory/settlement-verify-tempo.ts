// ============================================================
// Tempo（MPP）の L1 決済のオンチェーン照合（2026-09-17）。
//
// settlement-verify.ts（Base）と同じ契約: 期待値（受取先・金額・payer・memo）は
// **我々が署名したときの値**で、売り手の受領証の値ではない。4 条件一致の Transfer
// レグを要求し、確定数を要求し、チェーン ID を毎回読む。
//
// Tempo 固有:
//   - USDC.e（TIP-20）は precompile 実装だが `eth_getTransactionReceipt` の logs に
//     `Transfer(address,address,uint256)` と `TransferWithMemo(address,address,uint256,bytes32)`
//     の両方を出す（2026-09-17 実測: 直近 1,500 ブロックで Transfer 1,039・TransferWithMemo 273）。
//     MPP の client は `transferWithMemo` を呼ぶので、我々の購入は TransferWithMemo で
//     見つかるはず。どちらの event でも受取先・金額が一致すれば Transfer レグとして数える。
//   - 束縛材料は memo（bytes32・auth_nonce に保存）。EIP-3009 の nonce に相当する。
//     memo を持つ行は、TransferWithMemo の memo がそれと一致することを要求する
//     （同じ受取先・同じ価格の別の購入の tx を使い回せない）。
//   - feePayer:true の tx でも Transfer の `from` は我々の EOA（手数料の肩代わりは
//     署名者を変えない）。
//   - ブロックは ~1 秒。確定数 64 は ~1 分で、日次 cron の照合には常に余る。
// ============================================================
import { keccak256, toBytes } from "viem";
import { isWellFormedSettlementTx } from "@/lib/validation/settlement-tx";
import { TEMPO_CHAIN_ID, TEMPO_USDC_E, tempoRpcUrl } from "./mpp-payer";
import type { EvmVerifyClient, SettlementVerifyResult } from "./settlement-verify";

/** ERC-20 Transfer(address,address,uint256) */
export const TEMPO_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** TIP-20 TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 memo) — 2026-09-17 実測の topic。 */
export const TEMPO_TRANSFER_WITH_MEMO_TOPIC = keccak256(toBytes("TransferWithMemo(address,address,uint256,bytes32)"));

export const TEMPO_REQUIRED_CONFIRMATIONS = 64n;

function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

/**
 * TEMPO_RPC_URL を読む本番の client。**未設定なら null**——呼び手は chain_not_yet_verifiable で
 * 未確認のまま置く（Arc の ARC_RPC_URL と同じ作法。公開 RPC へ黙って倒れて「確認済み」を刻まない）。
 */
export async function defaultTempoVerifyClient(): Promise<EvmVerifyClient | null> {
  const rpc = tempoRpcUrl();
  if (!rpc) return null;
  const { createPublicClient, http } = await import("viem");
  const { tempo } = await import("viem/chains");
  // 型は Base の client で書かれた EvmVerifyClient に合わせる。使う面（getChainId / getBlockNumber /
  // getTransactionReceipt / getBlock）はチェーンに依らない。
  return createPublicClient({ chain: tempo, transport: http(rpc, { timeout: 10_000, retryCount: 1 }) }) as unknown as EvmVerifyClient;
}

export async function verifyTempoSettlement(
  input: {
    txHash: string;
    network: string;
    expectedPayTo: string;
    expectedPayer: string;
    expectedAmountUnits: string;
    /** 我々が作った帰属 memo（x402_l1_purchases.auth_nonce）。あるときだけ memo の一致を要求する。 */
    expectedAuthNonce?: string | null;
  },
  deps?: { client?: EvmVerifyClient },
): Promise<SettlementVerifyResult> {
  const { txHash, expectedPayTo, expectedPayer, expectedAmountUnits } = input;
  if (!isWellFormedSettlementTx(txHash, "evm")) return { ok: false, reason: "malformed_tx" };

  let client: EvmVerifyClient | null;
  try {
    client = deps?.client ?? (await defaultTempoVerifyClient());
  } catch (error) {
    return { ok: false, reason: "rpc_unavailable", detail: String(error).slice(0, 200) };
  }
  if (!client) return { ok: false, reason: "chain_not_yet_verifiable", detail: `${input.network}: TEMPO_RPC_URL_unset` };

  let chainId: number;
  let tip: bigint;
  try {
    [chainId, tip] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
  } catch (error) {
    return { ok: false, reason: "rpc_unavailable", detail: String(error).slice(0, 200) };
  }
  if (chainId !== TEMPO_CHAIN_ID) return { ok: false, reason: "wrong_chain", detail: `rpc reports chainId ${chainId}` };

  let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
  } catch {
    return { ok: false, reason: "tx_not_found" };
  }
  if (!receipt || receipt.status !== "success") return { ok: false, reason: "tx_reverted" };

  const confirmations = tip >= receipt.blockNumber ? tip - receipt.blockNumber + 1n : 0n;
  if (confirmations < TEMPO_REQUIRED_CONFIRMATIONS) {
    return { ok: false, reason: "insufficient_confirmations", detail: `${confirmations} < ${TEMPO_REQUIRED_CONFIRMATIONS}` };
  }

  const payToLower = expectedPayTo.toLowerCase();
  const payerLower = expectedPayer.toLowerCase();
  const usdcLower = TEMPO_USDC_E.toLowerCase();
  let expectedValue: bigint;
  try {
    expectedValue = BigInt(expectedAmountUnits);
  } catch {
    return { ok: false, reason: "no_matching_transfer", detail: "unparseable expected amount" };
  }

  // 一致した Transfer / TransferWithMemo レグの memo（TransferWithMemo のみ・data の 2 語目）。
  const matchedMemos: (string | null)[] = [];
  for (const log of receipt.logs) {
    if (log.address?.toLowerCase() !== usdcLower) continue;
    const topic0 = log.topics[0]?.toLowerCase();
    const isPlain = topic0 === TEMPO_TRANSFER_TOPIC;
    const isMemo = topic0 === TEMPO_TRANSFER_WITH_MEMO_TOPIC.toLowerCase();
    if (!isPlain && !isMemo) continue;
    const from = log.topics[1];
    const to = log.topics[2];
    if (!from || !to) continue;
    if (topicToAddress(from) !== payerLower || topicToAddress(to) !== payToLower) continue;
    const data = typeof log.data === "string" ? log.data : "";
    let value: bigint;
    try {
      value = BigInt(data.slice(0, 66));
    } catch {
      continue;
    }
    if (value !== expectedValue) continue;
    matchedMemos.push(isMemo && data.length >= 130 ? `0x${data.slice(66, 130)}`.toLowerCase() : null);
  }
  if (matchedMemos.length === 0) {
    return {
      ok: false,
      reason: "no_matching_transfer",
      detail: `no USDC.e Transfer ${payerLower}→${payToLower} of ${expectedAmountUnits} in ${txHash}`,
    };
  }

  // 束縛: 我々の memo を持つ行は、その memo の TransferWithMemo を要求する（x402 の nonce_not_used と同じ語彙）。
  const expectedMemo = input.expectedAuthNonce?.trim().toLowerCase();
  if (expectedMemo && !matchedMemos.includes(expectedMemo)) {
    return {
      ok: false,
      reason: "nonce_not_used",
      detail: `memo ${expectedMemo} not carried by a TransferWithMemo ${payerLower}→${payToLower} in ${txHash}`.slice(0, 200),
    };
  }

  let blockTimestamp: Date | null = null;
  try {
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    blockTimestamp = new Date(Number(block.timestamp) * 1000);
  } catch {
    blockTimestamp = null;
  }
  return { ok: true, blockTimestamp, confirmations, blockNumber: receipt.blockNumber };
}
