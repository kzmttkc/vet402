/**
 * The two SPL Token helpers `svm-pay.ts` needs, on `@solana/web3.js` alone. Ported from the
 * production file `src/lib/observatory/spl-token-lite.ts` (the Solana L1 payer has settled real
 * purchases on it). (English header for judges. The Japanese block below is the same content.)
 *
 * Two differences from production, both for the SDK's reach:
 *   - `@solana/web3.js` is **not imported**. The caller passes the module in
 *     ({@link createSplTokenLite}). The SDK loads web3.js with a dynamic import inside the ALLOW
 *     branch only, so an EVM user who never installed it is never asked to.
 *   - No `Buffer`. Instruction data is a `Uint8Array` written through `DataView`, so the same code
 *     runs in a browser or an edge runtime. `DataView.setBigUint64` wraps silently where
 *     `Buffer.writeBigUInt64LE` throws, so the u64 and u8 ranges are checked explicitly.
 *
 * Parity with `@solana/spl-token` (the oracle, a devDependency only) is asserted byte for byte in
 * `test/spl-token-lite.test.mjs`, the same checks production runs in `tests/spl-token-lite.test.ts`.
 * Sources of truth: SPL Token `TransferChecked` = instruction 12, data = u8 tag ‖ u64 LE amount ‖
 * u8 decimals; the associated token account is PDA(owner ‖ token_program ‖ mint) under the
 * Associated Token program.
 */
/**
 * `svm-pay.ts` が使う SPL Token の 2 関数を、`@solana/web3.js` だけで書いたもの。
 * 本番 `src/lib/observatory/spl-token-lite.ts` の移植（本番の Solana L1 はこの実装で実決済している）。
 *
 * 本番との違いは 2 つで、どちらも SDK の届く範囲のため:
 *   - `@solana/web3.js` を **import しない**。呼び手がモジュールを渡す（{@link createSplTokenLite}）。
 *     SDK は web3.js を ALLOW ブランチ内の動的 import でしか読まないので、EVM だけの利用者に
 *     インストールを求めない
 *   - `Buffer` を使わない。命令データは `DataView` で書いた `Uint8Array`。`DataView.setBigUint64` は
 *     範囲外を黙って丸める（`Buffer.writeBigUInt64LE` は throw する）ので、u64 と u8 の範囲を明示的に検査する
 *
 * `@solana/spl-token`（devDependency のみ・正解の役）とのバイト一致は `test/spl-token-lite.test.mjs` が見る。
 */
import type * as Web3 from "@solana/web3.js";
export type SolanaWeb3 = typeof Web3;
/** SPL Token program (not Token-2022; USDC on Solana mainnet is a classic SPL mint). */
export declare const TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export declare const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/** Same name and meaning as the library's error: an off-curve owner (a PDA) has no ATA unless allowed explicitly. */
export declare class TokenOwnerOffCurveError extends Error {
    name: string;
}
export type SplTokenLite = {
    TOKEN_PROGRAM_ID: Web3.PublicKey;
    ASSOCIATED_TOKEN_PROGRAM_ID: Web3.PublicKey;
    getAssociatedTokenAddressSync(mint: Web3.PublicKey, owner: Web3.PublicKey, allowOwnerOffCurve?: boolean, programId?: Web3.PublicKey, associatedTokenProgramId?: Web3.PublicKey): Web3.PublicKey;
    createTransferCheckedInstruction(source: Web3.PublicKey, mint: Web3.PublicKey, destination: Web3.PublicKey, owner: Web3.PublicKey, amount: number | bigint, decimals: number, programId?: Web3.PublicKey): Web3.TransactionInstruction;
};
/** `TransferChecked` の data（10 バイト）。範囲外は throw——黙って丸めた額に署名しない。 */
export declare function encodeTransferCheckedData(amount: number | bigint, decimals: number): Uint8Array;
/** web3.js のモジュールを受け取り、本番と同じ 2 関数を返す。 */
export declare function createSplTokenLite(web3: SolanaWeb3): SplTokenLite;
