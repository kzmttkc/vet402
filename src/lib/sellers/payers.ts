// ============================================================
// vet402 の Base の支払元（方法論の「どちらの側か」(c) と売り手頁の説明用・2026-09-29 敵対的監査 6 周目）。
//
// 売り手が 08 月の tx を Basescan で開くと、送り手は今の支払元ではなく旧支払元（0x6777…）に見える。方法論に
// 両方の期間を書く。アドレスは payer-balance-history.ts の定義（残高を組み直した支払元）から引き、頁には
// 先頭 6 文字と末尾 4 文字だけを出す（公開の台帳の行・tx の送り手としてすでに見えている範囲）。
// 期間は台帳の実測（本番 SELECT 2026-09-29: payer ごとの Base の attempted_at の最小・最大）:
//   0x6777…3986  2026-08-14 09:54 〜 2026-09-04 07:02 UTC
//   0xc9c7…1670  2026-09-04 09:23 UTC 〜
// tests/sellers-r6.test.ts が、ここのアドレスが payer-balance-history.ts の定義にあることを固定する。
// ============================================================
import { PAYER_BALANCE_HISTORY } from "@/lib/observatory/payer-balance-history";

export interface PayerPeriod {
  /** 小文字の完全なアドレス（頁には shortPayer で出す）。 */
  address: string;
  /** 最初の Base の購入（UTC の日付）。 */
  from: string;
  /** 最後の Base の購入（UTC の日付）。今も使っていれば null。 */
  until: string | null;
}

const byPrefix = (prefix: string): string => {
  const hit = PAYER_BALANCE_HISTORY.find((p) => p.payer.startsWith(prefix));
  if (!hit) throw new Error(`payers.ts: no payer ${prefix}… in PAYER_BALANCE_HISTORY`);
  return hit.payer;
};

export const BASE_PAYER_PERIODS: readonly PayerPeriod[] = [
  { address: byPrefix("0x6777"), from: "2026-08-14", until: "2026-09-04" },
  { address: byPrefix("0xc9c7"), from: "2026-09-04", until: null },
];

/** 0x6777…3986 の形。 */
export function shortPayer(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
