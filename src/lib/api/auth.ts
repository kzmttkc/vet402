import { NextResponse } from "next/server";
import { consumeIpRateLimit, getClientIp } from "@/lib/api/ip-rate-limit";
import { ensureProductionConfig, isDevApiKeyEnabled } from "@/lib/config/env";
import { verifyApiKey } from "@/lib/db/api-keys";
import { secureCompare } from "@/lib/util/secure-compare";

const PLAN_LIMITS: Record<string, number> = {
  free: 1_000,
  pro: 50_000,
  scale: 500_000,
};

const AUTH_FAIL_LIMIT = 60;
const AUTH_FAIL_WINDOW_MS = 60_000;

async function enforceAuthIpLimit(ip: string): Promise<NextResponse | null> {
  const limited = await consumeIpRateLimit(
    `auth_fail:${ip}`,
    AUTH_FAIL_LIMIT,
    AUTH_FAIL_WINDOW_MS,
  );
  if (!limited.allowed) {
    return NextResponse.json(
      { error: "rate_limit_exceeded", retryAfter: limited.retryAfter },
      { status: 429 },
    );
  }
  return null;
}

// 2026-09-02 敵対的監査 P2: 401 の本文に「次に何をすればよいか」が無かった。
// コードは変えず、案内だけ添える（生成クライアントは error だけを読む）。
const MISSING_API_KEY_BODY = {
  error: "missing_api_key",
  documentation: "/docs/api",
  signup: "/signup",
} as const;

export async function authenticateRequest(request: Request): Promise<{
  ok: boolean;
  apiKeyId?: string;
  plan?: string;
  error?: NextResponse;
}> {
  ensureProductionConfig();

  const ip = getClientIp(request);
  const auth = request.headers.get("authorization");

  if (!auth?.startsWith("Bearer ")) {
    const limited = await enforceAuthIpLimit(ip);
    if (limited) return { ok: false, error: limited };
    return {
      ok: false,
      error: NextResponse.json(MISSING_API_KEY_BODY, { status: 401 }),
    };
  }

  const token = auth.slice("Bearer ".length).trim();
  if (!token) {
    const limited = await enforceAuthIpLimit(ip);
    if (limited) return { ok: false, error: limited };
    return {
      ok: false,
      error: NextResponse.json(MISSING_API_KEY_BODY, { status: 401 }),
    };
  }

  if (isDevApiKeyEnabled() && process.env.DEV_API_KEY && secureCompare(token, process.env.DEV_API_KEY)) {
    return { ok: true, apiKeyId: "dev", plan: "free" };
  }

  try {
    const record = await verifyApiKey(token);
    if (!record) {
      const limited = await enforceAuthIpLimit(ip);
      if (limited) return { ok: false, error: limited };
      return {
        ok: false,
        error: NextResponse.json({ error: "invalid_api_key" }, { status: 401 }),
      };
    }

    return { ok: true, apiKeyId: record.id, plan: record.plan };
  } catch {
    const limited = await enforceAuthIpLimit(ip);
    if (limited) return { ok: false, error: limited };
    return {
      ok: false,
      error: NextResponse.json({ error: "auth_unavailable" }, { status: 503 }),
    };
  }
}

export function getPlanLimit(plan = "free"): number {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
}
