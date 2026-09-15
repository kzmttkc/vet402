/**
 * Which signer `pay_if_trusted` may use, decided by the shape of the payee (2026-09-15).
 * (English header for judges. The Japanese block below is the same content.)
 *
 * A 0x payee is paid on Base with the EIP-3009 signer built from `VOUCH_PAYER_PRIVATE_KEY` (viem).
 * A base58 payee is paid on Solana with the signer built here from `VOUCH_SOLANA_PAYER_SECRET_KEY`
 * and `SOLANA_RPC_URL` (@solana/web3.js). Neither library is a dependency of this package: an MCP
 * server that can hold a private key is something the operator opts into. When the signer for the
 * payee's rail is missing, `index.ts` withholds the payment target and the tool refuses with
 * `payer_not_configured` — a Solana payee is never paid by the EVM signer, or the reverse.
 */
/**
 * `pay_if_trusted` がどの署名者を使えるか。**payee の形で決まる**（2026-09-15）。
 *
 * 0x の payee は Base で、`VOUCH_PAYER_PRIVATE_KEY`（viem）の EIP-3009 署名者が払う。
 * base58 の payee は Solana で、ここで `VOUCH_SOLANA_PAYER_SECRET_KEY` と `SOLANA_RPC_URL`（@solana/web3.js）
 * から作る署名者が払う。どちらのライブラリもこのパッケージの依存ではない。payee のレールの署名者が
 * 無ければ `index.ts` が支払い先を渡さず、ツールは `payer_not_configured` で拒否する。
 */
import { type PayIfTrustedSvmSigner } from "./pay-if-trusted.js";
/** 触れられたら throw する Solana の署名者。未設定のとき payIfTrusted へ渡す値で、到達しない（EVM の UNCONFIGURED_SIGNER と同じ役）。 */
export declare const UNCONFIGURED_SVM_SIGNER: PayIfTrustedSvmSigner;
/**
 * この payee に払える署名者が設定されているか。**署名者の中身には触らない**（null かどうかだけ）。
 * payee が無い（支払い先を渡していない）呼び出しは従来どおり EVM の署名者で見る。
 */
export declare function payerConfiguredFor(payee: unknown, evmSigner: unknown, svmSigner: unknown): boolean;
/**
 * Solana の署名者を作る。鍵は `solana-keygen` の JSON 配列か base64（本番 L1 の `loadSolanaKeypair` と同じ 2 形）。
 * 鍵・RPC・web3.js のどれかが欠ければ null（fail-closed）。**鍵の値は例外にもログにも出さない。**
 */
export declare function resolveSvmPayer(secretKey: string | undefined, rpcUrl: string | undefined): Promise<{
    signer: PayIfTrustedSvmSigner;
    rpcUrl: string;
} | null>;
