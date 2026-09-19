import { NextRequest, NextResponse } from "next/server";
import { publicRateLimit, PUBLIC_DISCLAIMER } from "@/lib/api/public-route";
import { listCorrections } from "@/lib/observatory/corrections";
import { UUID_RE } from "@/lib/validation/uuid";
import { logServerError } from "@/lib/util/log";

// §10: GET /api/v1/observatory/corrections?endpoint=<uuid>&limit=
// 公開判定が後から変わった記録（before/after）。自社に不利な訂正も同じ表から出す。
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const gate = await publicRateLimit(request, "corrections", 60);
  if (!gate.ok) return gate.response;
  const endpoint = request.nextUrl.searchParams.get("endpoint");
  if (endpoint && !UUID_RE.test(endpoint)) {
    return NextResponse.json({ error: "invalid_endpoint_id" }, { status: 400, headers: gate.headers });
  }
  const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? 100);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 100;
  try {
    const corrections = await listCorrections({ endpointId: endpoint ?? undefined, limit });
    return NextResponse.json(
      {
        corrections,
        definition:
          "Each row is a public verdict that changed after publication: dispute_remeasure (a seller's signed dispute triggered a re-measurement that overturned the verdict), settlement_backfill (a settlement moved up or down the ledger on on-chain evidence), reverify (a C4 re-verification overturned the verdict). before/after are the published values, and for settlement_backfill they say which of three paths a row took. (1) before.status settle_claimed: the seller had asserted a settlement and vet402 read the chain — after.status settled when the transfer was there, settle_claim_refuted when it was not, which is a row against the seller. (2) before.status settle_failed, delivered_no_receipt or settle_claimed_unverifiable: the seller named no usable transaction and vet402's own settlement index linked a transfer from our payer to that endpoint's payee, for the expected amount, inside the attempt window, that no other purchase could be claiming; after.status is settle_claimed, never settled, because a transfer that fits is not a proof that it belongs to that purchase — the row then passes the same on-chain verifier as a seller-asserted one. (3) after.lateLinkWithdrawn: that verifier found the transfer vet402 had linked did not carry the signature binding, so vet402 took its own inference back — after.status is the status the row held before the link and after.txHash drops it, and the seller is not refuted for a link vet402 made. Corrections unfavourable to vet402 are listed the same way; rows are never deleted.",
        disclaimer: PUBLIC_DISCLAIMER,
      },
      { headers: gate.cacheHeaders },
    );
  } catch (error) {
    logServerError("corrections.list", error);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: gate.headers });
  }
}
