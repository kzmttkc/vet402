import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders, sharedCacheRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { readTraceableByChain } from "@/lib/observatory/traceable-by-chain";
import { logServerErrorSafe } from "@/lib/util/log-safe";

/**
 * GET /api/v1/observatory/traceable-by-chain（3.8b、2026-11-11）。鍵なし。
 * 公開の 10 鎖それぞれの、ホームと同じ粒度の辿れる settled 1 件。段ごとの一覧は分ける。
 * 例の無い鎖は chainsWithoutExample に名前を出し、新しい購入で埋めない。
 */

const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`observatory-traceable:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  const shared = sharedCacheRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }
  try {
    const body = await readTraceableByChain();
    if (!body) {
      return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
    }
    const cite = `KIZUNA Creation. vet402 observatory traceable purchases by chain, retrieved ${body.retrievedAt}. https://vet402.com/api/v1/observatory/traceable-by-chain`;
    return NextResponse.json(
      { ...body, license: "CC-BY-4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", cite },
      { headers: { ...shared, "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200" } },
    );
  } catch (error) {
    logServerErrorSafe("observatory_traceable_by_chain", error);
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  }
}
