// ============================================================
// デモ経由の L1 購入の、日次デモ予算の精算（2026-11-02 独立レビュー）。
//
// 予算は購入の前に取り、資金が動かなかったときだけ 1 回返す。
//   - バッチが投げた → まだ精算していないので返す
//   - spent = 0 → 返す。この後の読み直しが投げても二重に返さない
//   - spent > 0 → 返さない。この後の読み直しが投げても返さない（資金は動いた）
// ルートの外に置くのは、資金が動いた場合をテストするため（runL1Batch はルートから差し替えられない）。
// ============================================================

export async function runDemoPurchaseWithBudget<S extends { spentUnitsTotal: string }, P>(deps: {
  run: () => Promise<S>;
  readPurchases: () => Promise<P>;
  refundBudget: () => Promise<void>;
}): Promise<{ summary: S; purchases: P }> {
  let budgetSettled = false;
  try {
    const summary = await deps.run();
    // 成立＝資金が動いた（署名して支払った）。spent_units が立たなければ計上しない。
    if (BigInt(summary.spentUnitsTotal || "0") === 0n) await deps.refundBudget();
    budgetSettled = true;
    const purchases = await deps.readPurchases();
    return { summary, purchases };
  } catch (error) {
    if (!budgetSettled) await deps.refundBudget();
    throw error;
  }
}
