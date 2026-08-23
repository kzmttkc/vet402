// ============================================================
// L1 決済のオンチェーン照合（2026-08-23 監査 C-4 の本丸）。
//
// **settled の定義を置き換える。**
//   旧: 売り手が PAYMENT-RESPONSE で success:true と何らかの文字列を返した
//   新: 我々がチェーンで確認した
//
// なぜ要るか: 決済の真偽値も tx ハッシュも、売り手が返すヘッダの中身だった
// （parseSettlementResponse は「空でない文字列」以外を何も見ていなかった）。
// 売り手は決済せずに success:true と架空のハッシュを返すだけで「決済成功」の
// 行を作れ、その行が公開台帳・公開バッジ・CSV になり、2026-08-22 以降は
// スコアの最上位軸にも流れた。「決済txハッシュを公開している、検算してくれ」
// という製品の中心主張が、自分では一度も検算していない状態だった。
//
// ここでやる照合は、既存の x402-verify.ts（顧客が申告した tx の検証）とは
// 別物。あちらは「送信元が一致する Transfer レグのどれか」を採るが、L1 では
// **期待値が全部わかっている**——誰にいくらどのトークンで払うつもりだったかを
// 自分で決めて署名している。だから「どれか」ではなく完全一致を要求する。
//
// 意図的に厳しい側へ倒している箇所と、その理由:
//   - チェーンIDを毎回読む。BASE_RPC_URL が Base を指している保証はどこにも
//     無かった（監査 H-4）。別チェーンの同名イベントを Base の決済と読むのが
//     一番静かな失敗の仕方なので、最初に潰す。
//   - 確定数を要求する。この照合は日次 cron で購入の何時間も後に走るので、
//     深めの確定数はタダで買える。reorg で消えた tx を「確認済み」と刻まない。
//   - Transfer レグは from / to / value / トークンの4つすべてが期待値と一致する
//     ものだけを採る。同額の無関係な transfer や、別トークンの同名イベントを
//     決済と読まない。
// ============================================================
import { getPublicClient } from "@/lib/chain/client";
import { BASE_USDC_ADDRESS } from "@/lib/chain/config";
import { isWellFormedSettlementTx } from "@/lib/validation/settlement-tx";

/** ERC-20 Transfer(address,address,uint256) */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const BASE_CHAIN_ID = 8453;

/**
 * 要求する確定数。
 *
 * この照合は日次 cron が購入の何時間も後に走るので、実際の確定数は数千〜数万に
 * なる。つまり 32 は「厳しい」のではなく **タダ**で、その代わり浅い reorg で
 * 消えた tx を「確認済み」として恒久記録する事故を確実に防ぐ。
 * 逆に購入直後に同期で照合しようとすると、これは待ち時間になる——だから
 * 照合は非同期の cron に置いてある。
 */
export const REQUIRED_CONFIRMATIONS = 32n;

export type SettlementVerifyResult =
  | { ok: true; blockTimestamp: Date | null; confirmations: bigint; blockNumber: bigint }
  | {
      ok: false;
      reason:
        | "malformed_tx"
        | "chain_not_yet_verifiable"
        | "rpc_unavailable"
        | "wrong_chain"
        | "tx_not_found"
        | "tx_reverted"
        | "insufficient_confirmations"
        | "no_matching_transfer";
      detail?: string;
    };

function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

/**
 * 1件の L1 決済主張をチェーンで確かめる。
 *
 * 期待値（payTo / amount / payer）は**我々が署名したときの値**を渡すこと。
 * 売り手が返した値を渡してはいけない——それでは自己申告の照合にしかならない。
 */
export async function verifyL1Settlement(input: {
  txHash: string;
  network: string;
  expectedPayTo: string;
  expectedPayer: string;
  expectedAmountUnits: string;
}): Promise<SettlementVerifyResult> {
  const { txHash, network, expectedPayTo, expectedPayer, expectedAmountUnits } = input;

  // Solana の決済は署名の形も検証手順も別物で、まだ照合器を書いていない。
  // 「EVM のやり方で読めなかった」を「偽物」と言うのは、測っていないものを
  // 所見にすることなので、専用の理由で返して未確認のまま置く。
  if (!network.startsWith("eip155:")) {
    return { ok: false, reason: "chain_not_yet_verifiable", detail: network };
  }

  if (!isWellFormedSettlementTx(txHash, "evm")) {
    return { ok: false, reason: "malformed_tx" };
  }

  const client = getPublicClient();

  // 1. まず「いま読んでいるのは本当に Base か」。
  let chainId: number;
  let tip: bigint;
  try {
    [chainId, tip] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
  } catch (error) {
    return { ok: false, reason: "rpc_unavailable", detail: String(error).slice(0, 200) };
  }
  if (chainId !== BASE_CHAIN_ID) {
    return { ok: false, reason: "wrong_chain", detail: `rpc reports chainId ${chainId}` };
  }

  // 2. レシート。
  let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
  } catch {
    // 「存在しない」と「RPCが答えられなかった」をここでは区別できない。
    // どちらも確認できていないので確認済みにはしないが、tx_not_found として
    // 記録し、cron の再走で回復できるようにする（恒久の否定にしない）。
    return { ok: false, reason: "tx_not_found" };
  }
  if (!receipt || receipt.status !== "success") {
    return { ok: false, reason: "tx_reverted" };
  }

  // 3. 確定数。
  const confirmations = tip >= receipt.blockNumber ? tip - receipt.blockNumber + 1n : 0n;
  if (confirmations < REQUIRED_CONFIRMATIONS) {
    return {
      ok: false,
      reason: "insufficient_confirmations",
      detail: `${confirmations} < ${REQUIRED_CONFIRMATIONS}`,
    };
  }

  // 4. 期待どおりの USDC Transfer が実際に入っているか。4条件すべて一致。
  const payToLower = expectedPayTo.toLowerCase();
  const payerLower = expectedPayer.toLowerCase();
  const usdcLower = BASE_USDC_ADDRESS.toLowerCase();
  let expectedValue: bigint;
  try {
    expectedValue = BigInt(expectedAmountUnits);
  } catch {
    return { ok: false, reason: "no_matching_transfer", detail: "unparseable expected amount" };
  }

  const matched = receipt.logs.some((log) => {
    if (log.address?.toLowerCase() !== usdcLower) return false;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return false;
    const from = log.topics[1];
    const to = log.topics[2];
    if (!from || !to) return false;
    if (topicToAddress(from) !== payerLower) return false;
    if (topicToAddress(to) !== payToLower) return false;
    let value: bigint;
    try {
      value = BigInt(log.data);
    } catch {
      return false;
    }
    return value === expectedValue;
  });

  if (!matched) {
    return {
      ok: false,
      reason: "no_matching_transfer",
      detail: `no USDC Transfer ${payerLower}→${payToLower} of ${expectedAmountUnits} in ${txHash}`,
    };
  }

  // 5. ブロック時刻。読めなくても照合の成否は変わらない（日次軸のためだけ）。
  let blockTimestamp: Date | null = null;
  try {
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    blockTimestamp = new Date(Number(block.timestamp) * 1000);
  } catch {
    blockTimestamp = null;
  }

  return { ok: true, blockTimestamp, confirmations, blockNumber: receipt.blockNumber };
}
