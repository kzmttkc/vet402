import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import {
  consumeIpRateLimit,
  ipRateLimitHeaders,
  sharedCacheRateLimitHeaders,
} from "@/lib/api/ip-rate-limit";
import { getDecisionFeed } from "@/lib/observatory/decisions";
import { computeSpendGuardBacktest } from "@/lib/observatory/backtest";
import { logServerError } from "@/lib/util/log";

/**
 * GET /api/v1/observatory/decisions?days=30 — 実資金の判定フィード。
 * 日次L1が実際に下した「支払う/拒否する」を台帳から1:1写像で公開する
 * （src/lib/observatory/decisions.ts 冒頭）。新しい判定は作らない。
 * backtest（avoided/forgone両面）を累計として同梱。
 */

const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`observatory-decisions:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  const shared = sharedCacheRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }
  const daysParam = request.nextUrl.searchParams.get("days");
  const days = daysParam === null ? 30 : Number(daysParam);
  if (!Number.isFinite(days)) {
    return NextResponse.json({ error: "invalid_days" }, { status: 400, headers: perCaller });
  }
  try {
    const [feed, backtest] = await Promise.all([
      getDecisionFeed(days),
      computeSpendGuardBacktest(),
    ]);
    return NextResponse.json(
      {
        ...feed,
        cumulative: backtest,
        humanReadable: "https://vet402.com/decisions",
      },
      { headers: { ...shared, "Cache-Control": "public, s-maxage=900, stale-while-revalidate=1800" } },
    );
  } catch (error) {
    logServerError("observatory_decisions", error);
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  }
}
