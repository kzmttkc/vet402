// ============================================================
// Arbitrum One（2026-10-22・Arbitrum レーン）。
//
// ここは **読むための** クライアントだけ（chain/celo.ts と同じ役割）。署名の関門（どの network・
// どの USDC・どの EIP-712 ドメインで署名するか）は src/lib/observatory/x402-payer.ts の
// EVM_PAY_CHAINS が正典で、そちらは意図的にこのファイルを import しない（L0 設計 §0・観測所は
// scoring/chain から独立）。定数は二重に持ち、tests/x402-arbitrum-lane.test.ts が両者の一致を検査する。
//
// 実測 2026-10-22T11:16:31Z（RPC・https://arb1.arbitrum.io/rpc、再導出しない）:
//   eth_chainId 0xa4b1 = 42161 / CAIP-2 eip155:42161
//   ブロックは 278.25 ms（直近 345,600 ブロックの時刻差 96,162 秒）。1 日 ≈ 310,500 ブロック。
//   USDC 0xaf88d065e77c8cC2239327C5EDb3A432268e5831（Circle 発行・decimals 6・name "USD Coin"・
//   version "2"・EIP-3009 あり。DOMAIN_SEPARATOR() 0x08d11903…112c78 は {name, version, 42161, address}
//   から計算した EIP-712 ドメイン hash と一致）
//   explorer https://arbiscan.io/tx/<hash>
//   ブリッジ版 USDC.e（0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8）は扱わない。
//
// scoring の CHAINS 登録簿（./chains.ts）には載せない（Celo と同じ理由: あれは ERC-8004 の読み取りと
// `?chain=` の公開面を有効にする表。Arbitrum で要るのは USDC の残高・Transfer ログ・レシートの 3 つだけ）。
// ============================================================
import { createPublicClient, http } from "viem";
import { arbitrum } from "viem/chains";
import type { base } from "viem/chains";

export const ARBITRUM_CHAIN_ID = 42161;
export const ARBITRUM_CAIP2 = "eip155:42161";
export const ARBITRUM_USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
/** Bridged USDC.e. Not pinned. An accept that names this asset is never signed. */
export const ARBITRUM_USDC_E_ADDRESS = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8" as const;

/**
 * 公開 RPC。ARBITRUM_RPC_URL が未設定のときの既定（Celo の CELO_PUBLIC_RPC_URL と同じ扱い）。
 * これに倒れてよいのは**購入元の残高読みだけ**——読めなければ署名しない側へ倒れるので、
 * 公開 RPC の不調は「買わない」にしかならない。決済の再読（settlement-verify）と決済索引
 * （index-evm）は ARBITRUM_RPC_URL が無ければ動かない（公開 RPC へ黙って倒れて「確認済み」を刻まない）。
 */
export const ARBITRUM_PUBLIC_RPC_URL = "https://arb1.arbitrum.io/rpc";

export function arbitrumRpcUrl(): string {
  const fromEnv = process.env.ARBITRUM_RPC_URL?.trim();
  return fromEnv ? fromEnv : ARBITRUM_PUBLIC_RPC_URL;
}

/**
 * Arbitrum One の読み取りクライアント。型は Base のクライアントに合わせる（chain/celo.ts と同じ理由——
 * 呼び手は chain 非依存の read 面しか使わない）。
 *  - live: 残高や照合の 1 回読み（短いタイムアウト・1 リトライ）
 *  - batch: 決済索引の eth_getLogs（長いタイムアウト・3 リトライ）
 */
export function getArbitrumPublicClient(mode: "live" | "batch" = "live") {
  return createPublicClient({
    chain: arbitrum as unknown as typeof base,
    transport: http(arbitrumRpcUrl(), mode === "batch" ? { timeout: 20_000, retryCount: 3 } : { timeout: 5_000, retryCount: 1 }),
  });
}
