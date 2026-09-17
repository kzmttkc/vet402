// ============================================================
// XRP → RLUSD の交換（scripts/xrpl-trustline.ts --swap-xrp）の純関数（2026-09-17）。
//   - 見積もり: book_offers を良い順に食い、funded を優先、部分約定は比例、板が薄ければ filled=false
//   - 事前検査: 残高 − 準備金(1 + 0.2×OwnerCount) − 手数料 ≥ 交換額
//   - tx の形: 自分宛て Payment・Amount RLUSD・SendMax は drops 文字列・DeliverMin は 2% 下・tfPartialPayment
// ネットワークは叩かない。
// ============================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet, decode } from "xrpl";
import {
  TF_PARTIAL_PAYMENT,
  buildXrpToRlusdSwap,
  dropsToXrp,
  quoteXrpToRlusd,
  swapPreflight,
  xrpToDrops,
  type XrplBookOffer,
} from "@/lib/observatory/xrpl-swap";
import { RLUSD_CURRENCY_HEX, RLUSD_ISSUER } from "@/lib/observatory/xrpl402-payer";

const rlusd = (value: string) => ({ currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_ISSUER, value });

test("xrpToDrops / dropsToXrp: 8 XRP = 8000000 drops、6 桁まで", () => {
  assert.equal(xrpToDrops("8"), 8_000_000n);
  assert.equal(xrpToDrops("8.5"), 8_500_000n);
  assert.equal(xrpToDrops("0.0000001"), null);
  assert.equal(xrpToDrops("0"), null);
  assert.equal(dropsToXrp(8_500_000n), "8.5");
});

test("swapPreflight: 残高 − 準備金(1 + 0.2×OwnerCount) − 手数料 ≥ 交換額", () => {
  // 30.75 XRP・trust line 1 本 → 準備金 1.2 XRP・手数料 12 drops → 使えるのは 29.549988 XRP
  const ok = swapPreflight({ balanceDrops: 30_750_000n, ownerCount: 1, swapDrops: 8_000_000n });
  assert.equal(ok.ok, true);
  assert.equal(ok.reserveDrops, 1_200_000n);
  assert.equal(ok.spendableDrops, 30_750_000n - 1_200_000n - 12n);
  assert.equal(swapPreflight({ balanceDrops: 30_750_000n, ownerCount: 1, swapDrops: 29_549_988n }).ok, true, "ちょうど");
  assert.equal(swapPreflight({ balanceDrops: 30_750_000n, ownerCount: 1, swapDrops: 29_549_989n }).ok, false, "1 drop 超え");
  assert.equal(swapPreflight({ balanceDrops: 1_500_000n, ownerCount: 1, swapDrops: 1n }).ok, true);
  assert.equal(swapPreflight({ balanceDrops: 1_200_000n, ownerCount: 1, swapDrops: 1n }).ok, false, "準備金で全部");
  assert.equal(swapPreflight({ balanceDrops: 30_750_000n, ownerCount: 1, swapDrops: 0n }).ok, false);
});

test("quoteXrpToRlusd: 板を良い順に食い、funded を優先し、部分約定は比例配分", () => {
  const offers: XrplBookOffer[] = [
    // 10 RLUSD を 5 XRP で（2 RLUSD/XRP）。実際の残りは半分
    { TakerGets: rlusd("10"), TakerPays: "5000000", taker_gets_funded: rlusd("5"), taker_pays_funded: "2500000" },
    // 18 RLUSD を 10 XRP で（1.8 RLUSD/XRP）
    { TakerGets: rlusd("18"), TakerPays: "10000000" },
    // 別トークンの板は無視
    { TakerGets: { currency: "USD", issuer: RLUSD_ISSUER, value: "100" }, TakerPays: "1000000" },
  ];
  const q = quoteXrpToRlusd(offers, 8_000_000n);
  // 2.5 XRP → 5 RLUSD、残り 5.5 XRP → 18 × 5.5/10 = 9.9 RLUSD
  assert.equal(q.deliveredUnits, 5_000_000n + 9_900_000n);
  assert.equal(q.spentDrops, 8_000_000n);
  assert.equal(q.filled, true);
  assert.ok(Math.abs(q.ratePerXrp! - 14.9 / 8) < 1e-9);
  // 板が薄い: 12.5 XRP までしか無い
  const thin = quoteXrpToRlusd(offers, 20_000_000n);
  assert.equal(thin.filled, false);
  assert.equal(thin.spentDrops, 12_500_000n);
  assert.equal(thin.deliveredUnits, 5_000_000n + 18_000_000n);
  const empty = quoteXrpToRlusd([], 1_000_000n);
  assert.equal(empty.filled, false);
  assert.equal(empty.ratePerXrp, null);
});

test("buildXrpToRlusdSwap: 自分宛て・Amount RLUSD・SendMax drops・DeliverMin は 2% 下・tfPartialPayment。署名して decode できる", () => {
  const w = Wallet.fromSeed("sEdTM1uX8pu2do5XvTnutH6HsouMaM2");
  const tx = buildXrpToRlusdSwap({ account: w.classicAddress, sequence: 3, validatedLedgerIndex: 100_000, swapDrops: 8_000_000n, quotedUnits: 14_900_000n });
  assert.equal(tx.Destination, w.classicAddress);
  assert.deepEqual(tx.Amount, rlusd("14.9"));
  assert.equal(tx.SendMax, "8000000", "SendMax は XRP の drops 文字列");
  assert.deepEqual(tx.DeliverMin, rlusd("14.602"), "14.9 × 0.98");
  assert.equal(tx.Flags, TF_PARTIAL_PAYMENT);
  assert.equal(tx.Fee, "12");
  assert.equal(tx.LastLedgerSequence, 100_020);
  const signed = w.sign(tx);
  const d = decode(signed.tx_blob) as Record<string, unknown>;
  assert.equal(d.TransactionType, "Payment");
  assert.equal(d.SendMax, "8000000");
  assert.deepEqual(d.DeliverMin, rlusd("14.602"));
  assert.equal(d.Flags, TF_PARTIAL_PAYMENT);
  assert.throws(() => buildXrpToRlusdSwap({ account: w.classicAddress, sequence: 1, validatedLedgerIndex: 1, swapDrops: 0n, quotedUnits: 1n }), /positive/);
  assert.throws(() => buildXrpToRlusdSwap({ account: w.classicAddress, sequence: 1, validatedLedgerIndex: 1, swapDrops: 1n, quotedUnits: 0n }), /positive/);
});
