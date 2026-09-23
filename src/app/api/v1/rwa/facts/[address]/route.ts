import { NextRequest, NextResponse } from "next/server";
import { getAddress } from "viem";
import { publicRateLimit } from "@/lib/api/public-route";
import { isValidAddress } from "@/lib/chain/client";
import { logServerError } from "@/lib/util/log";
import { RWA_CHAIN_ID } from "../../../../../../../packages/rwa/config";
import { TooBusy, cachedFacts } from "../../../../../../../packages/rwa/cache";
import { NoStockTokenActivity, type RwaFacts } from "../../../../../../../packages/rwa/facts";

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
 */

type RouteContext = { params: Promise<{ address: string }> };

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
    const facts = await cachedFacts(address);
    return NextResponse.json(render(facts), { headers: gate.cacheHeaders });
  } catch (err) {
    if (err instanceof TooBusy) {
      return NextResponse.json(
        { error: "too_busy" },
        { status: 503, headers: { ...gate.headers, "Retry-After": String(err.retryAfterSec) } },
      );
    }
    if (err instanceof NoStockTokenActivity) {
      return NextResponse.json({ error: "no_stock_token_activity" }, { status: 404, headers: gate.headers });
    }
    logServerError("rwa_facts", err);
    return NextResponse.json({ error: "feed_unavailable" }, { status: 503, headers: gate.headers });
  }
}

/** Addresses are stored lower-cased and shown EIP-55 (SPEC §7). */
function render(facts: RwaFacts): RwaFacts {
  return { ...facts, address: getAddress(facts.address) };
}
