// ============================================================
// 既公開 fail の訂正——対象選定（2026-09-02 監査 A1・オーナー決定）。
//
// パステンプレート URL（path-template.ts）を L0 でそのまま叩き、2 連続 fail で
// 公開 fail にしていた endpoint を unverified(path_template) へ戻す。判定は
// ここ（純関数・DB 無しでテスト）、DB の読み書きは scripts/correct-path-template-fails.ts。
//
// 訂正は §10 の作法で残す: 公開判定の before/after を correction_log に、
// 台帳側は unverified/path_template の probe 行を 1 行足す（履歴は消さない——
// 「叩いてしまった」事実も「なぜ戻したか」も両方残る）。
// ============================================================
import { publishedVerdict } from "./l0-probe";
import { PATH_TEMPLATE_REASON, isPathTemplate } from "./path-template";
import type { CorrectionLevel, CorrectionReason } from "./corrections";

export type CorrectionCandidate = {
  id: string;
  resourceUrl: string;
  /** 直近のプローブ verdict（新しい順）。publishedVerdict と同じ向き。 */
  verdictsNewestFirst: readonly string[];
};

/** 純関数: 公開判定が fail かつテンプレート URL の endpoint だけを返す（入力順）。 */
export function selectPathTemplateCorrections(
  rows: readonly CorrectionCandidate[],
): CorrectionCandidate[] {
  return rows.filter(
    (r) => publishedVerdict(r.verdictsNewestFirst) === "fail" && isPathTemplate(r.resourceUrl),
  );
}

export type CorrectionPayload = {
  subjectType: "endpoint";
  subjectId: string;
  level: CorrectionLevel;
  before: { publishedVerdict: "fail" };
  after: { publishedVerdict: "unverified"; failReason: typeof PATH_TEMPLATE_REASON; note: string };
  reason: CorrectionReason;
};

/** recordCorrection にそのまま渡せる形。note は監査の出典と URL を残す。 */
export function correctionPayload(row: CorrectionCandidate): CorrectionPayload {
  return {
    subjectType: "endpoint",
    subjectId: row.id,
    level: "l0",
    before: { publishedVerdict: "fail" },
    after: {
      publishedVerdict: "unverified",
      failReason: PATH_TEMPLATE_REASON,
      note: `2026-09-02 audit A1: ${row.resourceUrl} contains an unfilled path parameter; the probes that produced the published fail were requests we could not have formed correctly. Re-published as unverified.`,
    },
    reason: PATH_TEMPLATE_REASON,
  };
}
