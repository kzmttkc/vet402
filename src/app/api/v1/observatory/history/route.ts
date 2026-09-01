import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import {
  consumeIpRateLimit,
  ipRateLimitHeaders,
  sharedCacheRateLimitHeaders,
} from "@/lib/api/ip-rate-limit";
import { getDailyMetricsHistory } from "@/lib/observatory/metrics-rollup";
import { logServerError } from "@/lib/util/log";

/**
 * GET /api/v1/observatory/history?days=30 — 日次メトリクス履歴、データとして。
 *
 * /observatory/state の履歴チャートと同じリーダー（getDailyMetricsHistory）
 * を読む——ページとAPIが食い違えない構造は state と同じ。日×チェーンの
 * L0/L1集計で、language は数と分母のみ。days は 1..366 に飽和。
 */

const RL_LIMIT = 30;
const RL_WINDOW_MS = 60_000;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`observatory-history:${ip}`, RL_LIMIT, RL_WINDOW_MS);
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
    const rows = await getDailyMetricsHistory(days);
    return NextResponse.json(
      {
        days: rows,
        disclaimer:
          "Daily L0/L1 aggregates per chain, rolled up from the same raw measurements the Observatory publishes. Counts with denominators, not an assessment. Chain 'unknown' means the catalog row declares no network.",
        humanReadable: "https://vet402.com/observatory/state",
        methodology: "https://vet402.com/observatory/methodology",
      },
      {
        headers: {
          ...shared,
          // Rolled up daily — 1h shared cache keeps the CDN in front.
          "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=7200",
        },
      },
    );
  } catch (error) {
    logServerError("observatory_history", error);
    return NextResponse.json(
      { error: "observatory_unavailable" },
      { status: 503, headers: perCaller },
    );
  }
}
