// ============================================================
// vet402 Observatory — SOL-402 payer (Phase 1.2).
//
// 対象は「作る側」の正しさ: coinbase/x402 specs/schemes/exact/scheme_exact_svm.md
// の MUST 制約を、生成したトランザクションを逆デシリアライズして機械検証する。
//  - 命令列: ComputeBudget SetLimit(2) → SetPrice(3, ≤5/CU) → TransferChecked → Memo
//  - feePayer はどの命令の accounts にも現れない（スポンサーの資金を動かせない）
//  - 宛先は ATA(owner = payTo, mint = asset)・金額一致
//  - 署名はクライアント分のみ（feePayer 枠は未署名のまま）
// accept 選択は EVM 側 selectAccept と同じ拒否理由の語彙で、feePayer 不在という
// Solana 固有の skip を足す（SOL残高を持たない運用が v0 の前提）。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  SOLANA_MAINNET_CAIP2,
  SOLANA_USDC_MINT,
  selectSolanaAccept,
  buildSolanaPaymentTransaction,
  encodeSolanaPaymentHeader,
} from "@/lib/observatory/sol402-payer";

const FEE_PAYER = "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd";
const PAY_TO = "GqSs5L9aPWGJwyRQe35YKQaWMDPh3R1dMqfSEPhSgkM";
// 決定的なテスト鍵（本物の資金とは無関係）。
const KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(7));
const BLOCKHASH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";

function accept(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: SOLANA_MAINNET_CAIP2,
    amount: "10000",
    asset: SOLANA_USDC_MINT,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { feePayer: FEE_PAYER },
    ...overrides,
  };
}

test("selectSolanaAccept: eligible accept passes; wrong mint / wrong network / no feePayer are refused", () => {
  const ok = selectSolanaAccept([accept()], { declaredAmount: "10000", declaredPayTo: PAY_TO });
  assert.equal(ok.reason, null);
  assert.equal(ok.accept?.payTo, PAY_TO);

  const wrongMint = selectSolanaAccept([accept({ asset: "So11111111111111111111111111111111111111112" })], {
    declaredAmount: "10000",
    declaredPayTo: PAY_TO,
  });
  assert.equal(wrongMint.reason, "no_eligible_accept");

  const evm = selectSolanaAccept([accept({ network: "eip155:8453" })], {
    declaredAmount: "10000",
    declaredPayTo: PAY_TO,
  });
  assert.equal(evm.reason, "no_eligible_accept");

  const noSponsor = selectSolanaAccept([accept({ extra: {} })], {
    declaredAmount: "10000",
    declaredPayTo: PAY_TO,
  });
  assert.equal(noSponsor.reason, "no_fee_payer");
});

test("selectSolanaAccept: legacy lowercased catalog payTo still matches (case-insensitive compare), wall price mismatch refused", () => {
  const legacy = selectSolanaAccept([accept()], {
    declaredAmount: "10000",
    declaredPayTo: PAY_TO.toLowerCase(),
  });
  assert.equal(legacy.reason, null);

  const overcharge = selectSolanaAccept([accept({ amount: "999999" })], {
    declaredAmount: "10000",
    declaredPayTo: PAY_TO,
  });
  assert.equal(overcharge.reason, "price_mismatch");
});

test("selectSolanaAccept: 壁がカタログと違う受取先を要求 → payto_mismatch（EVM と同じ語彙）", () => {
  // 2026-08-22: 以前は no_eligible_accept に潰れていた。受取先の差し替えは
  // 「支払えない壁」ではなく売り手についての所見なので、名前を分ける。
  const other = selectSolanaAccept([accept()], {
    declaredAmount: "10000",
    declaredPayTo: "11111111111111111111111111111111",
  });
  assert.equal(other.reason, "payto_mismatch");
});

