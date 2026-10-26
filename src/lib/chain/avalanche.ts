// ============================================================
// Avalanche C-Chain（2026-10-26・Avalanche レーン）。
//
// ここは **読むための** クライアントだけ（chain/arbitrum.ts と同じ役割）。署名の関門（どの network・
// どの USDC・どの EIP-712 ドメインで署名するか）は src/lib/observatory/x402-payer.ts の
// EVM_PAY_CHAINS が正典で、そちらは意図的にこのファイルを import しない（L0 設計 §0・観測所は
// scoring/chain から独立）。定数は二重に持ち、tests/x402-avalanche-lane.test.ts が両者の一致を検査する。
//
// 実測 2026-10-26T10:42:23.389Z（RPC・https://api.avax.network/ext/bc/C/rpc、再導出しない）:
//   eth_chainId 0xa86a = 43114 / CAIP-2 eip155:43114
//   ヘッド 98596954 の時刻 2026-10-26T10:42:25.000Z。172,800 ブロック前との時刻差 167,543 秒
//   （969.578 ms/ブロック）。1 日 = round(86400 * 172800 / 167543) = 89,111 ブロック。
//   USDC 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E（decimals 6・name "USD Coin"・
//   version "2"・EIP-3009 あり。DOMAIN_SEPARATOR() 0xbbea2003…77f7b3 は {name, version, 43114, address}
//   から計算した EIP-712 ドメイン hash と一致）
//   eth_getLogs の上限は 2026-10-26T10:43:41.960Z（ヘッド 98597030）に測った。包含 100 ブロックは答え、
//   101 ブロックは -32602「maximum of 100 blocks」で断る。絞り込みでも上限は上がらない。
//   explorer https://snowtrace.io/tx/<hash>
//   ブリッジ版 USDC.e（0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664）は扱わない。
//   EURC（0xC891EB4cbdEFf6e073e859e987815Ed1505c2ACD）も扱わない。
//
// scoring の CHAINS 登録簿（./chains.ts）には載せない（Arbitrum と同じ理由: あれは ERC-8004 の読み取りと
// `?chain=` の公開面を有効にする表。Avalanche で要るのは USDC の残高・Transfer ログ・レシートの 3 つだけ）。
// ============================================================
import { createPublicClient, http } from "viem";
import { avalanche } from "viem/chains";
import type { base } from "viem/chains";

export const AVALANCHE_CHAIN_ID = 43114;
export const AVALANCHE_CAIP2 = "eip155:43114";
export const AVALANCHE_USDC_ADDRESS = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E" as const;
/** Bridged USDC.e. Not pinned. An accept that names this asset is never signed. */
export const AVALANCHE_USDC_E_ADDRESS = "0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664" as const;

/**
 * 公開 RPC。AVALANCHE_RPC_URL が未設定のときの既定（Arbitrum の ARBITRUM_PUBLIC_RPC_URL と同じ扱い）。
 * これに倒れてよいのは**購入元の残高読みだけ**——読めなければ署名しない側へ倒れるので、
 * 公開 RPC の不調は「買わない」にしかならない。決済の再読（settlement-verify）と決済索引
 * （index-evm）は AVALANCHE_RPC_URL が無ければ動かない（公開 RPC へ黙って倒れて「確認済み」を刻まない）。
 */
export const AVALANCHE_PUBLIC_RPC_URL = "https://api.avax.network/ext/bc/C/rpc";

export function avalancheRpcUrl(): string {
  const fromEnv = process.env.AVALANCHE_RPC_URL?.trim();
  return fromEnv ? fromEnv : AVALANCHE_PUBLIC_RPC_URL;
}

/**
 * Avalanche C-Chain の読み取りクライアント。型は Base のクライアントに合わせる（chain/arbitrum.ts と同じ理由——
 * 呼び手は chain 非依存の read 面しか使わない）。
 *  - live: 残高や照合の 1 回読み（短いタイムアウト・1 リトライ）
 *  - batch: 決済索引の eth_getLogs（長いタイムアウト・3 リトライ）
 */
export function getAvalanchePublicClient(mode: "live" | "batch" = "live") {
  return createPublicClient({
    chain: avalanche as unknown as typeof base,
    transport: http(avalancheRpcUrl(), mode === "batch" ? { timeout: 20_000, retryCount: 3 } : { timeout: 5_000, retryCount: 1 }),
  });
}
