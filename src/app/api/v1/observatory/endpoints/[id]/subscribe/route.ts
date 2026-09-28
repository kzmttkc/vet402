import { NextRequest, NextResponse } from "next/server";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit, ipRateLimitHeaders } from "@/lib/api/ip-rate-limit";
import {
  SUBSCRIBE_RL_LIMIT,
  SUBSCRIBE_RL_WINDOW_MS,
  forwardDispute,
  submitSubscription,
  validateSubscription,
} from "@/lib/observatory/record-subscriptions";
import { logServerErrorSafe } from "@/lib/util/log-safe";

/**
 * POST /api/v1/observatory/endpoints/[id]/subscribe — 段 2「名前を取る」。
 * キー不要。IP 制限 5/時。body: { email, kind: "notify"|"dispute", reason?, website? (honeypot) }
 * 同一 email × endpoint × kind は upsert。応答に受付番号（id の先頭 8 桁）。
 * kind=dispute は受付時に support へ転送する（送信未設定なら記録だけ残り、ログに出る）。
 * 2026-09-28 監査: kind=notify は pending で受け、確認メールを 1 通だけ送る（ダブルオプトイン）。
 * 応答は確定済みか・未確定かで変えない（第三者が宛先の購読状況を引けないように）。
 * 変わるのは送信経路が落ちている時だけ（購読状態とは無関係の事実）。
 */

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const ip = getClientIp(request) ?? "unknown";
  const limited = await consumeIpRateLimit(`record-subscribe:${ip}`, SUBSCRIBE_RL_LIMIT, SUBSCRIBE_RL_WINDOW_MS);
  const perCaller = ipRateLimitHeaders(limited);
  if (!limited.allowed) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: perCaller });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: perCaller });
  }
  const validated = validateSubscription({ ...body, endpointId: id });
  if (!validated.ok) {
    return NextResponse.json({ error: validated.reason }, { status: 400, headers: perCaller });
  }
  try {
    const result = await submitSubscription(validated.value, ip);
    if (!result.ok) {
      const status = result.reason === "endpoint_not_found" ? 404 : 503;
      return NextResponse.json({ error: result.reason }, { status, headers: perCaller });
    }
    if (validated.value.kind === "dispute" && validated.value.reason) {
      await forwardDispute({
        receipt: result.receipt,
        endpointId: validated.value.endpointId,
        email: validated.value.email,
        reason: validated.value.reason,
        lastVerdict: result.lastVerdict,
      });
    }
    const mailDown = result.confirmation === "mail_unset" || result.confirmation === "mail_failed";
    return NextResponse.json(
      {
        ok: true,
        receipt: result.receipt,
        kind: validated.value.kind,
        verdictAtSubmission: result.lastVerdict,
        ...(validated.value.kind === "notify"
          ? { confirmation: mailDown ? "not_sent" : "check_inbox" }
          : {}),
        note:
          validated.value.kind === "notify"
            ? mailDown
              ? "The confirmation email could not be sent right now. Nothing will be sent to this address until it is confirmed; submit again later."
              : "If this address is not yet confirmed for this record, a confirmation email is on its way. Nothing is sent until you press Confirm on the linked page; after that, one email per verdict change."
            : "A person reads this. Records are never deleted on dispute — corrections publish with the same weight.",
      },
      { status: 201, headers: perCaller },
    );
  } catch (error) {
    logServerErrorSafe("record-subscribe", error);
    return NextResponse.json({ error: "subscribe_unavailable" }, { status: 503, headers: perCaller });
  }
}
