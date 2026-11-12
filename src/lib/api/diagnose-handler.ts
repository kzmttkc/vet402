// GET /api/v1/diagnose — 未掲載 URL の 402 を 1 回読んで検査する。支払わない。
import { NextResponse } from "next/server";
import { rejectUnknownQuery } from "@/lib/api/export-guard";
import { withNoindex } from "@/lib/api/public-read-robots";
import { diagnoseLive, type DiagnoseBody, type DiagnoseLiveInput } from "@/lib/diagnose/diagnose";
import { isHttpsAbsoluteUrl } from "@/lib/mcp/schemas";
import { ERROR_TEXT } from "@/lib/mcp/text";

const ALLOWED_QUERY = ["url", "method"] as const;

function json(status: number, body: object, cache: string): Response {
  return NextResponse.json(body, {
    status,
    headers: withNoindex({ "Cache-Control": cache }),
  });
}

export type DiagnoseDeps = Pick<DiagnoseLiveInput, "fetchImpl" | "resolve" | "now" | "dbPresent" | "catalogLookup" | "timeoutMs">;

export async function handleDiagnose(request: Request, deps: DiagnoseDeps = {}): Promise<Response> {
  const url = new URL(request.url);
  const badQuery = rejectUnknownQuery(url.searchParams, [...ALLOWED_QUERY], {});
  if (badQuery) {
    badQuery.headers.set("x-robots-tag", "noindex");
    badQuery.headers.set("cache-control", "no-store");
    return badQuery;
  }

  const urlRaw = url.searchParams.get("url");
  if (!urlRaw || !isHttpsAbsoluteUrl(urlRaw)) {
    return json(400, { error: "invalid_url", message: ERROR_TEXT.invalid_url }, "no-store");
  }

  const methodRaw = url.searchParams.get("method");
  if (methodRaw !== null && methodRaw.toUpperCase() !== "GET" && methodRaw.toUpperCase() !== "POST") {
    return json(400, { error: "invalid_method", message: "method must be GET or POST." }, "no-store");
  }
  const method = methodRaw?.toUpperCase() === "POST" ? "POST" : "GET";

  const out = await diagnoseLive({ url: urlRaw, method, ...deps });
  if (!out.ok) return json(400, { error: "unsafe_target" }, "no-store");
  const cache = out.body.http_status === null ? "no-store" : "public, max-age=60, s-maxage=60";
  return json(200, out.body satisfies DiagnoseBody, cache);
}
