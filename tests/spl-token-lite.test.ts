// ============================================================
// Parity of src/lib/observatory/spl-token-lite.ts with `@solana/spl-token`
// (devDependency, the oracle). The lite module exists only so the production
// dependency tree carries no `bigint-buffer` (GHSA-3gc7-fjrx-p6mg); it must
// produce the same bytes the library does, or a Solana payment would be built
// on a different instruction than the one the spec tests were written against.
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import * as lib from "@solana/spl-token";
import * as lite from "@/lib/observatory/spl-token-lite";
import { SOLANA_USDC_MINT } from "@/lib/observatory/sol402-payer";

test("program ids match the library", () => {
  assert.equal(lite.TOKEN_PROGRAM_ID.toBase58(), lib.TOKEN_PROGRAM_ID.toBase58());
  assert.equal(
    lite.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    lib.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  );
});

test("getAssociatedTokenAddressSync: same ATA as the library for 32 random owners", () => {
  const mint = new PublicKey(SOLANA_USDC_MINT);
  for (let i = 0; i < 32; i++) {
    const owner = Keypair.generate().publicKey;
    assert.equal(
      lite.getAssociatedTokenAddressSync(mint, owner).toBase58(),
      lib.getAssociatedTokenAddressSync(mint, owner).toBase58(),
      owner.toBase58(),
    );
  }
});

test("getAssociatedTokenAddressSync: off-curve owner throws like the library, unless allowed", () => {
  const mint = new PublicKey(SOLANA_USDC_MINT);
  // An ATA is itself a PDA, hence off-curve.
  const pda = lib.getAssociatedTokenAddressSync(mint, Keypair.generate().publicKey);
  assert.throws(() => lite.getAssociatedTokenAddressSync(mint, pda), { name: "TokenOwnerOffCurveError" });
  assert.throws(() => lib.getAssociatedTokenAddressSync(mint, pda), { name: "TokenOwnerOffCurveError" });
  assert.equal(
    lite.getAssociatedTokenAddressSync(mint, pda, true).toBase58(),
    lib.getAssociatedTokenAddressSync(mint, pda, true).toBase58(),
  );
});

test("createTransferCheckedInstruction: identical keys, flags, program and data bytes", () => {
  const mint = new PublicKey(SOLANA_USDC_MINT);
  const amounts: (bigint | number)[] = [0n, 1n, 10_000n, 1_000_000n, 2n ** 53n + 1n, 2n ** 64n - 1n, 42];
  for (const amount of amounts) {
    const owner = Keypair.generate().publicKey;
    const payTo = Keypair.generate().publicKey;
    const source = lib.getAssociatedTokenAddressSync(mint, owner);
    const dest = lib.getAssociatedTokenAddressSync(mint, payTo);
    const a = lite.createTransferCheckedInstruction(source, mint, dest, owner, amount, 6);
    const b = lib.createTransferCheckedInstruction(source, mint, dest, owner, amount, 6);
    assert.equal(a.programId.toBase58(), b.programId.toBase58());
    assert.deepEqual(
      a.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
      b.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]),
      `keys for amount ${amount}`,
    );
    assert.deepEqual(Buffer.from(a.data), Buffer.from(b.data), `data for amount ${amount}`);
  }
});

test("amounts outside u64 are rejected (the library rejects them too)", () => {
  const mint = new PublicKey(SOLANA_USDC_MINT);
  const owner = Keypair.generate().publicKey;
  const ata = lib.getAssociatedTokenAddressSync(mint, owner);
  assert.throws(() => lite.createTransferCheckedInstruction(ata, mint, ata, owner, 2n ** 64n, 6));
  assert.throws(() => lite.createTransferCheckedInstruction(ata, mint, ata, owner, -1n, 6));
});
