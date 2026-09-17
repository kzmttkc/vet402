// ============================================================
// XRP → RLUSD の交換（2026-09-17・scripts/xrpl-trustline.ts の --swap-xrp が使う純関数）。
//
// 運用: 購入元ウォレットには XRP だけを入れ、台帳上で RLUSD に替える。実装は **自分宛ての
// cross-currency Payment**（Destination = 自分・Amount = RLUSD・SendMax = XRP drops・
// tfPartialPayment + DeliverMin で滑りを 2% までに制限）。板が薄くて見積もりどおりに
// 届かなければ tecPATH_PARTIAL で失敗し、XRP は動かない（手数料だけ）。
//
// 見積もりは `book_offers`（taker_gets = RLUSD / taker_pays = XRP）を良い順に食う。
// ここはネットワークを叩かない——RPC の応答を渡され、額と tx の形だけを決める。
// ============================================================
import { RLUSD_CURRENCY_HEX, RLUSD_ISSUER, XRPL_FEE_DROPS, XRPL_RESERVE_BASE_DROPS, XRPL_RESERVE_INC_DROPS, rlusdToUnits, rlusdToUnitsFloor, unitsToRlusdValue, type XrplIouAmount } from "./xrpl402-payer";

/** Payment の tfPartialPayment。DeliverMin と組で「最低これだけ届かなければ失敗」になる。 */
export const TF_PARTIAL_PAYMENT = 0x00020000;
/** 許す滑り（basis points）。2%。 */
export const SWAP_MAX_SLIPPAGE_BPS = 200n;

/** "8" / "8.5" → drops。XRP は 6 桁の drops なので RLUSD と同じ変換で足りる。不正・0 以下は null。 */
export function xrpToDrops(xrp: string): bigint | null {
  return rlusdToUnits(xrp);
}

export function dropsToXrp(drops: bigint): string {
  return unitsToRlusdValue(drops);
}

/**
 * 事前検査: 残高 − 準備金（基本 + 0.2 XRP × OwnerCount）− 手数料 ≥ 交換額。
 * OwnerCount は trust line を張った **後** の値を渡すこと。
 */
export function swapPreflight(input: { balanceDrops: bigint; ownerCount: number; swapDrops: bigint; feeDrops?: bigint }): {
  ok: boolean;
  spendableDrops: bigint;
  reserveDrops: bigint;
} {
  const feeDrops = input.feeDrops ?? BigInt(XRPL_FEE_DROPS);
  const reserveDrops = XRPL_RESERVE_BASE_DROPS + XRPL_RESERVE_INC_DROPS * BigInt(Math.max(0, input.ownerCount));
  const spendableDrops = input.balanceDrops - reserveDrops - feeDrops;
  return { ok: input.swapDrops > 0n && spendableDrops >= input.swapDrops, spendableDrops, reserveDrops };
}

/** book_offers の 1 件（RLUSD を出し XRP を欲しがる側の板）。funded があればそちらが実効値。 */
export type XrplBookOffer = {
  TakerGets: XrplIouAmount | string;
  TakerPays: XrplIouAmount | string;
  taker_gets_funded?: XrplIouAmount | string;
  taker_pays_funded?: XrplIouAmount | string;
};

export type SwapQuote = {
  /** 見積もりで届く RLUSD（6 桁 units）。 */
  deliveredUnits: bigint;
  /** 使う XRP（drops）。板が薄ければ swapDrops より小さい。 */
  spentDrops: bigint;
  /** 板が交換額ぶん揃っていたか。 */
  filled: boolean;
  /** RLUSD / XRP。板が空なら null。 */
  ratePerXrp: number | null;
};

function iouUnits(v: XrplIouAmount | string | undefined): bigint | null {
  if (!v || typeof v === "string") return null;
  if (typeof v.currency !== "string" || v.currency.toUpperCase() !== RLUSD_CURRENCY_HEX || v.issuer !== RLUSD_ISSUER) return null;
  return typeof v.value === "string" ? rlusdToUnitsFloor(v.value) : null;
}

function drops(v: XrplIouAmount | string | undefined): bigint | null {
  return typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null;
}

/**
 * 板を良い順（book_offers の返す順）に食って、swapDrops でいくら RLUSD が買えるか。
 * 各 offer は「TakerGets RLUSD を出す代わりに TakerPays XRP を欲しがる」。部分約定は比例配分（切り捨て）。
 */
export function quoteXrpToRlusd(offers: readonly XrplBookOffer[], swapDrops: bigint): SwapQuote {
  let remaining = swapDrops;
  let delivered = 0n;
  for (const o of offers) {
    if (remaining <= 0n) break;
    const gets = iouUnits(o.taker_gets_funded ?? o.TakerGets);
    const pays = drops(o.taker_pays_funded ?? o.TakerPays);
    if (gets === null || pays === null || gets <= 0n || pays <= 0n) continue;
    const take = remaining < pays ? remaining : pays;
    delivered += (gets * take) / pays;
    remaining -= take;
  }
  const spent = swapDrops - remaining;
  return {
    deliveredUnits: delivered,
    spentDrops: spent,
    filled: remaining === 0n && swapDrops > 0n,
    ratePerXrp: spent > 0n ? Number(delivered) / Number(spent) : null,
  };
}

export type XrplSwapPaymentTx = {
  TransactionType: "Payment";
  Account: string;
  Destination: string;
  Amount: XrplIouAmount;
  SendMax: string;
  DeliverMin: XrplIouAmount;
  Fee: string;
  Sequence: number;
  LastLedgerSequence: number;
  Flags: number;
};

/**
 * 自分宛ての cross-currency Payment。Amount = 見積もり額（上限）、SendMax = XRP drops、
 * DeliverMin = 見積もり × (1 − 2%)。届く額が DeliverMin 未満なら tecPATH_PARTIAL で失敗する。
 */
export function buildXrpToRlusdSwap(input: {
  account: string;
  sequence: number;
  validatedLedgerIndex: number;
  swapDrops: bigint;
  quotedUnits: bigint;
  maxSlippageBps?: bigint;
}): XrplSwapPaymentTx {
  if (input.swapDrops <= 0n) throw new Error("xrpl-swap: swapDrops must be positive");
  if (input.quotedUnits <= 0n) throw new Error("xrpl-swap: quotedUnits must be positive");
  const bps = input.maxSlippageBps ?? SWAP_MAX_SLIPPAGE_BPS;
  const minUnits = (input.quotedUnits * (10_000n - bps)) / 10_000n;
  if (minUnits <= 0n) throw new Error("xrpl-swap: DeliverMin rounds to zero");
  const rlusd = (units: bigint): XrplIouAmount => ({ currency: RLUSD_CURRENCY_HEX, issuer: RLUSD_ISSUER, value: unitsToRlusdValue(units) });
  return {
    TransactionType: "Payment",
    Account: input.account,
    Destination: input.account,
    Amount: rlusd(input.quotedUnits),
    SendMax: input.swapDrops.toString(),
    DeliverMin: rlusd(minUnits),
    Fee: XRPL_FEE_DROPS,
    Sequence: input.sequence,
    LastLedgerSequence: input.validatedLedgerIndex + 20,
    Flags: TF_PARTIAL_PAYMENT,
  };
}
