// ============================================================
// vet402 — endpoint receipt badge (seller-outreach hook, 2026-08-18).
//
// The moat is the receipt time-series, and a seller vet402 has actually paid
// can embed proof of it. This badge states ONE fact: n of m paid attempts
// settled with an on-chain receipt. It is deliberately NOT the trust badge —
// there is no green/red judgment here, because the observatory's rule is facts
// only, no scores, no evaluative language (see /observatory). Every measured
// state uses the same navy ink; the number is the message. An unmeasured
// endpoint says "not yet measured", never a fabricated 0/0 or 0%.
//
// The honest, full sentence rides in aria-label / <title>; the visible right
// segment is too small for it.
// ============================================================

export type ReceiptBadgeInput = {
  attemptCount: number;
  settledCount: number;
  /**
   * settled かつ有料リクエストが 2xx を返した件数（2026-09-04 監査 E・P0-3）。
   * settled だけを描いていたので、api.exa.ai/search は「10/10 settled」と出ながら
   * その 10 件すべてが HTTP 400 だった。金が動いたことと品が届いたことは別の事実。
   * 省略時は 0 として描く（黙って settled と同じ数にすると事故が再発する）。
   */
  deliveredCount?: number;
};

export type ReceiptBadge = {
  /** Short visible label for the right segment. */
  label: string;
  /** Fill colour — one ink for every state (facts, not a verdict). */
  color: string;
  /** Full accessible description. */
  aria: string;
};

// One navy for every measured state (facts, not a signal). Matches the RFC
// world's ink (#233456) so an embed reads as a vet402 measurement, not a
// green-light. Grey for the not-yet-measured state.
const NAVY = "#233456";
const GREY = "#71717a";

export function endpointReceiptBadge(input: ReceiptBadgeInput): ReceiptBadge {
  const attempts = Math.max(0, Math.trunc(input.attemptCount));
  const settled = Math.max(0, Math.min(attempts, Math.trunc(input.settledCount)));

  if (attempts === 0) {
    return {
      label: "not yet measured",
      color: GREY,
      aria: "vet402: this endpoint has no recorded paid attempts yet. A fact about our coverage, not about the endpoint.",
    };
  }

  const delivered = Math.max(0, Math.min(settled, Math.trunc(input.deliveredCount ?? 0)));

  return {
    label: `${settled}/${attempts} settled · ${delivered} delivered`,
    color: NAVY,
    aria: `vet402: ${settled} of ${attempts} paid attempts settled with an on-chain receipt, and ${delivered} of those also returned a 2xx response. settled is the confirmed transfer; delivered is the response arriving. A measurement of what happened when vet402 paid this endpoint, not a recommendation.`,
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 左の区画（vet402 のワードマーク）の幅。 */
const MARK_W = 58;
/** Verdana 10px の 1 文字あたりの実効幅の上限。これで見積もると切れない。 */
const CHAR_W = 6.2;
/** 右の区画の左右の余白。 */
const PAD = 16;
/** バッジの高さ（SVG と <img> の intrinsic hint で同じ値を使う）。 */
export const RECEIPT_BADGE_HEIGHT = 24;

/**
 * ラベルから決まるバッジ全体の幅。埋め込む側（endpoint 頁の <img>）が
 * 同じ関数を呼ぶので、幅の見積もりが 2 箇所に散らない。
 */
export function receiptBadgeWidth(label: string): number {
  return MARK_W + Math.max(130, Math.ceil(label.length * CHAR_W) + PAD);
}

/**
 * Render the embeddable SVG. Wider than the trust badge because the label is a
 * short phrase ("3/5 settled · 2 delivered") rather than a single word. The left
 * segment carries the vet402 wordmark; the right carries the fact.
 *
 * 2026-09-04 監査 E・P0-3: ラベルが settled と delivered の 2 つの数を持つように
 * なったので、右の区画は固定 130px ではなくラベルの長さから決める。固定のままだと
 * 数字が 4 桁になった endpoint で語が切れて、切れた語が別の意味に読める。
 */
export function renderReceiptBadgeSvg(badge: ReceiptBadge): string {
  const aria = xmlEscape(badge.aria);
  const label = xmlEscape(badge.label);
  const total = receiptBadgeWidth(badge.label);
  const rightW = total - MARK_W;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${RECEIPT_BADGE_HEIGHT}" role="img" aria-label="${aria}">
  <title>${aria}</title>
  <rect width="${MARK_W}" height="${RECEIPT_BADGE_HEIGHT}" rx="4" fill="#18181b"/>
  <rect x="${MARK_W}" width="${rightW}" height="${RECEIPT_BADGE_HEIGHT}" rx="4" fill="${badge.color}"/>
  <rect x="${MARK_W}" width="6" height="${RECEIPT_BADGE_HEIGHT}" fill="${badge.color}"/>
  <text x="29" y="16" text-anchor="middle" font-family="Verdana,sans-serif" font-size="11" fill="#ffffff">vet402</text>
  <text x="${MARK_W + rightW / 2}" y="16" text-anchor="middle" font-family="Verdana,sans-serif" font-size="10" fill="#ffffff">${label}</text>
</svg>`;
}
