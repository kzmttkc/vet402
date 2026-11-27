import { NextRequest } from "next/server";
import { handleCheck } from "@/lib/api/check-handler";
import {
  isKeylessRequest,
  recordClientUsage,
  recordRateLimitedClientUsage,
  type ClientUsageRoute,
} from "@/lib/api/client-usage";
import { scheduleKeylessCallerRecord } from "@/lib/api/keyless-callers";
import { RESOLVE_KEYLESS_LIMIT, RESOLVE_KEYLESS_WINDOW_MS } from "@/lib/api/keyless-limits";
import { rateLimitPolicyHeader } from "@/lib/api/ip-rate-limit";
import { publicRateLimit } from "@/lib/api/public-route";
import { mcpDeps } from "@/lib/mcp/deps";
import type { CheckSellerDeps } from "@/lib/mcp/tools";
import { warmResponseSigningKey } from "@/lib/signing/response-signature";

warmResponseSigningKey();

const KEYLESS_POLICY = rateLimitPolicyHeader(RESOLVE_KEYLESS_LIMIT, RESOLVE_KEYLESS_WINDOW_MS);

function withPolicy(headers: Record<string, string>): Record<string, string> {
  return { ...headers, "RateLimit-Policy": KEYLESS_POLICY };
}

/**
 * Shared keyless handler for GET /api/v1/check, GET /api/v1/decision and POST /api/v1/check/presign
 * （同じ IP の枠・同じ数え方。presign は handler だけ差し替える）。
 */
export async function handleKeylessCheckRoute(
  request: NextRequest,
  usageRoute: ClientUsageRoute,
  handler: (request: NextRequest, deps: CheckSellerDeps) => Promise<Response> = handleCheck,
): Promise<Response> {
  const gate = await publicRateLimit(request, "resolve", RESOLVE_KEYLESS_LIMIT, RESOLVE_KEYLESS_WINDOW_MS);
  if (!gate.ok) {
    if (gate.response.status === 429) recordRateLimitedClientUsage(usageRoute);
    const h = new Headers(gate.response.headers);
    h.set("RateLimit-Policy", KEYLESS_POLICY);
    h.set("Cache-Control", "private, no-store");
    return new Response(gate.response.body, { status: gate.response.status, headers: h });
  }

  const keyless = isKeylessRequest(request.headers);

  const usage: { network?: string } = {};
  const deps = {
    ...mcpDeps(),
    captureUsageNetwork: (network: string) => {
      usage.network = network;
    },
  };
  const res = await handler(request, deps);
  if (res.status === 200 && keyless) {
    recordClientUsage(request.headers, usageRoute, usage.network);
    // 週ごとの呼び手の数（/stats/keyless-callers）は check と decision だけを数える（公開の説明どおり）。
    if (usageRoute === "rest:check" || usageRoute === "rest:decision") scheduleKeylessCallerRecord(request.headers);
  }

  const headers = new Headers(res.headers);
  const rateHeaders = withPolicy(gate.headers);
  for (const [k, v] of Object.entries(rateHeaders)) headers.set(k, v);
  headers.set("Cache-Control", "private, no-store");
  return new Response(res.body, { status: res.status, headers });
}
