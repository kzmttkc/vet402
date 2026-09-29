import { NextRequest, NextResponse } from "next/server";
import { publicRateLimit } from "@/lib/api/public-route";
import { resolve } from "@/lib/resolve/lookup";
import { ACCEPTED_QUERY_FORMS, classifyQuery, explainInvalidQuery } from "@/lib/resolve/classify";
import { logServerErrorSafe } from "@/lib/util/log-safe";

// §7.3 / §9.1: GET /api/v1/resolve?q={url|domain|address|tx|payee_id}[&method=GET|POST|…]
// キー不要。ID を持たない呼び手が「この URL / この受取先 / この tx は何か」を
// 1 回で引く入口。判定は返さない（それは /resources/{id}/decision）。
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const gate = await publicRateLimit(request, "resolve", 60);
  if (!gate.ok) return gate.response;
  const q = request.nextUrl.searchParams.get("q");
  // 2026-09-29 再監査（DX）: 400 の本文に原因（message）と直した q（suggestion）を載せる。
  // error / expected / query は従来どおり（既存の呼び手が見ている鍵を変えない）。
  const invalid = explainInvalidQuery(q);
  if (!q || invalid) {
    const body: Record<string, unknown> = {
      error: "invalid_query",
      expected: "q",
      message: invalid?.message ?? "q is required.",
      accepted: ACCEPTED_QUERY_FORMS,
      documentation: "https://vet402.com/docs/api#endpoints",
    };
    if (invalid?.suggestion) body.suggestion = invalid.suggestion;
    if (q && q.trim().length > 0 && q.length <= 2048) body.query = classifyQuery(q);
    return NextResponse.json(body, { status: 400, headers: gate.headers });
  }
  // 2026-09-29 監査 7 周目: `method`（任意）で URL の問いを 1 つの method に絞る。支払う側が
  // 「払う method の正規の resource_id」を得るため。英字 1〜10 文字以外は 400 invalid_method。
  const methodRaw = request.nextUrl.searchParams.get("method");
  if (methodRaw !== null && !/^[A-Za-z]{1,10}$/.test(methodRaw)) {
    return NextResponse.json(
      { error: "invalid_method", expected: "method", message: "method must be an HTTP method name such as GET or POST.", documentation: "https://vet402.com/docs/api#endpoints" },
      { status: 400, headers: gate.headers },
    );
  }
  try {
    const result = await resolve(q, methodRaw ? { method: methodRaw.toUpperCase() } : {});
    return NextResponse.json(result, { headers: gate.cacheHeaders });
  } catch (error) {
    logServerErrorSafe("resolve", error);
    return NextResponse.json({ error: "resolve_unavailable" }, { status: 503, headers: gate.headers });
  }
}
