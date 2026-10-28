import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { exportBusyResponse, rejectUnknownQuery } from "@/lib/api/export-guard";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { getDb } from "@/lib/db/client";
import { getDeliverySellersFeedCached } from "@/lib/delivery/cached";
import { DeliveryFeedExportBusy } from "@/lib/delivery/sellers-feed-cache";
import {
  DELIVERY_FEED_LICENSE,
  DELIVERY_FEED_LICENSE_URL,
  DELIVERY_FEED_RATE_PER_MIN,
} from "@/lib/delivery/sellers-feed";
import { parseDeliverySellersQuery } from "@/lib/delivery/sellers-feed-query";
import { logServerErrorSafe } from "@/lib/util/log-safe";

/**
 * GET /api/v1/delivery/sellers.json — 直近 30 日に vet402 が払った試行のある掲載中出品（2026-10-28）。
 * 鍵なし・読むだけ。CC BY 4.0。
 */

const RL_LIMIT = DELIVERY_FEED_RATE_PER_MIN;
const RL_WINDOW_MS = 60_000;
const ALLOWED_QUERY = ["network", "min_delivered", "listed_in", "cursor"] as const;

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`delivery-sellers:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    const status = limited.unavailable ? 503 : 429;
    return NextResponse.json(
      { error: limited.unavailable ? "temporarily_unavailable" : "rate_limited" },
      { status, headers: perCaller },
    );
  }

  const badQuery = rejectUnknownQuery(request.nextUrl.searchParams, [...ALLOWED_QUERY], perCaller);
  if (badQuery) return badQuery;

  const parsed = parseDeliverySellersQuery(request.nextUrl.searchParams);
  if (parsed === "invalid") {
    return NextResponse.json({ error: "invalid_query", allowed: [...ALLOWED_QUERY] }, { status: 400, headers: perCaller });
  }

  if (!getDb()) {
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  }

  try {
    const body = await getDeliverySellersFeedCached(parsed);
    const retrievedAt = body.as_of;
    return NextResponse.json(body, {
      headers: {
        ...perCaller,
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        "x-robots-tag": "noindex",
        "x-vet402-license": DELIVERY_FEED_LICENSE,
        "x-vet402-retrieved-at": retrievedAt,
        Link: [
          `<${DELIVERY_FEED_LICENSE_URL}>; rel="license"`,
          `<https://vet402.com/docs/mcp#feed>; rel="describedby"`,
        ].join(", "),
      },
    });
  } catch (error) {
    if (error instanceof DeliveryFeedExportBusy) {
      return exportBusyResponse(error, perCaller);
    }
    logServerErrorSafe("delivery.sellers", error);
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: perCaller });
  }
}
