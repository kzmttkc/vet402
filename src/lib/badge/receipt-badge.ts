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
//
// 2026-09-05: **バッジ自身に「誰の・いつの」を焼き込む**。それまでの SVG には
// endpoint ID もホスト名も測定日も 1 文字も入っていなかった——他社のバッジを
// 1 回落として自分のサーバに置けば、その数字を永久に固定できた（実測: Referer を
// 偽装した取得が HTTP 200、保存した SVG に3つとも出現 0 件）。第二行はその対策で、
// 見た目の飾りではない。
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
  /**
   * settled かつ有料応答が 4xx だった件数（2026-09-05）。**判定保留**であって
   * 売り手の不履行ではない。我々は POST に `{}` を送り API キーを持たずに買うので、
   * 4xx は我々の要求の形で説明がつく。これを delivered の分母に残したまま
   * `10/10 settled · 0 delivered` を実名の会社に対して配っていた。
   */
  inconclusiveCount?: number;
  /** 測った相手のホスト名（バッジの中に焼き込む。無ければ endpoint ID の先頭）。 */
  subject?: string | null;
  /** 最後に測った日（UTC, YYYY-MM-DD）。無ければ第二行は主体だけになる。 */
  measuredOn?: string | null;
};

export type ReceiptBadge = {
  /** Short visible label for the right segment. */
  label: string;
  /** Second visible line — who this is about and when it was measured. */
  sublabel: string;
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

/** 第二行。**主体と日付が両方欠けたときだけ空**（作らない）。 */
function provenanceLine(subject?: string | null, measuredOn?: string | null): string {
  const who = (subject ?? "").trim();
  const when = (measuredOn ?? "").trim();
  if (who && when) return `${who} · measured ${when}`;
  if (who) return who;
  if (when) return `measured ${when}`;
  return "";
}

export function endpointReceiptBadge(input: ReceiptBadgeInput): ReceiptBadge {
  const attempts = Math.max(0, Math.trunc(input.attemptCount));
  const settled = Math.max(0, Math.min(attempts, Math.trunc(input.settledCount)));
  const sublabel = provenanceLine(input.subject, input.measuredOn);

  if (attempts === 0) {
    return {
      label: "not yet measured",
      sublabel,
      color: GREY,
      aria: `vet402: this endpoint has no recorded paid attempts yet. A fact about our coverage, not about the endpoint.${sublabel ? ` (${sublabel})` : ""}`,
    };
  }

  const inconclusive = Math.max(0, Math.min(settled, Math.trunc(input.inconclusiveCount ?? 0)));
  const delivered = Math.max(
    0,
    Math.min(settled - inconclusive, Math.trunc(input.deliveredCount ?? 0)),
  );

  const label = inconclusive > 0
    ? `${settled}/${attempts} settled · ${delivered} delivered · ${inconclusive} inconclusive`
    : `${settled}/${attempts} settled · ${delivered} delivered`;

  const aria =
    `vet402: ${settled} of ${attempts} paid attempts settled with an on-chain receipt, and ` +
    `${delivered} of those also returned a 2xx response. settled is the confirmed transfer; ` +
    `delivered is the response arriving.` +
    (inconclusive > 0
      ? ` ${inconclusive} settled attempt${inconclusive === 1 ? "" : "s"} answered 4xx and ` +
        `${inconclusive === 1 ? "is" : "are"} held as inconclusive rather than counted against the ` +
        `seller: vet402 buys with an empty request body and no API key, so a 4xx can be our own ` +
        `request being malformed.`
      : "") +
    ` A measurement of what happened when vet402 paid this endpoint, not a recommendation.` +
    (sublabel ? ` (${sublabel})` : "");

  return { label, sublabel, color: NAVY, aria };
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
/** 第二行は 9px。同じ理由で少し狭い。 */
const SUB_CHAR_W = 5.4;
/** 右の区画の左右の余白。 */
const PAD = 16;
/** バッジの高さ（SVG と <img> の intrinsic hint で同じ値を使う）。 */
export const RECEIPT_BADGE_HEIGHT = 38;

/**
 * ラベルから決まるバッジ全体の幅。埋め込む側（endpoint 頁の <img>）が
 * 同じ関数を呼ぶので、幅の見積もりが 2 箇所に散らない。
 */
export function receiptBadgeWidth(label: string, sublabel = ""): number {
  const right = Math.max(
    130,
    Math.ceil(label.length * CHAR_W) + PAD,
    Math.ceil(sublabel.length * SUB_CHAR_W) + PAD,
  );
  return MARK_W + right;
}

/**
 * Render the embeddable SVG. Wider than the trust badge because the label is a
 * short phrase ("3/5 settled · 2 delivered") rather than a single word. The left
 * segment carries the vet402 wordmark; the right carries the fact on the first
 * line and **who it is about and when it was measured** on the second.
 *
 * 2026-09-04 監査 E・P0-3: ラベルが settled と delivered の 2 つの数を持つように
 * なったので、右の区画は固定 130px ではなくラベルの長さから決める。固定のままだと
 * 数字が 4 桁になった endpoint で語が切れて、切れた語が別の意味に読める。
 *
 * 2026-09-05: 第二行（ホスト名・測定日）。これが無いと、落として保存した SVG が
 * 「誰の・いつの数字か」を一切名乗らないまま他所で通用してしまう。
 */
export function renderReceiptBadgeSvg(badge: ReceiptBadge): string {
  const aria = xmlEscape(badge.aria);
  const label = xmlEscape(badge.label);
  const sub = xmlEscape(badge.sublabel);
  const total = receiptBadgeWidth(badge.label, badge.sublabel);
  const rightW = total - MARK_W;
  const h = RECEIPT_BADGE_HEIGHT;
  const cx = MARK_W + rightW / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${h}" role="img" aria-label="${aria}">
  <title>${aria}</title>
  <rect width="${MARK_W}" height="${h}" rx="4" fill="#18181b"/>
  <rect x="${MARK_W}" width="${rightW}" height="${h}" rx="4" fill="${badge.color}"/>
  <rect x="${MARK_W}" width="6" height="${h}" fill="${badge.color}"/>
  <text x="29" y="23" text-anchor="middle" font-family="Verdana,sans-serif" font-size="11" fill="#ffffff">vet402</text>
  <text x="${cx}" y="16" text-anchor="middle" font-family="Verdana,sans-serif" font-size="10" fill="#ffffff">${label}</text>
  <text x="${cx}" y="30" text-anchor="middle" font-family="Verdana,sans-serif" font-size="9" fill="#ffffff" fill-opacity="0.82">${sub}</text>
</svg>`;
}
