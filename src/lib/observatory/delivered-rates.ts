// ============================================================
// delivered の率を分母ごとに並べる（2026-09-29 監査 5 周目・データ記者の立場）。
//
// /observatory/state は「Delivered 45.2% of attempts」だけを出していた。分母の attempts には判定保留
// （l1.inconclusive: 4xx・自社の資金切れ）と照合待ち（l1.awaitingReread: settle_claimed）が入っていて、
// 「半分以上が届かなかった」と読まれる。率は消さず、分母を変えた率を並べ、それぞれの分母を名前で書く。
// 純関数（state API と頁が同じ値を出す）。
// ============================================================
import { pct1 } from "@/lib/util/pct";

/** l1Rates の3列は pct1 の単純比。Wilson 下限は find・sellers フィード（v1.0-wilson95）だけ。 */
export const L1_DELIVERED_SHARE_FORMULA = "ratio-pct1-v1" as const;

export type DeliveredRates = {
  /** 単純比の式（pct1・小数 1 桁）。 */
  rate_formula: typeof L1_DELIVERED_SHARE_FORMULA;
  /** l1.delivered / l1.attempts（保留も照合待ちも分母に入る）。 */
  deliveredOfAttemptsPct: number | null;
  /** l1.delivered / (l1.attempts - l1.inconclusive)（保留を除く・照合待ちは分母に残る）。 */
  deliveredOfNotHeldPct: number | null;
  /** l1.delivered / (l1.attempts - l1.inconclusive - l1.awaitingReread)（数える結果が出た試行だけ）。 */
  deliveredOfFinalOutcomePct: number | null;
  denominators: { attempts: number; notHeld: number; finalOutcome: number };
};

/** 小数 1 桁の %（分母 0 は null）。丸めの正典は src/lib/util/pct.ts（公開面すべてで同じ丸め）。 */
export { pct1 };

export function deliveredRates(l1: { attempts: number; delivered: number; inconclusive: number; awaitingReread: number }): DeliveredRates {
  const attempts = Math.max(0, l1.attempts);
  const notHeld = Math.max(0, attempts - l1.inconclusive);
  const finalOutcome = Math.max(0, notHeld - l1.awaitingReread);
  return {
    rate_formula: L1_DELIVERED_SHARE_FORMULA,
    deliveredOfAttemptsPct: pct1(l1.delivered, attempts),
    deliveredOfNotHeldPct: pct1(l1.delivered, notHeld),
    deliveredOfFinalOutcomePct: pct1(l1.delivered, finalOutcome),
    denominators: { attempts, notHeld, finalOutcome },
  };
}
