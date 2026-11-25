/**
 * POST /api/v1/delivery/annotate — Bazaar discovery items に delivery 欄を付ける（F10・2026-11-25）。
 */
import { NextRequest, NextResponse } from "next/server";
import { exportBusyResponse } from "@/lib/api/export-guard";
import { DeliveryFeedExportBusy } from "@/lib/delivery/sellers-feed-cache";
import { exportDisallowedMethodHandlers } from "@/lib/api/method-not-allowed";
import { publicRateLimit, PUBLIC_DISCLAIMER } from "@/lib/api/public-route";
import { withNoindex } from "@/lib/api/public-read-robots";
import {
  BAZAAR_DELIVERY_MAX_BODY_BYTES,
  BAZAAR_DELIVERY_MAX_ITEMS,
  BAZAAR_DELIVERY_RATE_PER_MIN,
  bazaarDeliveryEnvelope,
  type BazaarDeliveryField,
} from "@/lib/delivery/bazaar-field";
import { bazaarAnnotateKeys, readBazaarDeliveryAnnotateBatch } from "@/lib/delivery/bazaar-read";
import { getDb } from "@/lib/db/client";
import { logServerErrorSafe } from "@/lib/util/log-safe";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 本文を上限まで読む。超えたら null（mcp/route.ts と同じバイト数方式）。 */
async function readBodyCapped(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > BAZAAR_DELIVERY_MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BAZAAR_DELIVERY_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function POST(request: NextRequest) {
  const gate = await publicRateLimit(request, "delivery-bazaar-annotate", BAZAAR_DELIVERY_RATE_PER_MIN, 60_000);
  if (!gate.ok) return gate.response;

  let raw: string | null;
  try {
    raw = await readBodyCapped(request);
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: gate.headers });
  }
  if (raw === null) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: gate.headers });
  }

  let body: unknown;
  try {
    body = raw === "" ? null : JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: gate.headers });
  }
  if (!isRecord(body) || !Array.isArray(body.items)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: gate.headers });
  }

  const items = body.items;
  if (items.length === 0 || items.length > BAZAAR_DELIVERY_MAX_ITEMS) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: gate.headers });
  }
  if (items.some((x) => !isRecord(x))) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: gate.headers });
  }

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: gate.headers });
  }

  try {
    const keys = bazaarAnnotateKeys(items);
    const { snapshot, byIndex: deliveryByIndex } = await readBazaarDeliveryAnnotateBatch(db, keys);
    const annotated = items.map((item, index) => ({
      ...(item as Record<string, unknown>),
      delivery: deliveryByIndex.get(index) ?? null,
    }));

    return NextResponse.json(
      {
        items: annotated,
        ...bazaarDeliveryEnvelope(snapshot),
        disclaimer: PUBLIC_DISCLAIMER,
      },
      { headers: withNoindex(gate.cacheHeaders) },
    );
  } catch (error) {
    if (error instanceof DeliveryFeedExportBusy) return exportBusyResponse(error, gate.headers);
    logServerErrorSafe("delivery.annotate", error);
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: gate.headers });
  }
}

const __disallowed = exportDisallowedMethodHandlers(["POST"]);
export const { GET, PUT, PATCH, DELETE, OPTIONS } = __disallowed;