import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import {
  TOKEN_POST_RL_LIMIT,
  TOKEN_POST_RL_WINDOW_MS,
  unsubscribeSubscription,
} from "@/lib/observatory/record-subscriptions";
import { readTokenBody } from "@/lib/observatory/subscription-token-body";
import { logServerError } from "@/lib/util/log";

/**
 * POST /api/v1/observatory/subscriptions/unsubscribe — 通知の配信停止（2026-09-28 監査）。
 * 2 つの呼び手:
 *   - /observatory/unsubscribe の「Unsubscribe」ボタン（JSON { id, token }）
 *   - メールソフトの one-click（RFC 8058）: この URL に ?id=&t= を付けて
 *     `List-Unsubscribe=One-Click` を form で POST してくる
 * GET は export しない（Next が 405）——スキャナが List-Unsubscribe の URL を踏んでも止まらない。
 * 冪等。行の有無を漏らさない。鍵なし。IP 30/時。
 */

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`record-unsubscribe:${ip}`, TOKEN_POST_RL_LIMIT, TOKEN_POST_RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }
  const body = await readTokenBody(request);
  if (!body) return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: perCaller });
  const id = body.id ?? request.nextUrl.searchParams.get("id") ?? "";
  const token = body.token ?? request.nextUrl.searchParams.get("t") ?? "";
  try {
    const result = await unsubscribeSubscription(id, token);
    if (!result.ok) {
      if (result.reason === "db_unavailable") {
        return NextResponse.json({ error: "subscribe_unavailable" }, { status: 503, headers: perCaller });
      }
      return NextResponse.json({ error: "invalid_token" }, { status: 400, headers: perCaller });
    }
    return NextResponse.json({ ok: true, status: "unsubscribed" }, { status: 200, headers: perCaller });
  } catch (error) {
    logServerError("record-subscription.unsubscribe", error);
    return NextResponse.json({ error: "subscribe_unavailable" }, { status: 503, headers: perCaller });
  }
}
