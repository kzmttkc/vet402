import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeApiRequest, withRateLimitHeaders } from "@/lib/api/guard";
import { isValidAddress } from "@/lib/chain/client";
import { getTrustEventById, recordPartnerOutcome } from "@/lib/db/outcome-writer";
import { logServerError } from "@/lib/util/log";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

const bodySchema = z.object({
  outcomeType: z.enum(["confirmed_fraud", "confirmed_legitimate", "chargeback_dispute", "other"]),
  relatedWallet: z.string().min(1).optional(),
  notes: z.string().max(1000).optional(),
  evidenceUrl: z
    .string()
    .url()
    .max(2048)
    .refine(isHttpUrl, { message: "evidenceUrl must use http or https" })
    .optional(),
});

type RouteContext = { params: Promise<{ trustEventId: string }> };

/**
 * POST /api/v1/events/{trustEventId}/outcome
 *
 * Partner-reported result label for a past trust_events verdict (fraud
 * confirmation, chargeback, etc). Idempotent per (trustEventId, outcomeType,
 * source) — reporting the same outcomeType again from the same key returns
 * the existing row rather than erroring.
 *
 * AUTHORIZATION (2026-08-12 — this was missing entirely). Authenticating the
 * caller is not enough here: both the event id and the wallet arrive from the
 * request, and what gets written is not private to the caller. A partner
 * outcome lands in verdict_outcomes.related_wallet, and getOutcomesForWallet()
 * feeds those rows straight into the payee scoring engine — so an unchecked
 * write let any key with one quota unit spare pin `confirmed_fraud` on a
 * stranger's wallet, or launder its own. Two things are therefore verified
 * before anything is recorded:
 *
 *   1. OWNERSHIP — the trust event must belong to the calling key. Enforced
 *      twice on purpose: getTrustEventById scopes the SELECT by api_key_id
 *      (so a foreign row never reaches this code), and the explicit
 *      comparison below re-asserts it, so relaxing the query alone cannot
 *      silently reopen the hole.
 *   2. SUBJECT — relatedWallet, if given, must be the wallet that verdict was
 *      actually about. It is only ever an assertion the caller agrees with the
 *      event; the value written is the event's own wallet, never the body's.
 *
 * Both refusals fail closed, and "not yours" is reported as 404
 * trust_event_not_found — identical to a genuinely unknown id. A 403 would
 * confirm that a guessed UUID names a real verdict, turning this endpoint into
 * an existence oracle over other customers' events. Same choice, same reason,
 * as watchlist/[id] and webhooks/[id] (see tests/authz-per-id.test.ts), and it
 * matches the published contract in docs/openapi.yaml, which documents 404 and
 * no 403 for this path.
 */
// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await authorizeApiRequest(request, 1);
  if (!auth.ok) return auth.error;

  const { trustEventId } = await context.params;
  if (!UUID_RE.test(trustEventId)) {
    return NextResponse.json({ error: "invalid_trust_event_id" }, { status: 400 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { outcomeType, relatedWallet, notes, evidenceUrl } = parsed.data;

  if (relatedWallet && !isValidAddress(relatedWallet)) {
    return NextResponse.json({ error: "invalid_wallet_address" }, { status: 400 });
  }

  let trustEvent: Awaited<ReturnType<typeof getTrustEventById>>;
  try {
    trustEvent = await getTrustEventById(trustEventId, auth.ctx.apiKeyId);
  } catch (error) {
    logServerError("outcome_report_lookup", error);
    return NextResponse.json({ error: "outcome_ingest_unavailable" }, { status: 503 });
  }

  // Not found, or found but not the caller's — one indistinguishable answer.
  // The second clause is redundant while the lookup stays owner-scoped; that
  // is the point. It is the check that survives someone widening the query.
  if (!trustEvent || trustEvent.apiKeyId !== auth.ctx.apiKeyId) {
    return NextResponse.json({ error: "trust_event_not_found" }, { status: 404 });
  }

  // The label's subject is the verdict's own wallet — never a wallet named by
  // the request. A supplied relatedWallet is accepted only as agreement with
  // the event (case-insensitively: on-chain addresses arrive checksummed).
  // An event with no wallet (agent-only score) has no subject to assert, so
  // naming one is a mismatch rather than a free pass.
  if (
    relatedWallet &&
    relatedWallet.toLowerCase() !== (trustEvent.wallet ?? "").toLowerCase()
  ) {
    return NextResponse.json({ error: "related_wallet_mismatch" }, { status: 400 });
  }

  // vet402 2026-08-13 (ruling 7) — a partner cannot vouch for itself.
  //
  // This endpoint only ever reaches the caller's OWN verdicts: getTrustEventById
  // scopes the SELECT by api_key_id, and the ownership check above re-asserts it.
  // So a POSITIVE outcome reported here is always "I scored this wallet, and I
  // now declare it legitimate" — self-lookup → self-affirmation. Because anyone
  // can score any wallet, that let a key raise a wallet's payee score (via
  // getOutcomesForWallet → applyOutcomeAdjustment's +8) purely by self-
  // declaration, the exact self-attestation-raises-score pattern this whole
  // change removes from the ledger. Reporter and subject are not separated on a
  // self-generated verdict, so a self-affirming label carries no evidence.
  //
  // Minimal, documented enforcement: reject the score-RAISING outcome type from
  // the partner endpoint. Positive signals must come from the auto-detector,
  // which observes the chain (sustained_healthy_activity), not from the same key
  // that asked for the verdict. NEGATIVE reports (confirmed_fraud,
  // chargeback_dispute) stay open — a counterparty warning others about a wallet
  // that harmed it is the legitimate use, and the subject-wallet check already
  // pins it to the verdict's own wallet. A fuller model (proving the reporter
  // was an actual counterparty, admitting third-party attestations) is the next
  // step; until then no self-affirmation reaches scoring.
  const SCORE_RAISING_PARTNER_OUTCOMES = new Set(["confirmed_legitimate"]);
  if (SCORE_RAISING_PARTNER_OUTCOMES.has(outcomeType)) {
    return NextResponse.json(
      {
        error: "self_affirmation_not_accepted",
        detail:
          "A positive outcome cannot be self-reported on your own verdict. " +
          "Positive standing is earned from on-chain activity, not self-declared.",
      },
      { status: 422 },
    );
  }

  const resolvedWallet = trustEvent.wallet ?? null;
  const now = new Date();
  const windowMinutes = Math.max(
    0,
    Math.floor((now.getTime() - trustEvent.createdAt.getTime()) / 60_000),
  );

  try {
    const result = await recordPartnerOutcome({
      trustEventId,
      outcomeType,
      relatedWallet: resolvedWallet,
      windowMinutes,
      apiKeyId: auth.ctx.apiKeyId,
      evidence: {
        notes: notes ?? null,
        evidenceUrl: evidenceUrl ?? null,
      },
    });

    if (!result) {
      return NextResponse.json({ error: "outcome_ingest_unavailable" }, { status: 503 });
    }

    return withRateLimitHeaders(
      NextResponse.json(
        {
          ok: true,
          created: result.created,
          id: result.id,
          trustEventId,
          outcomeType,
        },
        { status: result.created ? 201 : 200 },
      ),
      auth.ctx.rateLimit,
    );
  } catch (error) {
    logServerError("outcome_report_ingest", error);
    return NextResponse.json({ error: "outcome_ingest_unavailable" }, { status: 503 });
  }
}
