import { NextRequest } from "next/server";
import { handleDiagnose } from "@/lib/api/diagnose-handler";
import { DIAGNOSE_KEYLESS_LIMIT, DIAGNOSE_KEYLESS_WINDOW_MS } from "@/lib/api/keyless-limits";
import { publicRateLimit } from "@/lib/api/public-route";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const gate = await publicRateLimit(request, "diagnose", DIAGNOSE_KEYLESS_LIMIT, DIAGNOSE_KEYLESS_WINDOW_MS);
  if (!gate.ok) return gate.response;
  const res = await handleDiagnose(request);
  const headers = new Headers(res.headers);
  const cacheable = res.status === 200 && headers.get("cache-control") !== "no-store";
  const rateHeaders = cacheable ? gate.cacheHeaders : gate.headers;
  for (const [key, value] of Object.entries(rateHeaders)) headers.set(key, value);
  return new Response(res.body, { status: res.status, headers });
}