test("buildSolanaPaymentTransaction: spec MUST constraints hold on the deserialized tx", async () => {
  const sel = selectSolanaAccept([accept()], { declaredAmount: "10000", declaredPayTo: PAY_TO });
  assert.equal(sel.reason, null);
  const built = await buildSolanaPaymentTransaction({
    accept: sel.accept!,
    payer: KEYPAIR,
    recentBlockhash: BLOCKHASH,
  });

  const tx = VersionedTransaction.deserialize(Buffer.from(built.transactionB64, "base64"));
  const msg = tx.message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());

  // fee payer is account 0 and signs later — its signature slot must be empty now.
  assert.equal(keys[0], FEE_PAYER);
  assert.ok(tx.signatures[0].every((b) => b === 0), "feePayer slot unsigned");
  const payerIndex = keys.indexOf(KEYPAIR.publicKey.toBase58());
  assert.ok(payerIndex >= 0 && payerIndex < msg.header.numRequiredSignatures);
  assert.ok(tx.signatures[payerIndex].some((b) => b !== 0), "client signature present");

  const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
  const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const MEMO = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
  const ix = msg.compiledInstructions;
  assert.equal(ix.length, 4);
  assert.equal(keys[ix[0].programIdIndex], COMPUTE_BUDGET);
  assert.equal(ix[0].data[0], 2, "SetComputeUnitLimit discriminator");
  assert.equal(keys[ix[1].programIdIndex], COMPUTE_BUDGET);
  assert.equal(ix[1].data[0], 3, "SetComputeUnitPrice discriminator");
  const price = Buffer.from(ix[1].data.slice(1, 9)).readBigUInt64LE();
  assert.ok(price <= 5n, `compute unit price ${price} ≤ 5`);

  assert.equal(keys[ix[2].programIdIndex], TOKEN);
  assert.equal(ix[2].data[0], 12, "TransferChecked discriminator");
  assert.equal(Buffer.from(ix[2].data.slice(1, 9)).readBigUInt64LE(), 10000n);
  const destAta = getAssociatedTokenAddressSync(
    new PublicKey(SOLANA_USDC_MINT),
    new PublicKey(PAY_TO),
  ).toBase58();
  const ixAccounts = ix[2].accountKeyIndexes.map((i) => keys[i]);
  assert.ok(ixAccounts.includes(destAta), "destination is ATA(payTo, mint)");

  assert.equal(keys[ix[3].programIdIndex], MEMO);
  assert.ok(ix[3].data.length >= 16, "random nonce memo ≥16 bytes");

  // fee payer never appears inside any instruction's accounts.
  for (const inst of ix) {
    for (const ai of inst.accountKeyIndexes) {
      assert.notEqual(keys[ai], FEE_PAYER, "feePayer must not appear in instruction accounts");
    }
  }
});

// 2026-09-04 監査 P1-1 で反転した不変条件。
//
// 以前は「extra.memo があればその値をそのまま使う」（x402 SVM spec の
// クライアント任意項目）だった。だが memo は Solana 側で**その tx がこの購入の
// ものだと言える唯一の材料**で、売り手に選ばせると、同じ payTo・同じ価格の
// 購入すべてに同じ memo を指定して 1 本の決済 tx を全部のレシートに使い回せる。
// EVM の EIP-3009 nonce を売り手に選ばせないのと同じ理由で、常に我々が作る。
// 既知の代償: extra.memo を請求書の突合に使うファシリテータとは噛み合わない
// （Solana の L1 購入は 2026-09-04 時点で settled 0 件なので、壊れる実績は無い）。
test("売り手の extra.memo は使わず、常に我々の乱数 memo を載せる", async () => {
  const sel = selectSolanaAccept([accept({ extra: { feePayer: FEE_PAYER, memo: "pi_3abc" } })], {
    declaredAmount: "10000",
    declaredPayTo: PAY_TO,
  });
  const built = await buildSolanaPaymentTransaction({
    accept: sel.accept!,
    payer: KEYPAIR,
    recentBlockhash: BLOCKHASH,
  });
  const tx = VersionedTransaction.deserialize(Buffer.from(built.transactionB64, "base64"));
  const memoIx = tx.message.compiledInstructions[3];
  const onChain = Buffer.from(memoIx.data).toString("utf8");
  assert.notEqual(onChain, "pi_3abc", "売り手の memo をそのまま載せている");
  assert.equal(onChain, built.memo, "行へ保存する memo と tx の memo が食い違っている");
  assert.match(onChain, /^[0-9a-f]{32}$/);
});

test("encodeSolanaPaymentHeader: v2 envelope with payload.transaction", () => {
  const { headerName, headerValue } = encodeSolanaPaymentHeader({
    accept: accept() as never,
    transactionB64: "QUFB",
    resourceUrl: "https://palmyr.ai/phone/numbers",
  });
  assert.equal(headerName, "PAYMENT-SIGNATURE");
  const body = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));
  assert.equal(body.x402Version, 2);
  assert.equal(body.accepted.network, SOLANA_MAINNET_CAIP2);
  assert.equal(body.payload.transaction, "QUFB");
  assert.equal(body.resource.url, "https://palmyr.ai/phone/numbers");
});
