import { NextRequest, NextResponse } from "next/server";
import { RESOLVE_KEYLESS_LIMIT, RESOLVE_KEYLESS_WINDOW_MS } from "@/lib/api/keyless-limits";
import { publicRateLimit } from "@/lib/api/public-route";
import { resolve } from "@/lib/resolve/lookup";
import { ACCEPTED_QUERY_FORMS, classifyQuery, explainInvalidQuery } from "@/lib/resolve/classify";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { isKeylessRequest, recordClientUsage } from "@/lib/api/client-usage";

// §7.3 / §9.1: GET /api/v1/resolve?q={url|domain|address|tx|payee_id}[&method=GET|POST|…]
// キー不要。ID を持たない呼び手が「この URL / この受取先 / この tx は何か」を
// 1 回で引く入口。判定は返さない（それは /resources/{id}/decision）。
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const gate = await publicRateLimit(request, "resolve", RESOLVE_KEYLESS_LIMIT, RESOLVE_KEYLESS_WINDOW_MS);
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
    // 2026-10-07 / 10-11: 鍵なしの呼び出しを、決まった client の名前に寄せて日別の件数で数える（応答の後・失敗しても
    // 応答は変わらない）。数えるのは 200 を返すときだけ（decision と同じ。400 と 503 は枠を消費するが数えない）。
    // このルートは Authorization を読まない（鍵つきでも同じ IP 枠・同じ答え）が、SDK と MCP サーバは鍵が設定されて
    // いれば resolve にも Authorization を付ける。付いている呼び出しは「鍵なし」の数に入れない（独立した点検・高）。
    if (isKeylessRequest(request.headers)) recordClientUsage(request.headers, "resolve");
    return NextResponse.json(result, { headers: gate.cacheHeaders });
  } catch (error) {
    logServerErrorSafe("resolve", error);
    return NextResponse.json({ error: "resolve_unavailable" }, { status: 503, headers: gate.headers });
  }
}
