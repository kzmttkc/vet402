/**
 * Microsoft Clarity（2026-10-31 オーナー承認）。純粋な判定と、window.clarity の呼び方だけを置く。
 *
 * - Project ID は NEXT_PUBLIC_CLARITY_PROJECT_ID。無い・形が違うなら null を返し、呼び出し側は何も出さない。
 * - 同意が要る地域: EEA（EU 27 か国・その海外の地域・IS・LI・NO）・UK（王室属領と GI を含む）・スイス。
 *   Clarity 自身が 2025-10-31 からこの 3 地域に同意の信号を求めている
 *   （learn.microsoft.com/clarity/setup-and-installation/consent-mode）。国が分からないときは同意が要る側に倒す。
 * - 同意が要る地域では、選ぶ前はタグそのものを読み込まない（Clarity の no-consent mode でも
 *   cookie 無しで記録は続くため、「同意まで記録しない」にはタグを入れないことが要る）。
 * - consentv2 の形は公式（clarity-consent-api-v2）。広告は使わないので ad_Storage は全員に denied を送る。
 * - 撤回（読み込み済みでの Decline）は consentv2 を呼ばず、選択を cookie に書いた直後に頁を読み直す。
 *   clarity-js は denied を受けると約 250ms 後に cookie 無しで記録を再開し、頁を離れる時に送信するため
 *   （clarity-js の data/metadata.ts・core/unload.ts・data/upload.ts）。読み直した denied の頁はタグを入れず、
 *   clarity-js が残した _clck・_clsk を消す（2026-10-31 再点検 M1）。
 */

export const CLARITY_CONSENT_COOKIE = "vet402_analytics_consent";
/** 選択を覚える期間。180 日。 */
export const CLARITY_CONSENT_MAX_AGE = 60 * 60 * 24 * 180;
/** Privacy choices のボタンが帯を開き直すためのイベント名。 */
export const PRIVACY_CHOICES_EVENT = "vet402:privacy-choices";

/** 帯の文。地域で分ける（2026-10-31 独立点検 M3・逐語）。 */
export const BANNER_TEXT_CONSENT_REQUIRED =
  "vet402 would like to record how pages are used (clicks, scrolling, page layout) with Microsoft Clarity, to find what is hard to use. Page text, form fields and keys are masked. Nothing is recorded unless you accept.";
export const BANNER_TEXT_DEFAULT_ON =
  "vet402 records how pages are used (clicks, scrolling, page layout) with Microsoft Clarity, to find what is hard to use. Page text, form fields and keys are masked. Choose Decline to turn it off.";

export type ConsentChoice = "granted" | "denied";

/** Clarity の Project ID は英小文字と数字の短い列。それ以外は挿入しない。 */
export function clarityProjectId(raw: string | undefined | null): string | null {
  const id = (raw ?? "").trim();
  return /^[a-z0-9]{6,20}$/i.test(id) ? id : null;
}

// ISO 3166-1 alpha-2。
const CONSENT_REQUIRED = new Set([
  // EU 27 か国
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT",
  "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
  // EU の一部として別の国名コードを持つ地域（フランスの海外県・サン・マルタン、フィンランドのオーランド）
  "RE", "GP", "MQ", "GF", "YT", "MF", "AX",
  // EEA の 3 か国
  "IS", "LI", "NO",
  // UK と、GDPR 相当の法を自前で持つジブラルタル・王室属領（ジャージー・ガーンジー・マン島）
  "GB", "GI", "JE", "GG", "IM",
  // スイス
  "CH",
]);

/**
 * 同意が要るか。Vercel の x-vercel-ip-country を渡す。
 * 無い・2 文字の国名でない・XX（不明）・EU・T1（Tor）などは true（要る側）。
 */
