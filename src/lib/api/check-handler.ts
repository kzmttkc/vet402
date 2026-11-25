// ============================================================
// GET /api/v1/check — MCP check_x402_seller と同じ答えを鍵なし REST で返す（2026-11-08）。
// ============================================================
import { rejectUnknownQuery } from "@/lib/api/export-guard";
import { withNoindex } from "@/lib/api/public-read-robots";
import { isHttpsAbsoluteUrl } from "@/lib/mcp/schemas";
import { ERROR_TEXT } from "@/lib/mcp/text";
import { getCheckSellerCached } from "@/lib/api/check-seller-cache";
import type { CheckSellerDeps } from "@/lib/mcp/tools";
import { attachVerdictReceipt, checkCanonicalInput, receiptVerdictOf } from "@/lib/receipts/verdict-receipt";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { signedJson } from "@/lib/signing/response-signature";

const ALLOWED_QUERY = ["url", "method"] as const;
const CHECK_DOCS = "https://vet402.com/docs/api#endpoints";
const CHECK_LICENSE = "CC-BY-4.0";
const CHECK_LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";
const CACHE_OK = "public, s-maxage=60, stale-while-revalidate=300";
const CACHE_ERR = "no-store";


function json(
  request: Request,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): Response {
  const h = withNoindex({
    ...headers,
    "Cache-Control": status === 200 ? CACHE_OK : CACHE_ERR,
  });
  return signedJson(request, body, { status, headers: h });
}

function successHeaders(retrievedAt: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...extra,
    "Cache-Control": CACHE_OK,
    "x-vet402-retrieved-at": retrievedAt,
    "x-vet402-license": CHECK_LICENSE,
    Link: [`<${CHECK_LICENSE_URL}>; rel="license"`, `<https://vet402.com/docs/mcp>; rel="describedby"`].join(", "),
  };
}

export async function handleCheck(request: Request, deps: CheckSellerDeps): Promise<Response> {
  const t0 = performance.now();
  const url = new URL(request.url);
  const baseHeaders: Record<string, string> = {};

  const badQuery = rejectUnknownQuery(url.searchParams, [...ALLOWED_QUERY], baseHeaders);
  if (badQuery) {
    const body = await badQuery.json();
    return json(request, 400, { ...body, documentation: CHECK_DOCS }, baseHeaders);
  }

  const urlRaw = url.searchParams.get("url");
  if (!urlRaw || !isHttpsAbsoluteUrl(urlRaw)) {
    return json(
      request,
      400,
      {
        error: "invalid_url",
        message: ERROR_TEXT.invalid_url,
        documentation: CHECK_DOCS,
      },
      baseHeaders,
    );
  }

  const methodRaw = url.searchParams.get("method");
  if (methodRaw !== null && !/^[A-Za-z]{1,10}$/.test(methodRaw)) {
    return json(
      request,
      400,
      {
        error: "invalid_method",
        expected: "method",
        message: "method must be an HTTP method name such as GET or POST.",
        documentation: CHECK_DOCS,
      },
      baseHeaders,
    );
  }

  try {
    const method = methodRaw ? methodRaw.toUpperCase() : null;
    const out = await getCheckSellerCached(deps, {
      url: urlRaw,
      method: method ?? undefined,
    });
    const verdict = receiptVerdictOf(out.recommendation);
    const body = await attachVerdictReceipt(
      out,
      verdict ? { canonicalInput: checkCanonicalInput(urlRaw, method), verdict, asOf: out.as_of } : null,
    );
    const retrievedAt = out.as_of;
    const res = signedJson(request, body, {
      headers: withNoindex(successHeaders(retrievedAt, baseHeaders)),
    });
    res.headers.set("Server-Timing", `check;dur=${(performance.now() - t0).toFixed(1)}`);
    return res;
  } catch (error) {
    logServerErrorSafe("check", error);
    const res = json(request, 503, { error: "temporarily_unavailable" }, baseHeaders);
    res.headers.set("Server-Timing", `check;dur=${(performance.now() - t0).toFixed(1)}`);
    return res;
  }
}
