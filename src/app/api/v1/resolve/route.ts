import { NextRequest, NextResponse } from "next/server";
import { publicRateLimit } from "@/lib/api/public-route";
import { resolve } from "@/lib/resolve/lookup";
import { logServerError } from "@/lib/util/log";

// §7.3 / §9.1: GET /api/v1/resolve?q={url|domain|address|tx|payee_id}
// キー不要。ID を持たない呼び手が「この URL / この受取先 / この tx は何か」を
// 1 回で引く入口。判定は返さない（それは /resources/{id}/decision）。
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const gate = await publicRateLimit(request, "resolve", 60);
  if (!gate.ok) return gate.response;
  const q = request.nextUrl.searchParams.get("q");
  if (!q || q.trim().length === 0 || q.length > 2048) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400, headers: gate.headers });
  }
  try {
    const result = await resolve(q);
    if (result.query.kind === "unknown") {
      return NextResponse.json({ error: "invalid_query", query: result.query }, { status: 400, headers: gate.headers });
    }
    return NextResponse.json(result, { headers: gate.cacheHeaders });
  } catch (error) {
    logServerError("resolve", error);
    return NextResponse.json({ error: "resolve_unavailable" }, { status: 503, headers: gate.headers });
  }
}
