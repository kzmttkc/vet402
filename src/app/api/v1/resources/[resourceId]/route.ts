import { NextRequest, NextResponse } from "next/server";
import { publicRateLimit, PUBLIC_DISCLAIMER } from "@/lib/api/public-route";
import { SHA256_HEX_RE } from "@/lib/ids/canonical";
import { getResource, payeesByEndpoint } from "@/lib/resolve/lookup";
import { logServerError } from "@/lib/util/log";

// §9.1: GET /api/v1/resources/{resource_id} — Resource（§5 sha256）の参照。
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ resourceId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const gate = await publicRateLimit(request, "resources", 120);
  if (!gate.ok) return gate.response;
  const { resourceId } = await context.params;
  if (!SHA256_HEX_RE.test(resourceId)) {
    return NextResponse.json({ error: "invalid_resource_id" }, { status: 400, headers: gate.headers });
  }
  try {
    const resource = await getResource(resourceId);
    if (!resource) return NextResponse.json({ error: "not_found" }, { status: 404, headers: gate.headers });
    const payees = await payeesByEndpoint(resource.observatory_id);
    return NextResponse.json(
      {
        resource,
        payees,
        links: {
          decision: `/api/v1/resources/${resourceId}/decision?role=payer`,
          facts: `/api/v1/observatory/endpoints/${resource.observatory_id}/facts`,
          observatory: `/observatory/e/${resource.observatory_id}`,
        },
        disclaimer: PUBLIC_DISCLAIMER,
      },
      { headers: gate.cacheHeaders },
    );
  } catch (error) {
    logServerError("resources.get", error);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: gate.headers });
  }
}
