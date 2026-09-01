// ============================================================
// §7.2 wash_flag。純関数——同一管理下・往復・測定ウォレットの判定に必要な
// 外部知識（funder クラスタ・8004 owner・逆方向の決済）は呼び手が閉包で渡す。
//
//   self_deal: payer と payee が同一管理下（同一 EOA・同一ファウンダー・同一 8004 owner）
//   circular:  短時間（24h）で往復
//   test:      既知の測定ウォレット（vet402 自身を含む）
//
// 優先順位は test > self_deal > circular。測定は実需から必ず除く（§13 独立性）。
// ============================================================
import type { WashFlag } from "./types";

export const CIRCULAR_WINDOW_HOURS = 24;

export type WashContext = {
  /** payer_id の集合（chain:address）。vet402 の L1 測定ウォレットは常にここに入る。 */
  testWallets: ReadonlySet<string>;
  /** 同一 funder クラスタ or 同一 ERC-8004 owner。 */
  sameCluster: (payerId: string, payeeId: string) => boolean;
  /** at から hours 以内に payee → payer の逆方向決済があるか。 */
  reverseWithinHours: (payerId: string, payeeId: string, at: Date, hours: number) => boolean;
};

export function classifyWash(
  s: { payerId: string | null; payeeId: string | null; blockTime: Date | null },
  ctx: WashContext,
): WashFlag {
  if (s.payerId && ctx.testWallets.has(s.payerId)) return "test";
  if (!s.payerId || !s.payeeId) return "none";
  if (s.payerId === s.payeeId) return "self_deal";
  if (ctx.sameCluster(s.payerId, s.payeeId)) return "self_deal";
  if (s.blockTime && ctx.reverseWithinHours(s.payerId, s.payeeId, s.blockTime, CIRCULAR_WINDOW_HOURS)) {
    return "circular";
  }
  return "none";
}
