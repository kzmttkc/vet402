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
import { keccak256, toBytes } from "viem";
import { getPublicClient } from "@/lib/chain/client";
import { BASE_USDC_ADDRESS } from "@/lib/chain/config";
import { isWellFormedSettlementTx } from "@/lib/validation/settlement-tx";

/** ERC-20 Transfer(address,address,uint256) */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * EIP-3009 `AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)`
 * ——**我々の署名とこの tx を結びつける唯一の材料**（2026-09-04 監査 P1-1）。
 *
 * それまでの照合は「payer→payTo の USDC Transfer が金額ちょうど」しか見ておらず、
 * 我々の署名とも購入行とも結びついていなかった。同じ payTo × 同じ価格の
 * endpoint は本番実測で 253 グループ・1,477 試行あり、最大 27 endpoint に
 * 1 本の tx を使い回して全部 settled にできた。
 *
 * nonce は我々が randomBytes(32) で作って署名した値で、売り手には選べない。
 * USDC は消費時にこのイベントを出すので、「その tx の中で、我々の nonce が、
 * 我々の authorizer で使われたか」はチェーンだけで判定できる。
 *
 * 値は keccak で導く（ハードコードした 32 バイトは誰にも検算できない）。
 * 本番の実レシート 2 件で実在を確認済み（2026-09-04・Base mainnet・canonical USDC）:
 *   0x3bcba4fb5894d8aecd7be5fd287935ed19ea6dbe28e948f6402b59201a3f462c
 *   0xcebaa481ece766ab38251fe37806ccb8a66a7f4b619fb37ca186a9fd3cdf6b28
 * どちらも topics[1] が payer、topics[2] が nonce だった。
 */
export const AUTHORIZATION_USED_TOPIC = keccak256(toBytes("AuthorizationUsed(address,bytes32)"));

const BASE_CHAIN_ID = 8453;

/**
 * 照合が使う EVM RPC の面（テストでは偽物を注入する）。
 * Solana 側（settlement-verify-solana.ts の SolanaVerifyRpc）と同じ役割。
 */
export type EvmVerifyClient = Pick<
  ReturnType<typeof getPublicClient>,
  "getChainId" | "getBlockNumber" | "getTransactionReceipt" | "getBlock"
>;

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
        | "no_matching_transfer"
        // 2026-09-04 監査 P1-1。どちらも「その tx はこの購入のものではない」で、
        // 売り手についての恒久の所見（TRANSIENT_REASONS に入れない）。
        //   nonce_not_used  我々が署名した EIP-3009 nonce が、その tx で
        //                   我々の authorizer によって消費されていない。
        //   tx_hash_reused  同じ tx を別の購入行が既に決済レシートに使っている。
        | "nonce_not_used"
        | "tx_hash_reused"
        // Solana 経路（settlement-verify-solana.ts）。EVM の
        // insufficient_confirmations / no_matching_transfer に相当する語彙を、
        // Solana の読み方（finalized・残高差分）に合わせて分けたもの。
        | "not_final"
        | "amount_mismatch"
        | "payee_mismatch"
        | "payer_mismatch";
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
export async function verifyL1Settlement(
  input: {
    txHash: string;
    network: string;
    expectedPayTo: string;
    expectedPayer: string;
    expectedAmountUnits: string;
    /**
     * 我々が署名した EIP-3009 の nonce（x402_l1_purchases.auth_nonce）。
     * **これがあるときだけ**、その nonce の AuthorizationUsed を要求する。
     * 旧行（2026-09-04 の記帳より前）は null で来るので従来の判定に落ちる——
     * 持っていない証拠を理由に、無実の売り手を refuted にしない。
     */
    expectedAuthNonce?: string | null;
  },
  deps?: { client?: EvmVerifyClient },
): Promise<SettlementVerifyResult> {
  const { txHash, network, expectedPayTo, expectedPayer, expectedAmountUnits } = input;

  // Solana の決済は署名の形も検証手順も別物なので、専用の照合器へ委譲する
  // （2026-09-04・それまでは chain_not_yet_verifiable で止まり、Solana の
  // L1 購入 38 件が settled 0 件のまま滞留していた）。
  if (network.startsWith("solana:")) {
    const { verifySolanaSettlement } = await import("./settlement-verify-solana");
    return verifySolanaSettlement(input);
  }

  // それ以外のチェーンには照合器が無い。「EVM のやり方で読めなかった」を
  // 「偽物」と言うのは、測っていないものを所見にすることなので、専用の理由で
  // 返して未確認のまま置く。
  if (!network.startsWith("eip155:")) {
    return { ok: false, reason: "chain_not_yet_verifiable", detail: network };
  }

  if (!isWellFormedSettlementTx(txHash, "evm")) {
    return { ok: false, reason: "malformed_tx" };
  }

  const client: EvmVerifyClient = deps?.client ?? getPublicClient();

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

  // 5. **この tx が我々のこの購入のものか**（2026-09-04 監査 P1-1）。
  //
  // 4 まででわかるのは「payer から payTo へ期待額の USDC が動いた tx がある」
  // までで、それは同じ payTo・同じ価格の別の購入でも成り立つ。売り手は自分が
  // 受け取った過去の tx ハッシュを返すだけで、払っていない購入を settled に
  // できた。結びつけの材料は EIP-3009 の nonce——我々が randomBytes(32) で
  // 作って署名した値で、売り手には選べず、USDC が消費時に
  // AuthorizationUsed(authorizer, nonce) として必ず出す。
  const expectedNonce = input.expectedAuthNonce?.trim().toLowerCase();
  if (expectedNonce) {
    const nonceUsed = receipt.logs.some((log) => {
      if (log.address?.toLowerCase() !== usdcLower) return false;
      if (log.topics[0]?.toLowerCase() !== AUTHORIZATION_USED_TOPIC) return false;
      const authorizer = log.topics[1];
      const nonce = log.topics[2];
      if (!authorizer || !nonce) return false;
      if (topicToAddress(authorizer) !== payerLower) return false;
      return nonce.toLowerCase() === expectedNonce;
    });
    if (!nonceUsed) {
      return {
        ok: false,
        reason: "nonce_not_used",
        detail: `authorization ${expectedNonce} was not consumed by ${payerLower} in ${txHash}`.slice(0, 200),
      };
    }
  }

  // 6. ブロック時刻。読めなくても照合の成否は変わらない（日次軸のためだけ）。
  let blockTimestamp: Date | null = null;
  try {
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    blockTimestamp = new Date(Number(block.timestamp) * 1000);
  } catch {
    blockTimestamp = null;
  }

  return { ok: true, blockTimestamp, confirmations, blockNumber: receipt.blockNumber };
}
