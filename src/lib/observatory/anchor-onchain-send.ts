// ============================================================
// 3.8 のお金（2026-11-11）: 新しいアンカーの送信は、送る直前で止まる。
//
// 新しい送金・新しい鎖・額の変更は、legal-check、独立の SHIP、オーナーの承認の前に出さない
// （要件 3.8 の「お金」）。既存の上限の額は文書に無いので、既存のジョブもこの側へ倒す。
// この関数は送る中身（日・root・件数・宛先の種類）を組んで返すだけで、署名も RPC も
// broadcast もしない。戻りの status は常に stopped である。送る経路はこの波には無い。
// ============================================================
import { isAnchorWritesEnabled } from "@/lib/observatory/anchors";

export type AnchorSendIntent = {
  day: string;
  rootHash: string;
  entryCount: number;
  chainTarget: "evm" | "stellar" | "tempo_memo";
};

export type AnchorSendStopReason = "writes_disabled" | "documented_spend_cap_missing" | "owner_approval_required";

export type AnchorSendGateResult = { status: "stopped"; reason: AnchorSendStopReason; intent: AnchorSendIntent };

export function gateAnchorOnchainSend(
  intent: AnchorSendIntent,
  opts?: { ownerApproved?: boolean; documentedSpendCapUsd?: string | null },
): AnchorSendGateResult {
  if (!isAnchorWritesEnabled()) return { status: "stopped", reason: "writes_disabled", intent };
  if (!opts?.documentedSpendCapUsd) return { status: "stopped", reason: "documented_spend_cap_missing", intent };
  // オーナーの承認があっても、この波では送らない。承認の記録と送る経路は別の変更で足す。
  return { status: "stopped", reason: "owner_approval_required", intent };
}
