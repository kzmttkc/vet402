import { rejectUnknownQuery } from "@/lib/api/export-guard";
import { withNoindex } from "@/lib/api/public-read-robots";
import { isHttpsAbsoluteUrl } from "@/lib/mcp/schemas";
import { priceUsdOf, sanitizeSellerText } from "@/lib/mcp/tools";
import { ERROR_TEXT, recordUrlOf } from "@/lib/mcp/text";
import type { FindListing } from "@/lib/find/reads";
import { searchLikePattern } from "@/lib/observatory/reader";
import { pct1 } from "@/lib/util/pct";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { signedJson } from "@/lib/signing/response-signature";
import { FIND_POOL_SIZE, FIND_WINDOW_DAYS, rankFindAlternatives } from "./rank";
import { PUBLIC_RULES_VERSION } from "@/lib/decision/rules-version-public";
import { DELIVERY_RATE_FORMULA } from "@/lib/delivery/delivery-rate";
import { termsOfUrl } from "./terms";

const ALLOWED_QUERY = ["url", "q"] as const;
const FIND_DOCS = "https://vet402.com/docs/api#endpoints";
const FIND_LICENSE = "CC-BY-4.0";
const FIND_LICENSE_URL = "https://creativecommons.org/licenses/by/4.0/";
const FIND_METHOD_URL = "https://vet402.com/observatory/methodology#find-ranking";
const CACHE_OK = "public, s-maxage=60, stale-while-revalidate=300";
const CACHE_ERR = "no-store";

export type FindDeps = {
  findAlternatives: (like: string, limit: number) => Promise<{ fetchedAt: string; listings: FindListing[] }>;
};

export const FIND_RULE =
  "Listings match the one use word from the later part of the pasted URL path, or from a host label when the path has none, in their URL or seller description. Each needs at least one vet402 paid test in the last 30 days and a delivered rate of at least 80%. Order is the 95% Wilson lower bound on the delivered share, then deliveries, then the latest paid test. The pasted URL is left out. At most three are returned.";

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
    "x-vet402-license": FIND_LICENSE,
    Link: [`<${FIND_LICENSE_URL}>; rel="license"`, `<${FIND_DOCS}>; rel="describedby"`].join(", "),
  };
}

function originAndPath(raw: string): string {
  const u = new URL(raw);
  return `${u.protocol}//${u.host}${u.pathname}`;
}

export async function handleFind(request: Request, deps: FindDeps): Promise<Response> {
  const url = new URL(request.url);
  const baseHeaders: Record<string, string> = {};

  const badQuery = rejectUnknownQuery(url.searchParams, [...ALLOWED_QUERY], baseHeaders);
  if (badQuery) {
    const body = await badQuery.json();
    return json(request, 400, { ...body, documentation: FIND_DOCS }, baseHeaders);
  }

  const urlRaw = url.searchParams.get("url");
  const qRaw = url.searchParams.get("q");
  const hasUrl = urlRaw !== null;
  const hasQ = qRaw !== null;
  if ((hasUrl && hasQ) || (!hasUrl && !hasQ)) {
    return json(
      request,
      400,
      { error: "invalid_query", allowed: [...ALLOWED_QUERY], documentation: FIND_DOCS },
      baseHeaders,
    );
  }

  let basis: "url" | "q";
  let input: string;
  let queryTerms: string[];
  let excludeUrl: string | null = null;

  if (hasUrl) {
    if (!urlRaw || !isHttpsAbsoluteUrl(urlRaw)) {
      return json(
        request,
        400,
        { error: "invalid_url", message: ERROR_TEXT.invalid_url, documentation: FIND_DOCS },
        baseHeaders,
      );
    }
    basis = "url";
    // 共有キャッシュに載る本文へ、貼った URL のクエリ・userinfo・hash を写さない（鍵やメールが入りうる）。
    input = originAndPath(urlRaw);
    excludeUrl = urlRaw;
    queryTerms = termsOfUrl(urlRaw).slice(0, 1);
  } else {
    const q = (qRaw ?? "").trim();
    if (q.length < 3 || q.length > 80) {
      return json(
        request,
        400,
        { error: "invalid_query", allowed: [...ALLOWED_QUERY], documentation: FIND_DOCS },
        baseHeaders,
      );
    }
    basis = "q";
    input = q;
    queryTerms = [q];
  }

  if (queryTerms.length === 0) {
    const asOf = new Date().toISOString();
    return signedJson(
      request,
      {
        basis,
        input,
        query_terms: [],
        alternatives: [],
        rule: FIND_RULE,
        method_url: FIND_METHOD_URL,
        window_days: FIND_WINDOW_DAYS,
        rate_formula: DELIVERY_RATE_FORMULA,
        rules_version: PUBLIC_RULES_VERSION,
        as_of: asOf,
        license: FIND_LICENSE,
      },
      { headers: withNoindex(successHeaders(asOf, baseHeaders)) },
    );
  }

  try {
    const term0 = queryTerms[0]!;
    const like0 = searchLikePattern(term0);
    if (!like0) {
      const asOf = new Date().toISOString();
      return signedJson(
        request,
        {
          basis,
          input,
          query_terms: [term0],
          alternatives: [],
          rule: FIND_RULE,
          method_url: FIND_METHOD_URL,
          window_days: FIND_WINDOW_DAYS,
          rate_formula: DELIVERY_RATE_FORMULA,
          rules_version: PUBLIC_RULES_VERSION,
          as_of: asOf,
          license: FIND_LICENSE,
        },
        { headers: withNoindex(successHeaders(asOf, baseHeaders)) },
      );
    }

    const found0 = await deps.findAlternatives(like0, FIND_POOL_SIZE);
    const pool = found0.listings;
    const asOf = found0.fetchedAt;

    const ranked = rankFindAlternatives(pool, excludeUrl);

    return signedJson(
      request,
      {
        basis,
        input,
        query_terms: [term0],
        alternatives: ranked.alternatives.map((s) => ({
          url: s.url,
          seller_description: sanitizeSellerText(s.description),
          text_source: "seller" as const,
          price_usd: priceUsdOf(s.priceAmount),
          network: s.network,
          delivered_30d: s.delivered30d,
          paid_attempts_30d: s.paidAttempts30d,
          delivered_rate_pct: pct1(s.delivered30d, s.paidAttempts30d),
          last_paid_test_at: s.lastAttemptAt,
          record_url: recordUrlOf(s.observatoryId),
        })),
        rule: FIND_RULE,
        method_url: FIND_METHOD_URL,
        window_days: FIND_WINDOW_DAYS,
        rate_formula: DELIVERY_RATE_FORMULA,
        rules_version: PUBLIC_RULES_VERSION,
        as_of: asOf,
        license: FIND_LICENSE,
      },
      { headers: withNoindex(successHeaders(asOf, baseHeaders)) },
    );
  } catch (error) {
    logServerErrorSafe("find", error);
    return json(request, 503, { error: "temporarily_unavailable" }, baseHeaders);
  }
}