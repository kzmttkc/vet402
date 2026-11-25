/**
 * GET /api/v1/delivery/by-resource — Bazaar resource URL ごとの vet402 delivery 欄（F10・2026-11-25）。
 */
import { NextRequest, NextResponse } from "next/server";
import { DeliveryFeedExportBusy } from "@/lib/delivery/sellers-feed-cache";
import { exportBusyResponse, rejectUnknownQuery } from "@/lib/api/export-guard";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";
import { publicRateLimit, PUBLIC_DISCLAIMER } from "@/lib/api/public-route";
import { withNoindex } from "@/lib/api/public-read-robots";
import {
  BAZAAR_DELIVERY_RATE_PER_MIN,
  bazaarCatalogProbeMethod,
  bazaarDeliveryEnvelope,
} from "@/lib/delivery/bazaar-field";
import { readBazaarDeliveryByResourceUrl } from "@/lib/delivery/bazaar-read";
import { getDb } from "@/lib/db/client";
import { logServerErrorSafe } from "@/lib/util/log-safe";

const ALLOWED_QUERY = ["url", "method"] as const;

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const gate = await publicRateLimit(request, "delivery-bazaar", BAZAAR_DELIVERY_RATE_PER_MIN, 60_000);
  if (!gate.ok) return gate.response;

  const badQuery = rejectUnknownQuery(request.nextUrl.searchParams, [...ALLOWED_QUERY], gate.headers);
  if (badQuery) return badQuery;

  const urlRaw = request.nextUrl.searchParams.get("url");
  if (!urlRaw || urlRaw.trim() === "") {
    return NextResponse.json({ error: "invalid_url" }, { status: 400, headers: gate.headers });
  }

  const methodRaw = request.nextUrl.searchParams.get("method");
  const methodHint = methodRaw && methodRaw.trim() !== "" ? bazaarCatalogProbeMethod(methodRaw) : null;

  const db = getDb();
  if (!db) {
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: gate.headers });
  }

  try {
    const hit = await readBazaarDeliveryByResourceUrl(db, urlRaw.trim(), methodHint);
    if (!hit) {
      return NextResponse.json({ error: "invalid_url" }, { status: 400, headers: gate.headers });
    }
    return NextResponse.json(
      {
        url: hit.canonicalUrl,
        delivery: hit.delivery,
        ...bazaarDeliveryEnvelope(hit.snapshot),
        disclaimer: PUBLIC_DISCLAIMER,
      },
      {
        headers: withNoindex(gate.cacheHeaders),
      },
    );
  } catch (error) {
    if (error instanceof DeliveryFeedExportBusy) return exportBusyResponse(error, gate.headers);
    logServerErrorSafe("delivery.by_resource", error);
    return NextResponse.json({ error: "observatory_unavailable" }, { status: 503, headers: gate.headers });
  }
}

const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);