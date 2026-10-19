// ============================================================
// BNB Chain mainnet（2026-10-19・BNB レーン・段B1）。
//
// ここは **読むための** クライアントだけ（chain/celo.ts と同じ役割）。署名の関門（どの network・
// どのトークン・どの EIP-712 ドメインで署名するか）は src/lib/observatory/x402-payer.ts の
// EVM_PAY_CHAINS が正典で、そちらは意図的にこのファイルを import しない（L0 設計 §0・観測所は
// scoring/chain から独立）。定数は二重に持ち、tests/x402-bnb-lane.test.ts が両者の一致を検査する。
//
// 実測 2026-10-19（RPC・https://bsc-dataseed.bnbchain.org、再導出しない）:
//   chain id 56 / CAIP-2 eip155:56
//   USD1（World Liberty Financial USD）0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d
//   decimals 18 / EIP-712 name "World Liberty Financial USD" / version "1"
//   EIP-3009 あり（TRANSFER_WITH_AUTHORIZATION_TYPEHASH 0x7c7c…2267・authorizationState が読める）
//   accept の extra は assetTransferMethod "eip3009"
//
// 払うのはこの USD1 の eip3009 だけ。permit2・permit2-exact・USDC(BSC)・USDT・United Stables は
// 表に無いので署名しない。ガスの BNB は要らない（EIP-3009 は facilitator が出す）。残高は USD1 だけ読む。
//
// scoring の CHAINS 登録簿（./chains.ts）には載せない（Celo と同じ理由: あれは ERC-8004 の読み取りと
// `?chain=` の公開面を有効にする表。BNB で要るのは USD1 の残高・Transfer ログ・レシートの 3 つだけ）。
// ============================================================
import { createPublicClient, http } from "viem";
import { bsc } from "viem/chains";
import type { base } from "viem/chains";

export const BNB_CHAIN_ID = 56;
export const BNB_CAIP2 = "eip155:56";
export const BNB_USD1_ADDRESS = "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d" as const;
/** USD1 の小数桁。台帳（x402_l1_purchases）は 6 桁。倍率は x402-payer の BNB_LEDGER_SCALE（10^12）。 */
export const BNB_USD1_DECIMALS = 18;

/**
 * 公開 RPC。BNB_RPC_URL が未設定のときの既定（Celo の CELO_PUBLIC_RPC_URL と同じ扱い）。
 * これに倒れてよいのは**購入元の USD1 残高読みだけ**——読めなければ署名しない側へ倒れるので、
 * 公開 RPC の不調は「買わない」にしかならない。決済の再読（settlement-verify）は BNB_VERIFY_RPC_URL も
 * BNB_RPC_URL も無ければ動かない（この既定へ黙って倒れて「確認済み」を刻まない。下の bnbVerifyRpcUrl）。
 */
export const BNB_PUBLIC_RPC_URL = "https://bsc-dataseed.bnbchain.org";

export function bnbRpcUrl(): string {
  const fromEnv = process.env.BNB_RPC_URL?.trim();
  return fromEnv ? fromEnv : BNB_PUBLIC_RPC_URL;
}

/**
 * BNB Chain の読み取りクライアント。型は Base のクライアントに合わせる（chain/celo.ts と同じ理由——
 * 呼び手は chain 非依存の read 面しか使わない）。
 *  - live: 残高や照合の 1 回読み（短いタイムアウト・1 リトライ）
 *  - batch: 残高以外の長い読み。決済索引（index-evm）はこの関数を使わず、BNB_RPC_URL が無いときは公開 RPC へ倒れない。
 */
export function getBnbPublicClient(mode: "live" | "batch" = "live") {
  return createPublicClient({
    chain: bsc as unknown as typeof base,
    transport: http(bnbRpcUrl(), mode === "batch" ? { timeout: 20_000, retryCount: 3 } : { timeout: 5_000, retryCount: 1 }),
  });
}

/**
 * 決済の再読（settlement-verify）の RPC（2026-10-20）。BNB_VERIFY_RPC_URL があればそれ、無ければ BNB_RPC_URL。
 * どちらも無ければ null（公開 RPC へ黙って倒れて「確認済み」を刻まない。上の BNB_PUBLIC_RPC_URL の注記と同じ）。
 * 実測 2026-10-19/20: BNB_RPC_URL（PublicNode）は直近 1〜2 時間より前のレシートを
 * "Archive requests require a personal token" で断る。照合は 1 日 1 回（14:00 UTC）なので、BNB の settle_claimed は
 * 毎回 rpc_unavailable で素通りしていた（10/19 の 13 行）。本番の BNB_VERIFY_RPC_URL は BNB Chain の公開 dataseed
 * （BNB_PUBLIC_RPC_URL と同じ）。実測 2026-10-20: 約 2〜8・15・40・90 日前の実在の tx のレシートを返し、117 回続けて読んで
 * エラー 0。1rpc.io/bnb は約 4 日より古い実在の tx に null（＝tx_not_found）を返し、続けて読むと 429 が出たので使わない。
 * dataseed の eth_getLogs は "limit exceeded" で断るので、索引と遅延回収には使わない（BNB_RPC_URL のまま）。
 */
export function bnbVerifyRpcUrl(): string | null {
  const verify = process.env.BNB_VERIFY_RPC_URL?.trim();
  if (verify) return verify;
  const rpc = process.env.BNB_RPC_URL?.trim();
  return rpc ? rpc : null;
}

/** 照合の 1 回読み（live と同じ短いタイムアウト・1 リトライ）。bnbVerifyRpcUrl が null なら null。 */
export function getBnbVerifyClient() {
  const url = bnbVerifyRpcUrl();
  if (!url) return null;
  return createPublicClient({
    chain: bsc as unknown as typeof base,
    transport: http(url, { timeout: 5_000, retryCount: 1 }),
  });
}
