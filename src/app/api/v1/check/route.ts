import { NextRequest } from "next/server";
import { handleCheck } from "@/lib/api/check-handler";
import { isKeylessRequest, recordClientUsage } from "@/lib/api/client-usage";
import { RESOLVE_KEYLESS_LIMIT, RESOLVE_KEYLESS_WINDOW_MS } from "@/lib/api/keyless-limits";
import { publicRateLimit } from "@/lib/api/public-route";
import { mcpDeps } from "@/lib/mcp/deps";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const gate = await publicRateLimit(request, "resolve", RESOLVE_KEYLESS_LIMIT, RESOLVE_KEYLESS_WINDOW_MS);
  if (!gate.ok) return gate.response;
  const res = await handleCheck(request, mcpDeps());
  if (res.status === 200 && isKeylessRequest(request.headers)) {
    recordClientUsage(request.headers, "rest:check");
  }
  const headers = new Headers(res.headers);
  const rateHeaders = res.status === 200 ? gate.cacheHeaders : gate.headers;
  for (const [k, v] of Object.entries(rateHeaders)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}
