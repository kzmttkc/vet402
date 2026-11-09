import { NextRequest, NextResponse } from "next/server";
import { pathGroup, recordSiteEvent, shouldCount, sourceLabel } from "@/lib/site-events";

const MAX_BODY = 512;

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!shouldCount(request.headers)) {
    return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  const raw = await request.text();
  if (raw.length > MAX_BODY) {
    return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  let body: { e?: unknown; p?: unknown; r?: unknown };
  try {
    body = JSON.parse(raw) as { e?: unknown; p?: unknown; r?: unknown };
  } catch {
    return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  const event = typeof body.e === "string" ? body.e.trim() : "";
  const pathRaw = typeof body.p === "string" ? body.p : "";
  if (!event || !pathRaw) {
    return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  let refHost: string | undefined;
  if (typeof body.r === "string") {
    const r = body.r.trim().slice(0, 253);
    if (r && /^[a-z0-9.-]+$/i.test(r)) refHost = r;
  }

  recordSiteEvent({
    event,
    path: pathGroup(pathRaw),
    source: sourceLabel(refHost),
  });

  return new NextResponse(null, { status: 204, headers: { "cache-control": "no-store" } });
}
