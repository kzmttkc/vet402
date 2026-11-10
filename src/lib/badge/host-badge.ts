// ============================================================
// vet402 — per-host seller badge (2026-11-11).
// Facts only: settled paid calls in 30 days and how many returned 2xx other than 202.
// Neutral greys (#111111 / #555555). No trust language.
// ============================================================

export type HostBadgeInput = {
  host: string;
  settled: number;
  answered: number;
  /** UTC calendar date YYYY-MM-DD shown on the badge. */
  asOfDate: string;
};

export type HostBadge = {
  line1: string;
  line2: string;
  aria: string;
};

export const HOST_BADGE_HEIGHT = 38;
const MARK_W = 58;
const LEFT = "#111111";
const RIGHT = "#555555";
const CHAR_W = 6.2;
const SUB_CHAR_W = 5.4;
const PAD = 16;

export function hostBadgeCopy(input: HostBadgeInput): HostBadge {
  const host = input.host.trim();
  const settled = Math.max(0, Math.trunc(input.settled));
  const answered = Math.max(0, Math.min(settled, Math.trunc(input.answered)));
  const date = input.asOfDate.trim();
  const line2 = `${host} · vet402.com/sellers · ${date}`;
  const detail = `Details at vet402.com/sellers/${host}`;
  if (settled === 0) {
    return {
      line1: "no paid calls in 30 days",
      line2,
      aria: `vet402 made no paid calls to ${host} in the 30 days to ${date}. ${detail}`,
    };
  }
  return {
    line1: `${answered} of ${settled} paid calls by vet402 answered with 2xx · 30 days`,
    line2,
    aria:
      `vet402 measured ${host}: of the ${settled} paid calls vet402 made in the 30 days to ${date}, ` +
      `${answered} were answered with a 2xx other than 202. ${detail}`,
  };
}

export function hostBadgeWidth(line1: string, line2: string): number {
  const right = Math.max(
    130,
    Math.ceil(line1.length * CHAR_W) + PAD,
    Math.ceil(line2.length * SUB_CHAR_W) + PAD,
  );
  return MARK_W + right;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderHostBadgeSvg(badge: HostBadge): string {
  const aria = xmlEscape(badge.aria);
  const line1 = xmlEscape(badge.line1);
  const line2 = xmlEscape(badge.line2);
  const total = hostBadgeWidth(badge.line1, badge.line2);
  const rightW = total - MARK_W;
  const h = HOST_BADGE_HEIGHT;
  const cx = MARK_W + rightW / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${h}" role="img" aria-label="${aria}">
  <title>${aria}</title>
  <rect width="${total}" height="${h}" rx="4" fill="${LEFT}"/>
  <rect x="${MARK_W}" width="${rightW}" height="${h}" rx="4" fill="${RIGHT}"/>
  <rect x="${MARK_W}" width="6" height="${h}" fill="${RIGHT}"/>
  <text x="29" y="23" text-anchor="middle" font-family="Verdana,sans-serif" font-size="11" fill="#ffffff">vet402</text>
  <text x="${cx}" y="16" text-anchor="middle" font-family="Verdana,sans-serif" font-size="10" fill="#ffffff">${line1}</text>
  <text x="${cx}" y="30" text-anchor="middle" font-family="Verdana,sans-serif" font-size="9" fill="#eeeeee">${line2}</text>
</svg>`;
}
