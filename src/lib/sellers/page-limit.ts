// /sellers の頁で共有する IP ごとの上限（鍵なしの公開面）。既存の consumeIpRateLimit を使う。
// 窓は 1 分・30 回。頁の本体は cached.ts の Data Cache から読むので、上限は DB を守るための線。
//
// 上限を超えた要求には HTTP 429 と Retry-After を返す（独立レビュー 2026-09-28）。頁（Server Component）は
// 状態コードを決められないので、判定は src/proxy.ts が頁の前で行う。
import { NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";

export const SELLERS_RL_LIMIT = 30;
export const SELLERS_RL_WINDOW_MS = 60_000;

/** /sellers とその下の頁か（/sellers-foo は含まない）。 */
export function isSellersPath(pathname: string): boolean {
  return pathname === "/sellers" || pathname.startsWith("/sellers/");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * 上限（または枠の判定不能）のときの HTML 頁（2026-09-29 監査 5 周目・WCAG 2.2）。
 * 人が開く頁なので text/plain ではなく、lang・title・viewport のある頁を返し、待ち時間と戻る導線を載せる。
 * スクリプトは持たない（CSP は default-src 'none' とインラインの style だけ）。API（/api/**）はここを通らず JSON のまま。
 */
export function rateLimitPageHtml(opts: { waitSeconds: number; unavailable?: boolean; path?: string }): string {
  const wait = Math.max(1, Math.ceil(opts.waitSeconds));
  const title = opts.unavailable ? "Temporarily unavailable" : "Too many requests";
  const lead = opts.unavailable
    ? "vet402 could not check the request limit just now, so this page was not loaded."
    : "This network has opened seller pages more than " + SELLERS_RL_LIMIT + " times in the last minute.";
  const retryHref = escapeHtml(opts.path && isSellersPath(opts.path) ? opts.path : "/sellers");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · vet402</title>
<style>
body{margin:0;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;color:#233456;background:#eef0f3}
main{max-width:36rem;margin:0 auto;padding:3rem 1rem}
h1{font-size:1.5rem;margin:0 0 1rem}
a{color:#233456;text-underline-offset:2px}
a:focus-visible{outline:3px solid #233456;outline-offset:2px}
ul{padding-left:1.25rem}
li{margin:.5rem 0}
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${lead}</p>
<p>Please wait about <strong>${wait} second${wait === 1 ? "" : "s"}</strong>, then reload.</p>
<ul>
<li><a href="${retryHref}">Try this page again</a></li>
<li><a href="/">Back to vet402 home</a></li>
<li><a href="/observatory">Open the observatory</a></li>
</ul>
</main>
</body>
</html>
`;
}

/** 通ってよければ null、上限なら 429（枠の判定不能なら 503）の HTML 頁。 */
export async function sellersRateLimitResponse(request: Request): Promise<NextResponse | null> {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`sellers-page:${ip}`, SELLERS_RL_LIMIT, SELLERS_RL_WINDOW_MS);
  if (limited.allowed) return null;
  const wait = limited.retryAfter ?? 60;
  let path = "/sellers";
  try {
    path = new URL(request.url).pathname;
  } catch {
    // 相対 URL などは既定の /sellers に戻す
  }
  return new NextResponse(rateLimitPageHtml({ waitSeconds: wait, unavailable: limited.unavailable, path }), {
    status: limited.unavailable ? 503 : 429,
    headers: {
      ...ipRateLimitHeaders(limited),
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
