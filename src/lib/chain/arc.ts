// ============================================================
// Arc — Circle のステーブルコイン L1（2026-09-17・Arc レーン）。
//
// ここは **読むための** クライアントだけ。署名の関門（どの network・どの USDC・どの
// EIP-712 ドメインで署名するか）は src/lib/observatory/x402-payer.ts の EVM_PAY_CHAINS が
// 正典で、そちらは意図的にこのファイルを import しない（L0 設計 §0・観測所は
// scoring/chain から独立）。定数は二重に持ち、tests/x402-evm-chains.test.ts と
// tests/settlements-evm-index-arc.test.ts が両者の一致を検査する。
//
// 実測 2026-09-17（RPC・https://rpc.mainnet.arc.io、再導出しない）:
//   chainId 5042 / CAIP-2 eip155:5042 / メインネット公開 2026-09-16 / ガスは USDC（ETH 無し）
//   USDC 0x3600000000000000000000000000000000000000（decimals 6・EIP-3009 あり）
//   explorer https://explorer.arc.io/tx/<hash> / testnet eip155:5042002
//
// なぜ scoring の CHAINS 登録簿（./chains.ts）に載せないか: あれは ERC-8004 の読み取りと
// `?chain=` の公開面を有効にする表で、Arc に登録簿が展開されている事実を我々は確かめて
// いない。Arc で要るのは USDC の残高・Transfer ログ・レシートの 3 つだけなので、
// ここで別に組む。
// ============================================================
import { createPublicClient, http } from "viem";
import { arc } from "viem/chains";
import type { base } from "viem/chains";

export const ARC_CHAIN_ID = 5042;
export const ARC_CAIP2 = "eip155:5042";
export const ARC_USDC_ADDRESS = "0x3600000000000000000000000000000000000000" as const;

/**
 * 公開 RPC。ARC_RPC_URL が未設定のときの既定（オーナー指定 2026-09-17）。
 * Base の残高読み（BASE_RPC_URL 必須・公開 RPC へ倒れない）とは規律が違うが、
 * 決済索引（index-evm）は従来どおり ARC_RPC_URL が無ければ静かに skip する。
 */
export const ARC_PUBLIC_RPC_URL = "https://rpc.mainnet.arc.io";

export function arcRpcUrl(): string {
  const fromEnv = process.env.ARC_RPC_URL?.trim();
  return fromEnv ? fromEnv : ARC_PUBLIC_RPC_URL;
}

/**
 * Arc の読み取りクライアント。型は Base のクライアントに合わせる（chain/client.ts と
 * 同じ理由——呼び手は chain 非依存の read 面しか使わない）。
 *  - live: 残高や照合の 1 回読み（短いタイムアウト・1 リトライ）
 *  - batch: 決済索引の eth_getLogs（長いタイムアウト・3 リトライ・client.ts の BATCH と同じ）
 */
export function getArcPublicClient(mode: "live" | "batch" = "live") {
  return createPublicClient({
    chain: arc as unknown as typeof base,
    transport: http(arcRpcUrl(), mode === "batch" ? { timeout: 20_000, retryCount: 3 } : { timeout: 5_000, retryCount: 1 }),
  });
}
