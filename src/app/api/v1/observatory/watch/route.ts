import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyMessage } from "viem";
import { and, eq } from "drizzle-orm";
import { authorizeApiRequest, withRateLimitHeaders } from "@/lib/api/guard";
import { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { x402Endpoints, x402PayeeWatchers } from "@/lib/db/schema";
import { isValidAddress } from "@/lib/chain/client";
import { observatoryWatchMessage } from "@/lib/verify-message";
import { logServerError } from "@/lib/util/log";

/**
 * Observatory watch registration (design §6.1) — the claim join.
 *
 * GET  ?wallet=0x… — preview: the canonical message to sign, plus the
 *                    endpoints currently paying that wallet (what you would
 *                    be claiming). Authenticated: the message binds THIS key.
 * POST {wallet, signature} — register. Two independent proofs meet here:
 *                    the api key authenticates the subscriber, the EIP-191
 *                    signature proves control of the receiving wallet (the
 *                    same gate verified payees pass). Only then do
 *                    `endpoint.delisted` events for endpoints paying that
 *                    wallet flow to the key's webhooks.
 * DELETE {wallet}  — unregister (owner-scoped: only this key's row).
 */

const postSchema = z.object({
  wallet: z.string(),
  signature: z.string().max(4000),
});

const deleteSchema = z.object({ wallet: z.string() });

const MAX_WATCHERS_PER_KEY = 20;

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await authorizeApiRequest(request, 1);
  if (!auth.ok) return auth.error;

  const wallet = request.nextUrl.searchParams.get("wallet") ?? "";
  if (!isValidAddress(wallet)) {
    return withRateLimitHeaders(
      NextResponse.json({ error: "invalid_wallet_address" }, { status: 400 }),
      auth.ctx.rateLimit,
    );
  }
  const normalized = wallet.toLowerCase();

  let claimedEndpoints: { resourceKey: string; status: string }[] = [];
  try {
    const db = getDb();
    if (db) {
      claimedEndpoints = await db
        .select({ resourceKey: x402Endpoints.resourceKey, status: x402Endpoints.status })
        .from(x402Endpoints)
        .where(eq(x402Endpoints.payTo, normalized))
        .limit(100);
    }
  } catch (error) {
    if (!isMissingSchemaError(error)) throw error;
  }

  return withRateLimitHeaders(
    NextResponse.json({
      message: observatoryWatchMessage(normalized, auth.ctx.apiKeyId),
      endpointsPayingThisWallet: claimedEndpoints,
    }),
    auth.ctx.rateLimit,
  );
}

export async function POST(request: NextRequest) {
  const auth = await authorizeApiRequest(request, 1);
  if (!auth.ok) return auth.error;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return withRateLimitHeaders(
      NextResponse.json({ error: "invalid_request" }, { status: 400 }),
      auth.ctx.rateLimit,
    );
  }
  const parsed = postSchema.safeParse(json);
  if (!parsed.success) {
    return withRateLimitHeaders(
      NextResponse.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 }),
      auth.ctx.rateLimit,
    );
  }
  const { wallet, signature } = parsed.data;
  if (!isValidAddress(wallet)) {
    return withRateLimitHeaders(
      NextResponse.json({ error: "invalid_wallet_address" }, { status: 400 }),
      auth.ctx.rateLimit,
    );
  }
  const normalized = wallet.toLowerCase();

  // Proof of wallet control: EIP-191 signature over the canonical message
  // binding wallet AND this api key. A signature for another key is invalid
  // here by construction — replaying it cannot route someone else's alerts.
  let valid = false;
  try {
    valid = await verifyMessage({
      address: normalized as `0x${string}`,
      message: observatoryWatchMessage(normalized, auth.ctx.apiKeyId),
      signature: signature as `0x${string}`,
    });
  } catch {
    valid = false;
  }
  if (!valid) {
    return withRateLimitHeaders(
      NextResponse.json({ error: "invalid_signature" }, { status: 401 }),
      auth.ctx.rateLimit,
    );
  }

  const db = getDb();
  if (!db) {
    return withRateLimitHeaders(
      NextResponse.json({ error: "service_unavailable" }, { status: 503 }),
      auth.ctx.rateLimit,
    );
  }

  try {
    const existing = await db
      .select({ id: x402PayeeWatchers.id })
      .from(x402PayeeWatchers)
      .where(eq(x402PayeeWatchers.apiKeyId, auth.ctx.apiKeyId));
    if (existing.length >= MAX_WATCHERS_PER_KEY) {
      return withRateLimitHeaders(
        NextResponse.json({ error: "watcher_limit_reached", limit: MAX_WATCHERS_PER_KEY }, { status: 409 }),
        auth.ctx.rateLimit,
      );
    }

    await db
      .insert(x402PayeeWatchers)
      .values({ wallet: normalized, apiKeyId: auth.ctx.apiKeyId })
      .onConflictDoNothing();

    return withRateLimitHeaders(
      NextResponse.json({
        ok: true,
        wallet: normalized,
        note: "endpoint.delisted events for endpoints paying this wallet will be delivered to this key's webhooks subscribed to that event.",
      }),
      auth.ctx.rateLimit,
    );
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return withRateLimitHeaders(
        NextResponse.json({ error: "service_unavailable" }, { status: 503 }),
        auth.ctx.rateLimit,
      );
    }
    logServerError("observatory_watch_register", error);
    return withRateLimitHeaders(
      NextResponse.json({ error: "internal_error" }, { status: 500 }),
      auth.ctx.rateLimit,
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await authorizeApiRequest(request, 1);
  if (!auth.ok) return auth.error;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return withRateLimitHeaders(
      NextResponse.json({ error: "invalid_request" }, { status: 400 }),
      auth.ctx.rateLimit,
    );
  }
  const parsed = deleteSchema.safeParse(json);
  if (!parsed.success || !isValidAddress(parsed.data.wallet)) {
    return withRateLimitHeaders(
      NextResponse.json({ error: "invalid_request" }, { status: 400 }),
      auth.ctx.rateLimit,
    );
  }

  const db = getDb();
  if (!db) {
    return withRateLimitHeaders(
      NextResponse.json({ error: "service_unavailable" }, { status: 503 }),
      auth.ctx.rateLimit,
    );
  }

  try {
    // Owner-scoped delete: the key can only remove its own claim.
    await db
      .delete(x402PayeeWatchers)
      .where(
        and(
          eq(x402PayeeWatchers.wallet, parsed.data.wallet.toLowerCase()),
          eq(x402PayeeWatchers.apiKeyId, auth.ctx.apiKeyId),
        ),
      );
    return withRateLimitHeaders(NextResponse.json({ ok: true }), auth.ctx.rateLimit);
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return withRateLimitHeaders(NextResponse.json({ ok: true }), auth.ctx.rateLimit);
    }
    logServerError("observatory_watch_delete", error);
    return withRateLimitHeaders(
      NextResponse.json({ error: "internal_error" }, { status: 500 }),
      auth.ctx.rateLimit,
    );
  }
}
