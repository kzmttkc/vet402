import { NextRequest, NextResponse } from "next/server";
import { publicRateLimit, PUBLIC_DISCLAIMER } from "@/lib/api/public-route";
import { parsePartyId, payeeId as toPartyId } from "@/lib/ids/canonical";
import { endpointsByPayee } from "@/lib/resolve/lookup";
import { SOLANA_MAINNET_CAIP2 } from "@/lib/observatory/sol402-payer";
import { logServerError } from "@/lib/util/log";

// §7.3 / §9.1: GET /api/v1/payees/{payee_id}/endpoints — 受取ウォレット → 店。
// payee_id は chain:address（§5）。裸の 0x / base58 も受け、既定チェーンを補う。
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type RouteContext = { params: Promise<{ address: string }> };

export function normalizePayeeParam(raw: string): string | null {
  // Next.js は動的セグメントを一度復号して渡す。ここは二度目なので、`%25` 由来の
  // 裸の `%` などは URIError になる——不正 id として 400 に倒す（500 にしない）。
  let v: string;
  try {
    v = decodeURIComponent(raw).trim();
  } catch {
    return null;
  }
  if (parsePartyId(v)) return v.startsWith("eip155:") ? v.toLowerCase() : v;
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return toPartyId("eip155:8453", v);
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return toPartyId(SOLANA_MAINNET_CAIP2, v);
  return null;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const gate = await publicRateLimit(request, "payee-endpoints", 120);
  if (!gate.ok) return gate.response;
  const { address: payeeId } = await context.params;
  const id = normalizePayeeParam(payeeId);
  if (!id) return NextResponse.json({ error: "invalid_payee_id" }, { status: 400, headers: gate.headers });
  try {
    const endpoints = await endpointsByPayee(id);
    return NextResponse.json(
      { payee_id: id, endpoints, count: endpoints.length, disclaimer: PUBLIC_DISCLAIMER },
      { headers: gate.cacheHeaders },
    );
  } catch (error) {
    logServerError("payees.endpoints", error);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: gate.headers });
  }
}
