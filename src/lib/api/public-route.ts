// ============================================================
// キー不要の公開読み取りルート共通部（§7.3 逆引き・§9.1 facts / census）。
// IP レート制限と共有キャッシュヘッダを 1 箇所に置く（anchors ルートと同じ形）。
// ============================================================
import { NextResponse, type NextRequest } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders, sharedCacheRateLimitHeaders } from "@/lib/api/ip-rate-limit";

export const PUBLIC_DISCLAIMER =
  "Scores are opinions; L0–L2 are measurement records. This is not credit assessment, KYC, sanctions screening, or certification.";

export type PublicGate =
  | { ok: true; headers: Record<string, string>; cacheHeaders: Record<string, string> }
  | { ok: false; response: NextResponse };

export async function publicRateLimit(
  request: NextRequest,
  bucket: string,
  limit = 60,
  windowMs = 60_000,
): Promise<PublicGate> {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`${bucket}:${ip}`, limit, windowMs);
  const headers = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return { ok: false, response: NextResponse.json({ error: "rate_limited" }, { status: 429, headers }) };
  }
  return {
    ok: true,
    headers,
    cacheHeaders: {
      ...sharedCacheRateLimitHeaders(limited),
      "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
    },
  };
}