export function consentRequiredFor(country: string | null | undefined): boolean {
  const c = (country ?? "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return true;
  if (c === "XX" || c === "EU") return true;
  return CONSENT_REQUIRED.has(c);
}

export function parseConsentChoice(value: string | null | undefined): ConsentChoice | null {
  return value === "granted" || value === "denied" ? value : null;
}

/** document.cookie の文字列から選択を読む。 */
export function choiceFromCookieString(cookie: string | null | undefined): ConsentChoice | null {
  for (const part of (cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === CLARITY_CONSENT_COOKIE) return parseConsentChoice(v.join("="));
  }
  return null;
}

/**
 * 読み込むか・帯を出すか。
 * Global Privacy Control を出しているブラウザでは、選択に関わらず読み込まず帯も出さない
 * （clarity-js 自身も GPC では記録しない。ポリシーと同じ扱い）。
 */
export function clarityPlan(input: {
  consentRequired: boolean;
  choice: ConsentChoice | null;
  gpc: boolean;
}): { load: boolean; banner: boolean } {
  if (input.gpc) return { load: false, banner: false };
  if (input.choice === "granted") return { load: true, banner: false };
  if (input.choice === "denied") return { load: false, banner: false };
  if (input.consentRequired) return { load: false, banner: true };
  return { load: true, banner: false };
}

/**
 * Clarity を動かさない頁。
 * - トークンの頁 /observatory/confirm・/observatory/unsubscribe: メールのリンクが URL の # にトークンを載せる
 *   （src/lib/observatory/record-subscriptions.ts）。Clarity は頁の URL を送るので読み込まず、別の頁で
 *   動き出した Clarity のままここへ移ったら頁を読み直して止める。
 * - 凍結面 /rwa・/tokyo・/ethonline（tests/seo-audit-1026.test.ts）: 帯・フッターのリンク・タグを出さない
 *   だけ。読み直しはしない（トップから /ethonline へのリンクがあり、遷移ごとに読み直さない）。
 * どちらも proxy は CSP に Clarity を足さない。
 */
const TOKEN_PREFIXES = ["/observatory/confirm", "/observatory/unsubscribe"];
const FROZEN_PREFIXES = ["/rwa", "/tokyo", "/ethonline"];

function underAny(pathname: string | null | undefined, prefixes: string[]): boolean {
  const p = pathname ?? "";
  return prefixes.some((x) => p === x || p.startsWith(`${x}/`));
}

export function clarityTokenPath(pathname: string | null | undefined): boolean {
  return underAny(pathname, TOKEN_PREFIXES);
}

export function clarityFrozenPath(pathname: string | null | undefined): boolean {
  return underAny(pathname, FROZEN_PREFIXES);
}

export function clarityExcludedPath(pathname: string | null | undefined): boolean {
  return clarityTokenPath(pathname) || clarityFrozenPath(pathname);
}

type ClarityFn = ((...args: unknown[]) => void) & { q?: unknown[][] };
type ClarityWindow = { clarity?: ClarityFn };

export function clarityLoaded(win: ClarityWindow): boolean {
  return typeof win.clarity === "function";
}

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
  const already = clarityLoaded(win);
  if (!already) {
    const stub: ClarityFn = function (...args: unknown[]) {
      (stub.q = stub.q || []).push(args);
    } as ClarityFn;
    win.clarity = stub;
  }
  win.clarity!("consentv2", { ad_Storage: "denied", analytics_Storage: "granted" });
  if (!already) env.insertScript(`https://www.clarity.ms/tag/${projectId}`);
}

/** clarity-js が vet402.com に書く first-party cookie。 */
export const CLARITY_COOKIES = ["_clck", "_clsk"] as const;

/**
 * _clck・_clsk を期限切れにする cookie 文字列。clarity-js は書ける最上位のドメイン（vet402.com なら
 * .vet402.com）に書くので、その domain 付きとホスト名だけ（domain 無し）の両方を消す。
 */
export function clarityCookieExpiries(hostname: string): string[] {
  const out: string[] = [];
  const labels = hostname.split(".").filter(Boolean);
  const isIp = /^[0-9.]+$/.test(hostname) || hostname.includes(":");
  const top = !isIp && labels.length >= 2 ? labels.slice(-2).join(".") : null;
  for (const name of CLARITY_COOKIES) {
    out.push(`${name}=; Max-Age=0; Path=/`);
    if (top) out.push(`${name}=; Max-Age=0; Path=/; Domain=.${top}`);
  }
  return out;
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

// 頁ではないファイルの拡張子。/sellers/api.example.com のようにホスト名を含む頁は頁として扱う（独立点検 M1）。
const FILE_EXTENSIONS = new Set([
  "csv", "json", "jsonl", "ndjson", "xml", "txt", "md", "yaml", "yml", "rss", "atom",
  "png", "jpg", "jpeg", "gif", "webp", "avif", "svg", "ico", "pdf",
  "webmanifest", "js", "mjs", "css", "map", "woff", "woff2", "ttf", "otf",
  "wasm", "zip", "gz", "tgz",
]);

/** HTML の頁か。API・MCP・.well-known・既知の拡張子のファイルは頁ではない。 */
export function isHtmlPagePath(pathname: string): boolean {
  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) return false;
  if (pathname.startsWith("/api/") || pathname === "/api") return false;
  if (pathname.startsWith("/.well-known/")) return false;
  // /sellers/<host> は売り手のホスト名の頁。.md・.zip などの TLD でも頁（再点検 L2）。
  if (pathname.startsWith("/sellers/")) return true;
  const last = pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot < 0) return true;
  return !FILE_EXTENSIONS.has(last.slice(dot + 1).toLowerCase());
}

/** CSP に Clarity を足すか。頁であり、Clarity を動かさない頁でないこと。 */
export function clarityCspApplies(pathname: string): boolean {
  return isHtmlPagePath(pathname) && !clarityExcludedPath(pathname);
}
