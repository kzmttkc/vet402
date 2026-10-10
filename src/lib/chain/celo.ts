// ============================================================
// Celo mainnet（2026-10-10・Celo レーン）。
//
// ここは **読むための** クライアントだけ（chain/arc.ts と同じ役割）。署名の関門（どの network・
// どの USDC・どの EIP-712 ドメインで署名するか）は src/lib/observatory/x402-payer.ts の
// EVM_PAY_CHAINS が正典で、そちらは意図的にこのファイルを import しない（L0 設計 §0・観測所は
// scoring/chain から独立）。定数は二重に持ち、tests/x402-celo-lane.test.ts が両者の一致を検査する。
//
// 実測 2026-10-10（RPC・https://forno.celo.org、再導出しない）:
//   eth_chainId 0xa4ec = 42220 / CAIP-2 eip155:42220 / ブロックは 1 秒（直近 86,400 ブロックの時刻差で実測）
//   USDC 0xcebA9300f2b948710d2653dD7B07f33A8B32118C（decimals 6・name "USDC"・version "2"・EIP-3009 あり）
//   explorer https://celoscan.io/tx/<hash>
//   x402 の決済のレシート（facilitator 0x0d74…FB48 が出した実在の 3 本）は、USDC の
//   AuthorizationUsed(authorizer, nonce) と Transfer(from, to, value) の 2 本だけ——Base と同じ形。
//
// scoring の CHAINS 登録簿（./chains.ts）には載せない（Arc と同じ理由: あれは ERC-8004 の読み取りと
// `?chain=` の公開面を有効にする表。Celo で要るのは USDC の残高・Transfer ログ・レシートの 3 つだけ）。
// ============================================================
import { createPublicClient, http } from "viem";
import { celo } from "viem/chains";
import type { base } from "viem/chains";

export const CELO_CHAIN_ID = 42220;
export const CELO_CAIP2 = "eip155:42220";
export const CELO_USDC_ADDRESS = "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" as const;

/**
 * 公開 RPC。CELO_RPC_URL が未設定のときの既定（Arc の ARC_PUBLIC_RPC_URL と同じ扱い）。
 * これに倒れてよいのは**購入元の残高読みだけ**——読めなければ署名しない側へ倒れるので、
 * 公開 RPC の不調は「買わない」にしかならない。決済の再読（settlement-verify）と決済索引
 * （index-evm）は CELO_RPC_URL が無ければ動かない（公開 RPC へ黙って倒れて「確認済み」を刻まない）。
 */
export const CELO_PUBLIC_RPC_URL = "https://forno.celo.org";

export function celoRpcUrl(): string {
  const fromEnv = process.env.CELO_RPC_URL?.trim();
  return fromEnv ? fromEnv : CELO_PUBLIC_RPC_URL;
}

/**
 * Celo の読み取りクライアント。型は Base のクライアントに合わせる（chain/arc.ts と同じ理由——
 * 呼び手は chain 非依存の read 面しか使わない）。
 *  - live: 残高や照合の 1 回読み（短いタイムアウト・1 リトライ）
 *  - batch: 決済索引の eth_getLogs（長いタイムアウト・3 リトライ）
 */
export function getCeloPublicClient(mode: "live" | "batch" = "live") {
  return createPublicClient({
    chain: celo as unknown as typeof base,
    transport: http(celoRpcUrl(), mode === "batch" ? { timeout: 20_000, retryCount: 3 } : { timeout: 5_000, retryCount: 1 }),
  });
}
