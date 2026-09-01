// §7.2 Solana: トークン残高差分から USDC 受取を取る（純関数）
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractUsdcTransfer } from "@/lib/settlements/index-solana";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAYEE = "PayeeOwner11111111111111111111111111111111";
const PAYER = "PayerOwner11111111111111111111111111111111";
const bal = (accountIndex: number, owner: string, amount: string, mint = MINT) => ({ accountIndex, mint, owner, uiTokenAmount: { amount } });

test("payee の USDC 残高が増え、別 owner が減っていれば (amount, payer)", () => {
  const r = extractUsdcTransfer([bal(1, PAYER, "5000"), bal(2, PAYEE, "0")], [bal(1, PAYER, "2000"), bal(2, PAYEE, "3000")], PAYEE, MINT);
  assert.deepEqual(r, { amount: "3000", payer: PAYER });
});
test("payee の残高が増えていなければ null", () => {
  assert.equal(extractUsdcTransfer([bal(2, PAYEE, "10")], [bal(2, PAYEE, "10")], PAYEE, MINT), null);
});
test("別 mint の増減は無視する", () => {
  assert.equal(extractUsdcTransfer([bal(2, PAYEE, "0", "OtherMint")], [bal(2, PAYEE, "999", "OtherMint")], PAYEE, MINT), null);
});
test("pre に無い口座（新規 ATA）は 0 からの増分として数える", () => {
  const r = extractUsdcTransfer([bal(1, PAYER, "10")], [bal(1, PAYER, "4"), bal(2, PAYEE, "6")], PAYEE, MINT);
  assert.deepEqual(r, { amount: "6", payer: PAYER });
});
test("支払元が読めなければ payer は null（受取は記録する）", () => {
  const r = extractUsdcTransfer([], [bal(2, PAYEE, "7")], PAYEE, MINT);
  assert.deepEqual(r, { amount: "7", payer: null });
});
