import { NextRequest, NextResponse } from "next/server";
import { publicRateLimit, PUBLIC_DISCLAIMER } from "@/lib/api/public-route";
import { SHA256_HEX_RE } from "@/lib/ids/canonical";
import { getEndpoint, payeesByEndpoint } from "@/lib/resolve/lookup";
import { UUID_RE } from "@/lib/validation/uuid";
import { logServerError } from "@/lib/util/log";

// §7.3 / §9.1: GET /api/v1/endpoints/{endpoint_id}/payees — 店 → 受取ウォレット。
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ endpointId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const gate = await publicRateLimit(request, "endpoint-payees", 120);
  if (!gate.ok) return gate.response;
  const { endpointId } = await context.params;
  if (!SHA256_HEX_RE.test(endpointId) && !UUID_RE.test(endpointId)) {
    return NextResponse.json({ error: "invalid_endpoint_id" }, { status: 400, headers: gate.headers });
  }
  try {
    const endpoint = await getEndpoint(endpointId);
    if (!endpoint) return NextResponse.json({ error: "not_found" }, { status: 404, headers: gate.headers });
    const payees = await payeesByEndpoint(endpointId);
    return NextResponse.json(
      { endpoint_id: endpoint.endpoint_id, payees, count: payees.length, disclaimer: PUBLIC_DISCLAIMER },
      { headers: gate.cacheHeaders },
    );
  } catch (error) {
    logServerError("endpoints.payees", error);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: gate.headers });
  }
}
