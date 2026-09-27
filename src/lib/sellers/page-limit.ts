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

/** 通ってよければ null、上限なら 429 の応答。 */
export async function sellersRateLimitResponse(request: Request): Promise<NextResponse | null> {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`sellers-page:${ip}`, SELLERS_RL_LIMIT, SELLERS_RL_WINDOW_MS);
  if (limited.allowed) return null;
  const wait = limited.retryAfter ?? 60;
  return new NextResponse(`Too many requests. Please reload in about ${wait} seconds.\n`, {
    status: 429,
    headers: { ...ipRateLimitHeaders(limited), "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
