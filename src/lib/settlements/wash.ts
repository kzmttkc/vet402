// ============================================================
// §7.2 wash_flag。純関数——同一管理下・往復・測定ウォレットの判定に必要な
// 外部知識（funder クラスタ・8004 owner・逆方向の決済）は呼び手が閉包で渡す。
//
//   self_deal:    payer と payee が同一管理下（同一 EOA・同一ファウンダー・同一 8004 owner）
//   circular:     短時間（24h）で往復
//   test:         vet402 自身の測定ウォレット（L1 payer と OBSERVATORY_TEST_WALLETS）
//   measurement:  公開一覧の他社の測定・点検サービス（measurement-payers.ts）
//
// 優先順位は test > measurement > self_deal > circular。
// test を先にするのは、settlement_30d_test の意味（vet402 自身）を変えないため。
// measurement は実需（none）から外す。self_deal / circular より先なので、
// 一覧の payer は settlement_30d_measurement にまとまる。
// ============================================================
import type { WashFlag } from "./types";
import { isMeasurementPayer } from "./measurement-payers";

export const CIRCULAR_WINDOW_HOURS = 24;

export type WashContext = {
  /** payer_id の集合（chain:address）。vet402 の L1 測定ウォレットは常にここに入る。 */
  testWallets: ReadonlySet<string>;
  /**
   * 公開一覧の測定・点検 payer。
   * 集合を渡したとき（空集合を含む）はその集合だけを見る。空なら measurement にしない。
   * 省略したときは measurement-payers.ts の一覧を使う。
   * 索引は loadWashClassifier が MEASUREMENT_PAYER_IDS を渡す。
   */
  measurementPayers?: ReadonlySet<string>;
  /** 同一 funder クラスタ or 同一 ERC-8004 owner。 */
  sameCluster: (payerId: string, payeeId: string) => boolean;
  /** at から hours 以内に payee → payer の逆方向決済があるか。 */
  reverseWithinHours: (payerId: string, payeeId: string, at: Date, hours: number) => boolean;
};

function listedMeasurement(ctx: WashContext, payerId: string): boolean {
  if (ctx.measurementPayers) {
    if (ctx.measurementPayers.has(payerId)) return true;
    if (payerId.startsWith("eip155:") && ctx.measurementPayers.has(payerId.toLowerCase())) return true;
    return false;
  }
  return isMeasurementPayer(payerId);
}

export function classifyWash(
  s: { payerId: string | null; payeeId: string | null; blockTime: Date | null },
  ctx: WashContext,
): WashFlag {
  if (s.payerId && ctx.testWallets.has(s.payerId)) return "test";
  if (s.payerId && listedMeasurement(ctx, s.payerId)) return "measurement";
  if (!s.payerId || !s.payeeId) return "none";
  if (s.payerId === s.payeeId) return "self_deal";
  if (ctx.sameCluster(s.payerId, s.payeeId)) return "self_deal";
  if (s.blockTime && ctx.reverseWithinHours(s.payerId, s.payeeId, s.blockTime, CIRCULAR_WINDOW_HOURS)) {
    return "circular";
  }
  return "none";
}
