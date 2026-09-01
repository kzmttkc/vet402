import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import { enqueueVerificationRequest } from "@/lib/observatory/requests";
import { logServerError } from "@/lib/util/log";

/**
 * POST /api/v1/observatory/requests — 検証リクエストの受付（C9・無償）。
 * 実測定は日次 L0 cron がキュー先頭から消化する（trigger: "request" として
 * 通常のプローブ行に記帳）。リクエストは順番を早めるだけで、判定の
 * ゲート・語彙は普段の測定と完全に同一。
 */

const RL_LIMIT = 5;
const RL_WINDOW_MS = 60_000;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`verify-requests:${ip}`, RL_LIMIT, RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }
  let endpointId: unknown;
  try {
    endpointId = ((await request.json()) as { endpointId?: unknown })?.endpointId;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: perCaller });
  }
  if (typeof endpointId !== "string" || endpointId.length === 0) {
    return NextResponse.json({ error: "endpoint_id_required" }, { status: 400, headers: perCaller });
  }
  try {
    const result = await enqueueVerificationRequest({ endpointId, requesterIp: ip });
    if (!result.ok) {
      const status =
        result.reason === "endpoint_not_found" ? 404 : result.reason === "db_unavailable" ? 503 : 400;
      return NextResponse.json({ error: result.reason }, { status, headers: perCaller });
    }
    return NextResponse.json(
      {
        ok: true,
        id: result.id,
        deduped: result.deduped,
        note: "Queued. The next daily probe run measures queued endpoints first; results publish through the normal gate.",
      },
      { status: result.deduped ? 200 : 201, headers: perCaller },
    );
  } catch (error) {
    logServerError("verify_requests", error);
    return NextResponse.json({ error: "requests_unavailable" }, { status: 503, headers: perCaller });
  }
}
