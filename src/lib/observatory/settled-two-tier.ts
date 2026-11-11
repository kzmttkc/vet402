// ============================================================
// 3.8 の 6a-1（2026-11-11）: settled の 2 段を、公開の state で一つの数に潰さない。
//
// state の GET は l1.settled と、その内訳 l1.settledNonceBound（購入ごとの一回値まで照合）と
// l1.settledAmountPayeeOnly（払い手・宛先・額・資産まで）を出す。内訳のどちらかが欠ける、
// 数でない、または和が settled と違う応答は、200 で出さずに閉じる（呼び手が 503 にする）。
// 行の分類は settled-tier.ts の settledTier が単独で持つ。ここは公開する数の形だけを見る。
// ============================================================

export type L1SettledTiers = {
  settled?: unknown;
  settledNonceBound?: unknown;
  settledAmountPayeeOnly?: unknown;
};

export type L1SettledTierCheck =
  | { ok: true }
  | { ok: false; reason: "settled_missing" | "nonce_bound_missing" | "amount_payee_only_missing" | "tier_sum_ne_settled" };

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** 2 段が別の数で並び、足すと settled になるときだけ ok。settled が 0 でも内訳の欄は要る。 */
export function validateL1SettledTwoTier(l1: L1SettledTiers | null | undefined): L1SettledTierCheck {
  const settled = count(l1?.settled);
  if (settled === null) return { ok: false, reason: "settled_missing" };
  const bound = count(l1?.settledNonceBound);
  if (bound === null) return { ok: false, reason: "nonce_bound_missing" };
  const payeeOnly = count(l1?.settledAmountPayeeOnly);
  if (payeeOnly === null) return { ok: false, reason: "amount_payee_only_missing" };
  if (bound + payeeOnly !== settled) return { ok: false, reason: "tier_sum_ne_settled" };
  return { ok: true };
}
