import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import {
  TOKEN_POST_RL_LIMIT,
  TOKEN_POST_RL_WINDOW_MS,
  confirmSubscription,
} from "@/lib/observatory/record-subscriptions";
import { readTokenBody } from "@/lib/observatory/subscription-token-body";
import { logServerError } from "@/lib/util/log";

/**
 * POST /api/v1/observatory/subscriptions/confirm — ダブルオプトインの確定（2026-09-28 監査）。
 * body: { token }（JSON か form）。確認メールのリンク先 /observatory/confirm の「Confirm」ボタンだけが叩く。
 * GET は export しない（Next が 405 を返す）——リンクスキャナが URL を踏んでも確定しない。
 * トークンは 1 回限り・72 時間。鍵なし。IP 30/時。
 */

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`record-confirm:${ip}`, TOKEN_POST_RL_LIMIT, TOKEN_POST_RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }
  const body = await readTokenBody(request);
  if (!body) return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: perCaller });
  try {
    const result = await confirmSubscription(body.token ?? "");
    if (!result.ok) {
      if (result.reason === "db_unavailable") {
        return NextResponse.json({ error: "subscribe_unavailable" }, { status: 503, headers: perCaller });
      }
      return NextResponse.json({ error: "invalid_token" }, { status: 400, headers: perCaller });
    }
    return NextResponse.json({ ok: true, status: "confirmed" }, { status: 200, headers: perCaller });
  } catch (error) {
    logServerError("record-subscription.confirm", error);
    return NextResponse.json({ error: "subscribe_unavailable" }, { status: 503, headers: perCaller });
  }
}
