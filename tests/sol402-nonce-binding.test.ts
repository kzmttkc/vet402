// ============================================================
// 2026-09-04 金の経路監査 P1-1 の Solana 側。
//
// EVM は EIP-3009 の nonce が「その tx はこの購入のもの」を証明する。Solana に
// 相当するのは memo だが、それまでの実装は `extra.memo` があれば**売り手の値**を
// そのまま使っていた。売り手は同じ payTo・同じ価格の購入すべてに同じ memo を
// 指定すればよく、1 本の決済 tx を全部のレシートに使い回せた。
//
// もう 1 つ: extra.feePayer が payer / payTo と同じ accept は、ファシリテータが
// 居ない（= 我々自身か受取人が手数料を払う形）という別物で、v0 の前提
// （我々は SOL を持たない・feePayer は第三者）を満たさない。署名も送信も
// させずに no_fee_payer で退く。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import {
  buildSolanaPaymentTransaction,
  selectSolanaAccept,
  SOLANA_MAINNET_CAIP2,
  SOLANA_USDC_MINT,
} from "@/lib/observatory/sol402-payer";
import type { ChallengeAccept } from "@/lib/observatory/x402-payer";

const PAYER = Keypair.generate();
const PAY_TO = "GqSs5L9aPWGJwyRQe35YKQaWMDPh3R1dMqfSEPhSgkM";
const FEE_PAYER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";

const accept = (over: Partial<ChallengeAccept> = {}): ChallengeAccept => ({
  scheme: "exact",
  network: SOLANA_MAINNET_CAIP2,
  amount: "1000",
  asset: SOLANA_USDC_MINT,
  payTo: PAY_TO,
  extra: { feePayer: FEE_PAYER },
  ...over,
});

const opts = { declaredAmount: "1000", declaredPayTo: PAY_TO, payerAddress: PAYER.publicKey.toBase58() };

test("memo は売り手の extra.memo ではなく、常に我々の乱数", async () => {
  const seller = "seller-controlled-memo";
  const built = await buildSolanaPaymentTransaction({
    accept: accept({ extra: { feePayer: FEE_PAYER, memo: seller } }),
    payer: PAYER,
    recentBlockhash: "11111111111111111111111111111111",
  });
  assert.notEqual(built.memo, seller, "売り手の memo をそのまま使っている");
  assert.match(built.memo, /^[0-9a-f]{32}$/, "16 バイトの乱数 hex でない");
  assert.ok(
    !Buffer.from(built.transactionB64, "base64").toString("utf8").includes(seller),
    "tx の中に売り手の memo が残っている",
  );
});

test("memo は購入ごとに異なる（使い回せない）", async () => {
  const build = () =>
    buildSolanaPaymentTransaction({
      accept: accept(),
      payer: PAYER,
      recentBlockhash: "11111111111111111111111111111111",
    });
  const [a, b] = await Promise.all([build(), build()]);
  assert.notEqual(a.memo, b.memo);
});

test("feePayer が我々の payer と同じ accept は no_fee_payer", () => {
  const r = selectSolanaAccept([accept({ extra: { feePayer: opts.payerAddress } })], opts);
  assert.equal(r.accept, null);
  assert.equal(r.reason, "no_fee_payer");
});

test("feePayer が payTo と同じ accept は no_fee_payer", () => {
  const r = selectSolanaAccept([accept({ extra: { feePayer: PAY_TO } })], opts);
  assert.equal(r.accept, null);
  assert.equal(r.reason, "no_fee_payer");
});

test("第三者の feePayer は従来どおり通る", () => {
  const r = selectSolanaAccept([accept()], opts);
  assert.equal(r.reason, null);
  assert.equal(r.accept?.payTo, PAY_TO);
});
