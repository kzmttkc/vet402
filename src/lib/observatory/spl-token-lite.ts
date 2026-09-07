// ============================================================
// The two SPL Token helpers sol402-payer.ts uses, implemented on @solana/web3.js
// alone (2026-09-07 repo hygiene).
//
// Why not `@solana/spl-token`: its runtime dependency `@solana/buffer-layout-utils`
// pulls `bigint-buffer`, which has an unpatched high-severity advisory
// (GHSA-3gc7-fjrx-p6mg) in every published version, so `npm audit --omit=dev`
// stayed red on a library we use for exactly two pure functions. The library is
// kept as a devDependency and tests/spl-token-lite.test.ts asserts byte-for-byte
// parity against it (ATA derivation and the TransferChecked instruction), so a
// drift here fails the suite rather than a payment.
//
// Sources of truth: SPL Token program `TransferChecked` = instruction index 12,
// data = u8 tag ‖ u64 LE amount ‖ u8 decimals; the associated token account is
// PDA(owner ‖ token_program ‖ mint) under the Associated Token program.
// ============================================================
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

/** SPL Token program (not Token-2022; USDC on Solana mainnet is a classic SPL mint). */
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);

/** Same name and meaning as the library's error: an off-curve owner (a PDA) has no ATA unless allowed explicitly. */
export class TokenOwnerOffCurveError extends Error {
  name = "TokenOwnerOffCurveError";
}

/** Associated token account of `owner` for `mint` (same result as `@solana/spl-token`). */
export function getAssociatedTokenAddressSync(
  mint: PublicKey,
  owner: PublicKey,
  allowOwnerOffCurve = false,
  programId: PublicKey = TOKEN_PROGRAM_ID,
  associatedTokenProgramId: PublicKey = ASSOCIATED_TOKEN_PROGRAM_ID,
): PublicKey {
  if (!allowOwnerOffCurve && !PublicKey.isOnCurve(owner.toBuffer())) {
    throw new TokenOwnerOffCurveError();
  }
  const [address] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), programId.toBuffer(), mint.toBuffer()],
    associatedTokenProgramId,
  );
  return address;
}

const TRANSFER_CHECKED_INSTRUCTION = 12;

/**
 * `TransferChecked(amount, decimals)` with a single signing owner (no multisig —
 * the payer wallet is a plain keypair). Account order and flags are the program's:
 * source (writable), mint, destination (writable), owner (signer).
 */
export function createTransferCheckedInstruction(
  source: PublicKey,
  mint: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: number | bigint,
  decimals: number,
  programId: PublicKey = TOKEN_PROGRAM_ID,
): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(TRANSFER_CHECKED_INSTRUCTION, 0);
  data.writeBigUInt64LE(BigInt(amount), 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}
