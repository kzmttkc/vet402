import { NextResponse } from "next/server";
import { authenticateRequest } from "./auth";
import {
  consumeRateLimit,
  rateLimitHeaders,
  refundRateLimit,
  type RateLimitResult,
} from "./rate-limit";
import { logServerErrorSafe } from "@/lib/util/log-safe";

const RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SEC = 30;

export type AuthorizedContext = {
  apiKeyId: string;
  /** 鍵の持ち主（api-keys.ts ApiKeyRecord.ownerId）。古い呼び手・テストの形のために省略可。 */
  ownerId?: string;
  plan: string;
  rateLimit: RateLimitResult;
};

export type AuthenticatedContext = {
  apiKeyId: string;
  ownerId?: string;
  plan: string;
};

export async function authenticateApiRequest(
  request: Request,
): Promise<{ ok: true; ctx: AuthenticatedContext } | { ok: false; error: NextResponse }> {
  const auth = await authenticateRequest(request);
  if (!auth.ok) {
    return { ok: false, error: auth.error! };
  }

  return {
    ok: true,
    ctx: { apiKeyId: auth.apiKeyId!, ownerId: auth.ownerId, plan: auth.plan! },
  };
}

export async function applyRateLimit(
  ctx: AuthenticatedContext,
  units = 1,
): Promise<{ ok: true; rateLimit: RateLimitResult } | { ok: false; error: NextResponse }> {
  let rateLimit: RateLimitResult;
  try {
    rateLimit = await consumeRateLimit(ctx.apiKeyId, ctx.plan, units);
  } catch (error) {
    // 2026-09-29 監査4周目: 月次枠の DB が不通のとき、例外がそのまま鍵ありの全経路を 500 にしていた。
    // 枠を数えられないなら答えない（fail-closed）——ただし「使いすぎ」の 429 ではなく 503。
    logServerErrorSafe("rate_limit.consume_unavailable", error);
    return {
      ok: false,
      error: NextResponse.json(
        { error: "rate_limit_unavailable", retryAfter: RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SEC },
        { status: 503, headers: { "Retry-After": String(RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SEC) } },
      ),
    };
  }
  if (!rateLimit.allowed) {
    const headers = rateLimitHeaders(rateLimit);
    if (rateLimit.retryAfter) {
      headers["Retry-After"] = String(rateLimit.retryAfter);
    }

    return {
      ok: false,
      error: NextResponse.json(
        {
          error: "rate_limit_exceeded",
          retryAfter: rateLimit.retryAfter,
          usage: rateLimit.usage,
          limit: rateLimit.limit,
        },
        { status: 429, headers },
      ),
    };
  }

  return { ok: true, rateLimit };
}

export async function authorizeApiRequest(
  request: Request,
  units = 1,
): Promise<{ ok: true; ctx: AuthorizedContext } | { ok: false; error: NextResponse }> {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth;

  const limited = await applyRateLimit(auth.ctx, units);
  if (!limited.ok) return limited;

  return {
    ok: true,
    ctx: {
      apiKeyId: auth.ctx.apiKeyId,
      ownerId: auth.ctx.ownerId,
      plan: auth.ctx.plan,
      rateLimit: limited.rateLimit,
    },
  };
}

// 2026-08-15 (audit): credit back quota consumed by applyRateLimit()/
// authorizeApiRequest() when the caller's own downstream work then fails.
// Call from the `catch` branch only, after a reservation already succeeded.
export async function refundRateLimitUnits(
  ctx: AuthenticatedContext,
  units = 1,
): Promise<void> {
  await refundRateLimit(ctx.apiKeyId, ctx.plan, units);
}

export function withRateLimitHeaders(
  response: NextResponse,
  rateLimit: RateLimitResult,
): NextResponse {
  for (const [key, value] of Object.entries(rateLimitHeaders(rateLimit))) {
    response.headers.set(key, value);
  }
  return response;
}
