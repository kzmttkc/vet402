/**
 * Microsoft Clarity（2026-10-31 オーナー承認）。純粋な判定と、window.clarity の呼び方だけを置く。
 *
 * - Project ID は NEXT_PUBLIC_CLARITY_PROJECT_ID。無い・形が違うなら null を返し、呼び出し側は何も出さない。
 * - 同意が要る地域: EEA（EU 27 か国と IS・LI・NO）・UK・スイス。Clarity 自身が 2025-10-31 から
 *   この 3 地域に同意の信号を求めている（learn.microsoft.com/clarity/setup-and-installation/consent-mode）。
 *   国が分からないときは同意が要る側に倒す。
 * - 同意が要る地域では、選ぶ前はタグそのものを読み込まない（Clarity の no-consent mode でも
 *   cookie 無しで記録は続くため、「同意まで記録しない」にはタグを入れないことが要る）。
 * - consentv2 の形は公式（clarity-consent-api-v2）。広告は使わないので ad_Storage は全員に denied を送る
 *   （同意の要らない地域でも送る。Clarity の第三者 cookie の一部は Microsoft の広告用で、vet402 はそれを頼まない）。
 */

export const CLARITY_CONSENT_COOKIE = "vet402_analytics_consent";
/** 選択を覚える期間。180 日。 */
export const CLARITY_CONSENT_MAX_AGE = 60 * 60 * 24 * 180;
/** Privacy choices のボタンが帯を開き直すためのイベント名。 */
export const PRIVACY_CHOICES_EVENT = "vet402:privacy-choices";

export type ConsentChoice = "granted" | "denied";

/** Clarity の Project ID は英小文字と数字の短い列。それ以外は挿入しない。 */
export function clarityProjectId(raw: string | undefined | null): string | null {
  const id = (raw ?? "").trim();
  return /^[a-z0-9]{6,20}$/i.test(id) ? id : null;
}

// EU 27 か国 + EEA の 3 か国（IS・LI・NO）+ UK + スイス。ISO 3166-1 alpha-2。
const CONSENT_REQUIRED = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT",
  "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  "IS", "LI", "NO",
  "GB", "CH",
]);

/**
 * 同意が要るか。Vercel の x-vercel-ip-country を渡す。
 * 無い・2 文字の国名でない・XX（不明）・T1（Tor）などは true（要る側）。
 */
export function consentRequiredFor(country: string | null | undefined): boolean {
  const c = (country ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return true;
  if (c === "XX" || c === "EU") return true;
  if (CONSENT_REQUIRED.has(c)) return true;
  // ISO の国名として割り当てのない値（Tor の T1 など）は上の正規表現で落ちる。
  return false;
}

export function parseConsentChoice(value: string | null | undefined): ConsentChoice | null {
  return value === "granted" || value === "denied" ? value : null;
}

export function clarityPlan(input: {
  consentRequired: boolean;
  choice: ConsentChoice | null;
  gpc: boolean;
}): { load: boolean; banner: boolean } {
  if (input.choice === "granted") return { load: true, banner: false };
  if (input.choice === "denied") return { load: false, banner: false };
  if (input.consentRequired) return { load: false, banner: true };
  // 同意の要らない地域の既定は記録する。ただし Global Privacy Control を出しているブラウザは断ったものとして扱う。
  return { load: !input.gpc, banner: false };
}

type ClarityFn = ((...args: unknown[]) => void) & { q?: unknown[][] };
type ClarityWindow = { clarity?: ClarityFn };

/**
 * 公式スニペットと同じ queue の stub を置き、タグを 1 回だけ入れる。
 * タグより先に consentv2（analytics granted / ad denied）を積む。読み込むのは
 * 「同意が要る地域で Accept した」か「同意の要らない地域で断っていない」時だけなので、
 * analytics は granted、広告はどの地域でも denied。
 */
export function startClarity(
  env: { win: ClarityWindow; insertScript: (src: string) => void },
  projectId: string,
): void {
  const { win } = env;
  const already = typeof win.clarity === "function";
  if (!already) {
    const stub: ClarityFn = function (...args: unknown[]) {
      (stub.q = stub.q || []).push(args);
    } as ClarityFn;
    win.clarity = stub;
  }
  win.clarity!("consentv2", { ad_Storage: "denied", analytics_Storage: "granted" });
  if (!already) env.insertScript(`https://www.clarity.ms/tag/${projectId}`);
}

/** 読み込み済みなら、denied を送り、Clarity の cookie を消し、この頁の記録を止める。 */
export function stopClarity(win: ClarityWindow): void {
  if (typeof win.clarity !== "function") return;
  win.clarity("consentv2", { ad_Storage: "denied", analytics_Storage: "denied" });
  win.clarity("consent", false);
  win.clarity("stop");
}

/**
 * CSP に足す読み込み先。公式（clarity-csp）の *.clarity.ms と c.bing.com。
 * script-src は strict-dynamic 下では host が無視されるが、CSP2 の旧ブラウザ向けに置く。
 */
export function clarityCspSources(): { script: string; connect: string; img: string } {
  return {
    script: "https://*.clarity.ms",
    connect: "https://*.clarity.ms https://c.bing.com",
    img: "https://*.clarity.ms https://c.bing.com",
  };
}

/** HTML の頁か。API・MCP・.well-known・拡張子のあるファイル（csv / json / xml / txt …）は頁ではない。 */
export function isHtmlPagePath(pathname: string): boolean {
  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) return false;
  if (pathname.startsWith("/api/") || pathname === "/api") return false;
  if (pathname.startsWith("/.well-known/")) return false;
  const last = pathname.split("/").pop() ?? "";
  return !last.includes(".");
}
