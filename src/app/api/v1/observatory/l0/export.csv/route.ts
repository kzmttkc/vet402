import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { L0_EXPORT_COLUMN_NOTES, L0_EXPORT_COLUMNS, readL0Export } from "@/lib/observatory/l0-export";
import { csvLines } from "@/lib/util/csv-write";
import { logServerErrorSafe } from "@/lib/util/log-safe";

/**
 * GET /api/v1/observatory/l0/export.csv — 出品ごとの最新の L0 公開判定（2026-09-29 監査 5 周目・データ記者の立場）。
 *
 * /api/v1/observatory/state の L0 の件数（publishedPass・publishedPassActive・…・byChain）の元データ。
 * 母集団と規則は state と同じ（l0-export.ts）。1 行 = 記録のある出品 1 つ（掲載落ちを含む・運営自身の endpoint を除く）。
 */

const RL_LIMIT = 6;
const RL_WINDOW_MS = 60_000;

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`observatory-l0-export:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    const status = limited.unavailable ? 503 : 429;
    return NextResponse.json({ error: limited.unavailable ? "temporarily_unavailable" : "rate_limited" }, { status, headers: perCaller });
  }
  try {
    const read = await readL0Export();
    if (!read) return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
    return new NextResponse(csvLines(L0_EXPORT_COLUMNS, read.rows), {
      headers: {
        ...perCaller,
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="vet402-l0-latest.csv"',
        "x-vet402-license": "CC-BY-4.0",
        "x-vet402-retrieved-at": read.fetchedAt,
        "x-vet402-rows": String(read.rows.length),
        "x-vet402-column-notes": L0_EXPORT_COLUMN_NOTES,
        Link:
          '<https://creativecommons.org/licenses/by/4.0/>; rel="license", ' +
          '<https://vet402.com/observatory/methodology>; rel="describedby"',
        "Cache-Control": "public, s-maxage=900, stale-while-revalidate=1800",
      },
    });
  } catch (error) {
    logServerErrorSafe("observatory_l0_export", error);
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  }
}
