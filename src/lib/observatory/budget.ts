// ============================================================
// vet402 Observatory — L1 purchasing budget guard (design §8).
//
// 2026-08-22: この見出しは「NO CALLER EXISTS. Real purchasing is W3」と
// 書いたまま陳腐化していた。実際には l1-runner が本番で毎日呼んでいる
// （runL1Batch の日次合計と purchaseOne の署名前ゲート）。
//
// この関数は**判定するだけ**で、数えない。当日の支出額は台帳
// （x402_l1_purchases.spent_units の UTC 日次合計）から呼び手が渡す。
// 二重防御の1段目でもある: 実際の予約は reserveSpend の単一SQL文が原子的に
// 取り直すので、ここを通っても最終的な支出は台帳の側で決まる。
//
// Fail-closed, concretely:
//   - OFF unless OBSERVATORY_L1_ENABLED is the exact string "true";
//   - denied on NaN / negative / zero amounts (malformed input is not a
//     reason to spend money);
//   - denied when spend-so-far + request would exceed the daily cap.
// The $25/day cap is the WO figure.
// ============================================================

export const DAILY_BUDGET_USD = 25;

/**
 * Solana の L1 が 1 UTC 日に使える別枠（全チェーン共有の $25 の内側・2026-09-15）。
 * 未購入を先に選ぶ並び順のせいで、Solana の掃引が Base の定期購入の枠を先に食わないようにする。
 * 公開台帳の実測（2026-09-02〜15）: Base の日次支出は平均 $13.95・最大 $22.73。
 * 環境変数 L1_SOLANA_DAILY_CAP_USD で下げられる（0 で Solana を止める）。壊れた値は既定へ倒す。
 */
export const SOLANA_DAILY_CAP_USD_DEFAULT = 2;

/**
 * Arc の別枠（2026-09-17・Arc レーン）。Solana と同じ理由・同じ $2。両方引いても Base には
 * 毎日 $21 が残る（実測最大 $22.73 を割るのは両レーンが同じ日に別枠を使い切った場合だけで、
 * その日は Arc/Solana の掃引が Base の裾野 1〜2 件ぶんを押し出す——許容する）。
 * 環境変数 L1_ARC_DAILY_CAP_USD で下げられる（0 で Arc を止める）。
 */
export const ARC_DAILY_CAP_USD_DEFAULT = 2;

/** 別枠を持つチェーン。Base は持たない（共有 $25 だけ）。 */
export type CappedChain = "solana" | "arc";

/**
 * チェーン別の別枠の表。`networkLike` は x402_l1_purchases.network に対する SQL の LIKE
 * パターン（l1-runner の予約 CTE と候補 SQL がそのまま使う）。Arc はワイルドカード無し＝
 * 完全一致で、testnet（eip155:5042002）を巻き込まない。
 */
export const CHAIN_DAILY_CAPS: Record<CappedChain, { env: string; defaultUsd: number; networkLike: string }> = {
  solana: { env: "L1_SOLANA_DAILY_CAP_USD", defaultUsd: SOLANA_DAILY_CAP_USD_DEFAULT, networkLike: "solana:%" },
  arc: { env: "L1_ARC_DAILY_CAP_USD", defaultUsd: ARC_DAILY_CAP_USD_DEFAULT, networkLike: "eip155:5042" },
};

/** その network が別枠を持つチェーンなら、その名前。持たなければ null。 */
export function cappedChainFor(network: string): CappedChain | null {
  if (network.startsWith("solana:")) return "solana";
  if (network === "eip155:5042") return "arc";
  return null;
}

/** そのチェーンの別枠（USDC 基本単位）。壊れた値は既定へ倒し、共有の日次上限で頭打ち。 */
export function chainDailyCapUnits(chain: CappedChain): bigint {
  const cap = CHAIN_DAILY_CAPS[chain];
  const raw = process.env[cap.env];
  let usd = cap.defaultUsd;
  if (raw !== undefined && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) usd = n;
  }
  usd = Math.min(usd, DAILY_BUDGET_USD);
  return BigInt(Math.round(usd * 1_000_000));
}

/** 表の solana 行の別名（2026-09-15 からの呼び手のため）。 */
export function solanaDailyCapUnits(): bigint {
  return chainDailyCapUnits("solana");
}

export function isL1Enabled(): boolean {
  return process.env.OBSERVATORY_L1_ENABLED === "true";
}

export type BudgetDecision =
  | { allowed: true }
  | { allowed: false; reason: "l1_disabled" | "invalid_amount" | "daily_budget_exceeded" };

export function checkL1Budget(input: {
  /** USD already spent today (caller-supplied from x402_l1_purchases, UTC day). */
  spentTodayUsd: number;
  /** USD this purchase would cost. */
  requestUsd: number;
}): BudgetDecision {
  if (!isL1Enabled()) return { allowed: false, reason: "l1_disabled" };

  const { spentTodayUsd, requestUsd } = input;
  if (!Number.isFinite(spentTodayUsd) || spentTodayUsd < 0) {
    return { allowed: false, reason: "invalid_amount" };
  }
  if (!Number.isFinite(requestUsd) || requestUsd <= 0) {
    return { allowed: false, reason: "invalid_amount" };
  }
  if (spentTodayUsd + requestUsd > DAILY_BUDGET_USD) {
    return { allowed: false, reason: "daily_budget_exceeded" };
  }
  return { allowed: true };
}
