import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  applyRateLimit,
  authenticateApiRequest,
  withRateLimitHeaders,
} from "@/lib/api/guard";
import {
  MAX_WEBHOOKS_PER_KEY,
  WEBHOOK_EVENTS,
  createWebhook,
  isSafeWebhookUrl,
  isWebhookEvent,
  listWebhooks,
} from "@/lib/webhooks";
import { logServerError } from "@/lib/util/log";

/**
 * GET  /api/v1/webhooks — list this key's endpoints (secrets never returned).
 * POST /api/v1/webhooks — register one. The signing secret is returned ONCE
 *                         in this response, same contract as API keys.
 *
 * SSRF note: `url` is validated here AND at every delivery
 * (src/lib/webhooks.ts) — registration-time checks alone can be bypassed by
 * a DNS change between registration and delivery.
 */

const createSchema = z.object({
  url: z.string().max(2048),
  events: z.array(z.string()).min(1).max(WEBHOOK_EVENTS.length),
});

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.error;

  try {
    const rows = await listWebhooks(auth.ctx.apiKeyId);
    return NextResponse.json({ webhooks: rows, events: WEBHOOK_EVENTS });
  } catch (error) {
    logServerError("webhooks_list", error);
    return NextResponse.json({ error: "webhooks_unavailable" }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.error;

  const limited = await applyRateLimit(auth.ctx, 1);
  if (!limited.ok) return limited.error;

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { url, events } = parsed.data;
  if (!isSafeWebhookUrl(url)) {
    return NextResponse.json(
      {
        error: "invalid_webhook_url",
        detail: "URL must be https to a public host (no IPs in private ranges, no credentials).",
      },
      { status: 400 },
    );
  }
  const badEvent = events.find((e) => !isWebhookEvent(e));
  if (badEvent) {
    return NextResponse.json(
      { error: "unknown_event", detail: `"${badEvent}" — valid: ${WEBHOOK_EVENTS.join(", ")}` },
      { status: 400 },
    );
  }

  try {
    const result = await createWebhook({
      apiKeyId: auth.ctx.apiKeyId,
      url,
      events: events.filter(isWebhookEvent),
    });
    if ("error" in result) {
      if (result.error === "limit_reached") {
        return NextResponse.json(
          { error: "limit_reached", detail: `Max ${MAX_WEBHOOKS_PER_KEY} webhooks per key.` },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: "webhooks_unavailable" }, { status: 503 });
    }
    return withRateLimitHeaders(
      NextResponse.json(
        {
          id: result.id,
          url,
          events,
          // Shown once. We keep it to sign payloads; the caller keeps it to
          // verify them. Header format: Vouch-Signature: t=<unix>,v1=<hmac>.
          secret: result.secret,
        },
        { status: 201 },
      ),
      limited.rateLimit,
    );
  } catch (error) {
    logServerError("webhooks_create", error);
    return NextResponse.json({ error: "webhooks_unavailable" }, { status: 503 });
  }
}
