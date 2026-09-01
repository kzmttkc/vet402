import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import {
  consumeIpRateLimit,
  ipRateLimitHeaders,
  sharedCacheRateLimitHeaders,
} from "@/lib/api/ip-rate-limit";
import { computeConcentration } from "@/lib/observatory/concentration";
import { logServerError } from "@/lib/util/log";

/**
 * GET /api/v1/observatory/concentration — 受取構造の集計（名指しゼロ）。
 * 週次レポート・研究引用向けの facts-only 面（concentration.ts 冒頭）。
 */
const RL_LIMIT = 12;
const RL_WINDOW_MS = 60_000;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`observatory-concentration:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  const shared = sharedCacheRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }
  try {
    const c = await computeConcentration();
    if (!c) return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
    return NextResponse.json(
      { ...c, humanReadable: "https://vet402.com/observatory/state" },
      { headers: { ...shared, "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200" } },
    );
  } catch (error) {
    logServerError("observatory_concentration", error);
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  }
}
