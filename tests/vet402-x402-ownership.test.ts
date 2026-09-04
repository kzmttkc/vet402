// ============================================================
// vet402 2026-08-13 — proof of control for an x402 write-back.
//
// The defect (HIGH-1, measured in production): POST /v1/payments/x402 took
// `wallet` as a bare claim in the request body. It confirmed the tx was real
// and originated from `wallet`, but never that the POSTER controls `wallet`.
// So any API key could take a STRANGER's real Base transfer — a known-scam
// wallet's, even — and post it as that stranger's settlement history, moving a
// third party's score. The fix is the same proof-of-control gate verified
// payees use: a valid EIP-191 signature by `wallet` over a tx-specific message.
//
// These test the pure signing/verification surface with a real key, so the
// crypto is exercised, not mocked.
//
// Run: npm test
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import {
  legacyX402AttestationMessage,
  x402AttestationMessage,
  verifyX402Ownership,
} from "@/lib/chain/x402-verify";

// A throwaway key — fixed so the test is deterministic. NOT a real wallet.
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(PK);
const WALLET = account.address;
const OTHER = "0x1111111111111111111111111111111111111111";
const TX = "0x" + "ab".repeat(32);
const OTHER_TX = "0x" + "cd".repeat(32);

// ---- the canonical message -------------------------------------------------

// 2026-09-05 (S-6/E-b): 4 行 → 6 行。1 行目の名乗りを `vet402.com — …` へ、
// 2 行目に `domain:`、末尾に「この署名が何を起こすか（公開スコアに算入）」と
// 「資金は動かない」を足した。可変値は wallet / tx の 2 行のまま。
test("the attestation message is a fixed 6 lines binding wallet and tx, lowercased", () => {
  const msg = x402AttestationMessage(WALLET, TX);
  const lines = msg.split("\n");
  assert.equal(lines.length, 6);
  assert.equal(lines[0], "vet402.com — x402 settlement attestation");
  assert.equal(lines[1], "domain: vet402.com");
  assert.equal(lines[2], `wallet: ${WALLET.toLowerCase()}`);
  assert.equal(lines[3], `tx: ${TX.toLowerCase()}`);
  // case-insensitive inputs produce the identical signed text
  assert.equal(x402AttestationMessage(WALLET.toUpperCase().replace("0X", "0x"), TX.toUpperCase().replace("0X", "0x")), msg);
});

// ---- verification ----------------------------------------------------------

test("a valid signature by the wallet proves ownership", async () => {
  const signature = await account.signMessage({ message: x402AttestationMessage(WALLET, TX) });
  assert.deepEqual(await verifyX402Ownership(WALLET, TX, signature), {
    verified: true,
    legacy: false,
    legacyExpired: false,
  });
});

test("no signature is not ownership (recorded, never scored)", async () => {
  for (const sig of [undefined, null, ""]) {
    assert.equal((await verifyX402Ownership(WALLET, TX, sig)).verified, false);
  }
});

test("a signature over a DIFFERENT tx does not authorize this write-back (no replay)", async () => {
  const forOtherTx = await account.signMessage({ message: x402AttestationMessage(WALLET, OTHER_TX) });
  assert.equal((await verifyX402Ownership(WALLET, TX, forOtherTx)).verified, false);
  // …and it still verifies for the tx it was actually signed for.
  assert.equal((await verifyX402Ownership(WALLET, OTHER_TX, forOtherTx)).verified, true);
});

test("a valid signature by the wallet cannot vouch for a DIFFERENT wallet", async () => {
  // The core HIGH-1 case: I control WALLET and sign for it, but claim OTHER.
  const signature = await account.signMessage({ message: x402AttestationMessage(WALLET, TX) });
  assert.equal((await verifyX402Ownership(OTHER, TX, signature)).verified, false);
});

test("garbage in the signature field is false, never a throw", async () => {
  assert.equal((await verifyX402Ownership(WALLET, TX, "0xnot-a-signature")).verified, false);
  assert.equal((await verifyX402Ownership(WALLET, TX, "definitely not hex")).verified, false);
});

// ---- 旧本文の互換窓 (2026-09-05 S-6) ---------------------------------------
//
// 書き戻しは SDK の外でも組める公開の契約なので、本文の差し替えを無告知の
// 破壊にしない。旧本文の署名は LEGACY_MESSAGE_ACCEPT_UNTIL まで所有証明と
// して通し、`legacy` で立つ——「まだ旧形式で署名している相手がいるか」を
// 推測ではなく実測で見るため。期限後は所有証明にならない（行は記録され、
// スコアには入らない）。

test("旧本文の署名は期限内は所有証明として通り、legacy が立つ", async () => {
  const signature = await account.signMessage({ message: legacyX402AttestationMessage(WALLET, TX) });
  assert.deepEqual(await verifyX402Ownership(WALLET, TX, signature, Date.parse("2026-09-20T23:59:59Z")), {
    verified: true,
    legacy: true,
    legacyExpired: false,
  });
});

test("旧本文の署名は期限後は所有証明にならない（legacyExpired で名指しする）", async () => {
  const signature = await account.signMessage({ message: legacyX402AttestationMessage(WALLET, TX) });
  assert.deepEqual(await verifyX402Ownership(WALLET, TX, signature, Date.parse("2026-09-21T00:00:00Z")), {
    verified: false,
    legacy: false,
    legacyExpired: true,
  });
});
