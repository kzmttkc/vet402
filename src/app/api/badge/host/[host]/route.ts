import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { hostBadgeCopy, renderHostBadgeSvg } from "@/lib/badge/host-badge";
import { getDb } from "@/lib/db/client";
import { sellerHostIsListed } from "@/lib/sellers/board";
import { parseSellerHostParam } from "@/lib/sellers/host";
import { readHostBadgeStats, readPurchasedHosts, readSellerBoard } from "@/lib/sellers/reader";
import { logServerErrorSafe } from "@/lib/util/log-safe";

const BADGE_LIMIT = 60;
const BADGE_WINDOW_MS = 60_000;

function svgResponse(svg: string, cache: string): NextResponse {
  return new NextResponse(svg, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": cache,
    },
  });
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, { params }: { params: Promise<{ host: string }> }) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`badge-host:${ip}`, BADGE_LIMIT, BADGE_WINDOW_MS);
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "rate_limited" },
      { status: 429, headers: ipRateLimitHeaders(limited) },
    );
  }

  const { host: raw } = await params;
  const host = parseSellerHostParam(raw.replace(/\.svg$/i, ""));
  if (!host) {
    return new NextResponse(null, { status: 404 });
  }

  const db = getDb();
  if (!db) {
    return new NextResponse(null, { status: 404 });
  }

  try {
    const [board, purchasedHosts] = await Promise.all([readSellerBoard(db), readPurchasedHosts(db)]);
    if (!sellerHostIsListed(host, board, purchasedHosts)) {
      return new NextResponse(null, { status: 404 });
    }
    const stats = await readHostBadgeStats(db, host);
    const badge = hostBadgeCopy({ host, settled: stats.settled, answered: stats.answered, asOfDate: utcToday() });
    return svgResponse(
      renderHostBadgeSvg(badge),
      "public, s-maxage=600, stale-while-revalidate=1200",
    );
  } catch (error) {
    logServerErrorSafe("badge_host", error);
    return new NextResponse(null, { status: 404 });
  }
}
