import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { nearAiDayPayload, nearAiDayRootHash } from "@/lib/nearai/anchors";
import { getNearAiStore } from "@/lib/nearai/store";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";

export const dynamic = "force-dynamic";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`nearai-anchors-day:${ip}`, 30, 60_000);
  const perCaller = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }
  const day = request.nextUrl.searchParams.get("day")?.trim() ?? "";
  if (!DAY_RE.test(day)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: perCaller });
  }
  try {
    const store = getNearAiStore();
    const sealed = await store.getDaySeal(day);
    const prevRoot = sealed?.prevRoot ?? (await store.latestRootBefore(day));
    const rows = await store.getAnchorRowsForDay(day);
    const livePayload = nearAiDayPayload(day, rows);
    const liveRootHash = nearAiDayRootHash(prevRoot, day, rows);
    const payload = sealed?.payload ?? livePayload;
    const conflict = sealed !== null && (sealed.payload !== livePayload || sealed.rootHash !== liveRootHash);
    return NextResponse.json(
      {
        day,
        payload,
        rootHash: sealed?.rootHash ?? liveRootHash,
        prevRoot: prevRoot ?? "genesis",
        sealed: Boolean(sealed),
        ...(conflict ? { conflict: true as const } : {}),
      },
      { status: 200, headers: perCaller },
    );
  } catch (error) {
    logServerErrorSafe("nearai-anchors-day", error);
    return NextResponse.json({ error: "nearai_unavailable" }, { status: 503, headers: perCaller });
  }
}

const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);