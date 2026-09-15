// ============================================================
// dist/spl-token-lite.js と `@solana/spl-token`（devDependency・正解の役）のバイト一致。
// 本番 `tests/spl-token-lite.test.ts` と同じ検査を SDK の移植に当てる。移植は Buffer を使わず
// DataView で書いたので、範囲外の扱い（DataView は黙って丸める）もここで固定する。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import * as web3 from "@solana/web3.js";
import * as lib from "@solana/spl-token";
import { createSplTokenLite, encodeTransferCheckedData } from "../dist/spl-token-lite.js";

const { Keypair, PublicKey } = web3;
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const lite = createSplTokenLite(web3);

test("program ids match the library", () => {
  assert.equal(lite.TOKEN_PROGRAM_ID.toBase58(), lib.TOKEN_PROGRAM_ID.toBase58());
  assert.equal(lite.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(), lib.ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
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
  const amounts = [0n, 1n, 10_000n, 1_000_000n, 2n ** 53n + 1n, 2n ** 64n - 1n, 42];
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
    assert.deepEqual([...a.data], [...b.data], `data for amount ${amount}`);
  }
});

test("the lite instruction serializes inside a v0 message to the same bytes as the library's", () => {
  const mint = new PublicKey(SOLANA_USDC_MINT);
  const owner = Keypair.generate().publicKey;
  const source = lib.getAssociatedTokenAddressSync(mint, owner);
  const dest = lib.getAssociatedTokenAddressSync(mint, Keypair.generate().publicKey);
  const feePayer = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const compile = (ix) => new web3.TransactionMessage({ payerKey: feePayer, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message().serialize();
  assert.deepEqual(
    [...compile(lite.createTransferCheckedInstruction(source, mint, dest, owner, 20_000n, 6))],
    [...compile(lib.createTransferCheckedInstruction(source, mint, dest, owner, 20_000n, 6))],
  );
});

test("amounts outside u64 and decimals outside u8 are rejected (DataView would wrap them silently)", () => {
  const mint = new PublicKey(SOLANA_USDC_MINT);
  const owner = Keypair.generate().publicKey;
  const ata = lib.getAssociatedTokenAddressSync(mint, owner);
  assert.throws(() => lite.createTransferCheckedInstruction(ata, mint, ata, owner, 2n ** 64n, 6));
  assert.throws(() => lite.createTransferCheckedInstruction(ata, mint, ata, owner, -1n, 6));
  assert.throws(() => encodeTransferCheckedData(1n, 256));
  assert.throws(() => encodeTransferCheckedData(1n, -1));
  assert.throws(() => encodeTransferCheckedData(1n, 1.5));
});
