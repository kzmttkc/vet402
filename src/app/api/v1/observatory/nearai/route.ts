import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";
import { withNoindex } from "@/lib/api/public-read-robots";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { getNearAiStore } from "@/lib/nearai/store";

export const dynamic = "force-dynamic";

const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;
const CACHE = "public, s-maxage=300, stale-while-revalidate=600";

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`observatory-nearai:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = withNoindex(ipRateLimitHeaders(limited));
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }
  try {
    const snapshot = await getNearAiStore().getLatestPublicSnapshot();
    if (!snapshot) {
      return NextResponse.json({ error: "nearai_unavailable" }, { status: 503, headers: perCaller });
    }
    return NextResponse.json(snapshot, {
      status: 200,
      headers: { ...perCaller, "Cache-Control": CACHE, "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    logServerErrorSafe("observatory-nearai", error);
    return NextResponse.json({ error: "nearai_unavailable" }, { status: 503, headers: perCaller });
  }
}

const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);