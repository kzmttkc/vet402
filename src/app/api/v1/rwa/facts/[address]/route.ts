import { NextRequest, NextResponse, after } from "next/server";
import { getAddress } from "viem";
import { publicRateLimit } from "@/lib/api/public-route";
import { isValidAddress } from "@/lib/chain/client";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { RWA_CHAIN_ID } from "../../../../../../../packages/rwa/config";
import { emptyAnswer, failureAnswer, tooLargeAnswer } from "../../../../../../../packages/rwa/answers";
import { FREE_DEADLINE_MS, ReconstructionTimeout, TooBusy, cachedFacts, pendingFacts } from "../../../../../../../packages/rwa/cache";
import { NoStockTokenActivity, WalletTooLarge, type RwaFacts } from "../../../../../../../packages/rwa/facts";
import { factsHashHeader } from "../../../../../../../packages/rwa/anchor";

/**
 * GET /api/v1/rwa/facts/:address?chain=4663 — public facts (docs/rwa/SPEC.md §7).
 *
 * Reconstruction only. There is no opinion field on this path and no import
 * from /score: the RWA instrument lives in packages/rwa and this route.
 * Key-less. 10 requests/min/IP (2026-09-23: down from the shared 120 after the
 * Vercel quota stop — one request here costs ~30 RPC calls and tens of seconds,
 * so this path is nothing like the other key-less reads). The address cache and
 * the cap on concurrent reconstructions live in packages/rwa/cache.ts and are
 * shared with the /rwa page (SPEC §9).
 *
 * A stale equity feed refuses the USD mark (`usd: null`, `stale: true`);
 * realized_usd is null until fixtures/rwa/B.md exists and its test passes.
 *
 * `X-Facts-Hash` carries the v2 anchor hash of the body (packages/rwa/anchor.ts,
 * SPEC patch 023), so a reader can compare a response with an Anchored event
 * without trusting this server. The body is unchanged.
 *
 * SPEC patch 020: an address that holds no Stock Token gets 404 with a body that
 * says what was checked, cached like a record. Every 503 names its reason
 * (too_busy, still_reading, chain_unavailable) with Retry-After, a wallet too
 * large for one request gets 422 wallet_too_large with its holdings, and the route
 * answers within FREE_DEADLINE_MS while a slow read keeps running for the retry.
 */

type RouteContext = { params: Promise<{ address: string }> };

/**
 * Held at the CDN for 5 minutes, then served stale for up to a day while one
 * background request rebuilds it (2026-09-29 audit: a judge opening the page and
 * the JSON at once must not meet a cold rebuild). Errors are not cached. The
 * record carries `as_of`, so a stale copy says how old it is.
 */
export const RWA_FACTS_CACHE_CONTROL = "public, max-age=60, s-maxage=300, stale-while-revalidate=86400";
/**
 * For the 404 (no Stock Token) and 422 (too large) answers. The header carries
 * s-maxage=300 and at most 60 s of stale, so no copy says "none" for a day after
 * a wallet buys its first Stock Token. Vercel's CDN does not keep a 422 (measured
 * 2026-09-30: every request a MISS). A repeat 422 within 5 minutes comes from this
 * server's in-memory cache (packages/rwa/cache.ts), which each instance keeps.
 */
export const RWA_ANSWER_CACHE_CONTROL = "public, max-age=60, s-maxage=300, stale-while-revalidate=60";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest, context: RouteContext) {
  const gate = await publicRateLimit(request, "rwa-facts", 10, 60_000);
  if (!gate.ok) return gate.response;

  const { address } = await context.params;
  if (!isValidAddress(address)) {
    return NextResponse.json({ error: "invalid_address" }, { status: 400, headers: gate.headers });
  }
  const chain = request.nextUrl.searchParams.get("chain") ?? String(RWA_CHAIN_ID);
  if (chain !== String(RWA_CHAIN_ID)) {
    return NextResponse.json({ error: "invalid_address", detail: `chain must be ${RWA_CHAIN_ID}` }, { status: 400, headers: gate.headers });
  }

  try {
    const facts = await cachedFacts(address, { deadlineMs: FREE_DEADLINE_MS });
    return NextResponse.json(render(facts), {
      headers: {
        ...gate.cacheHeaders,
        "Cache-Control": RWA_FACTS_CACHE_CONTROL,
        ...factsHashHeader(facts),
        "Access-Control-Expose-Headers": "X-Facts-Hash",
      },
    });
  } catch (err) {
    if (err instanceof NoStockTokenActivity) {
      // The same answer for the same wallet until it changes: cached at the CDN, with a short stale window.
      return NextResponse.json(emptyAnswer(err), { status: 404, headers: { ...gate.cacheHeaders, "Cache-Control": RWA_ANSWER_CACHE_CONTROL } });
    }
    if (err instanceof WalletTooLarge) {
      return NextResponse.json(tooLargeAnswer(err), { status: 422, headers: { ...gate.cacheHeaders, "Cache-Control": RWA_ANSWER_CACHE_CONTROL } });
    }
    if (err instanceof ReconstructionTimeout) keepReading(address);
    else if (!(err instanceof TooBusy)) logServerErrorSafe("rwa_facts", err);
    const body = failureAnswer(err);
    return NextResponse.json(body, { status: 503, headers: { ...gate.headers, "Retry-After": String(body.retry_after_sec), "Cache-Control": "no-store" } });
  }
}

/** Keep the function alive until the read this request stopped waiting for has finished, so the retry finds it. */
function keepReading(address: string): void {
  const pending = pendingFacts(address);
  if (!pending) return;
  try {
    after(() => pending);
  } catch {
    // outside a request scope (tests): nothing to keep alive
  }
}

/** Addresses are stored lower-cased and shown EIP-55 (SPEC §7). */
function render(facts: RwaFacts): RwaFacts {
  return { ...facts, address: getAddress(facts.address) };
}
