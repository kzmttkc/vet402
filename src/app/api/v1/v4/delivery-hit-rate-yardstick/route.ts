import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import {
  consumeIpRateLimit,
  ipRateLimitHeaders,
  sharedCacheRateLimitHeaders,
} from "@/lib/api/ip-rate-limit";
import { withNoindex } from "@/lib/api/public-read-robots";
import {
  loadDeliveryHitRateYardstick,
  publicDeliveryHitRateYardstick,
  validateYardstickAgainstRepurchaseBoundary,
} from "@/lib/v4/delivery-hit-rate-yardstick";

const RL_LIMIT = 60;
const RL_WINDOW_MS = 60_000;

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/v4/delivery-hit-rate-yardstick — S1-2 delivery hit-rate yardstick (pre-registered).
 * Not the Gate2 PMF signup table. Not a marketing hit-rate read.
 */
export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`v4-yardstick:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = withNoindex(ipRateLimitHeaders(limited));
  const shared = withNoindex(sharedCacheRateLimitHeaders(limited));
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }

  const doc = loadDeliveryHitRateYardstick();
  validateYardstickAgainstRepurchaseBoundary(doc);
  const retrievedAt = new Date().toISOString();
  return NextResponse.json(
    {
      ...publicDeliveryHitRateYardstick(doc),
      retrievedAt,
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
      cite: `KIZUNA Creation. vet402 delivery hit-rate yardstick, retrieved ${retrievedAt}. https://vet402.com/api/v1/v4/delivery-hit-rate-yardstick`,
    },
    { headers: shared },
  );
}
