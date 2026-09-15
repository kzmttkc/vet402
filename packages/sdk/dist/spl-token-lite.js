/** SPL Token program (not Token-2022; USDC on Solana mainnet is a classic SPL mint). */
export const TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TRANSFER_CHECKED_INSTRUCTION = 12;
const U64_MAX = (1n << 64n) - 1n;
/** Same name and meaning as the library's error: an off-curve owner (a PDA) has no ATA unless allowed explicitly. */
export class TokenOwnerOffCurveError extends Error {
    name = "TokenOwnerOffCurveError";
}
/** `TransferChecked` の data（10 バイト）。範囲外は throw——黙って丸めた額に署名しない。 */
export function encodeTransferCheckedData(amount, decimals) {
    const units = BigInt(amount);
    if (units < 0n || units > U64_MAX) {
        throw new RangeError(`spl-token-lite: amount ${units} is outside u64`);
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
        throw new RangeError(`spl-token-lite: decimals ${decimals} is outside u8`);
    }
    const data = new Uint8Array(10);
    const view = new DataView(data.buffer);
    view.setUint8(0, TRANSFER_CHECKED_INSTRUCTION);
    view.setBigUint64(1, units, true);
    view.setUint8(9, decimals);
    return data;
}
/** web3.js のモジュールを受け取り、本番と同じ 2 関数を返す。 */
export function createSplTokenLite(web3) {
    const TOKEN_PROGRAM_ID = new web3.PublicKey(TOKEN_PROGRAM_ADDRESS);
    const ASSOCIATED_TOKEN_PROGRAM_ID = new web3.PublicKey(ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
    return {
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve = false, programId = TOKEN_PROGRAM_ID, associatedTokenProgramId = ASSOCIATED_TOKEN_PROGRAM_ID) {
            if (!allowOwnerOffCurve && !web3.PublicKey.isOnCurve(owner.toBytes())) {
                throw new TokenOwnerOffCurveError();
            }
            const [address] = web3.PublicKey.findProgramAddressSync([owner.toBytes(), programId.toBytes(), mint.toBytes()], associatedTokenProgramId);
            return address;
        },
        /**
         * `TransferChecked(amount, decimals)` with a single signing owner (no multisig). Account order and
         * flags are the program's: source (writable), mint, destination (writable), owner (signer).
         */
        createTransferCheckedInstruction(source, mint, destination, owner, amount, decimals, programId = TOKEN_PROGRAM_ID) {
            return new web3.TransactionInstruction({
                programId,
                keys: [
                    { pubkey: source, isSigner: false, isWritable: true },
                    { pubkey: mint, isSigner: false, isWritable: false },
                    { pubkey: destination, isSigner: false, isWritable: true },
                    { pubkey: owner, isSigner: true, isWritable: false },
                ],
                // web3.js の型は Buffer だが、直列化は Uint8Array をそのまま受ける（@solana/buffer-layout の
                // Blob.encode は `instanceof Uint8Array` を見る）。バイト一致はテストがライブラリと突き合わせる。
                data: encodeTransferCheckedData(amount, decimals),
            });
        },
    };
}
