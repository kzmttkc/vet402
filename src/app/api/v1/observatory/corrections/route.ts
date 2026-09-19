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
          "Each row is a public verdict that changed after publication: dispute_remeasure (a seller's signed dispute triggered a re-measurement that overturned the verdict), settlement_backfill (a settlement moved up or down the ledger on on-chain evidence), reverify (a C4 re-verification overturned the verdict). before/after are the published values, and for settlement_backfill they say which of two paths a row took: before.status settle_claimed means the seller had asserted a settlement and vet402 then re-read it on-chain (after.status settled) or found it did not hold (settle_claim_refuted); before.status settle_failed or delivered_no_receipt means the seller named no usable transaction and vet402's own settlement index linked a transfer from our payer to that endpoint's payee, for the expected amount, inside the attempt window, that no other purchase could be claiming — such a row is linked at settle_claimed, not at settled, and passes through the same on-chain verifier as a seller-asserted row before it can be promoted. Corrections unfavourable to vet402 are listed the same way; rows are never deleted.",
        disclaimer: PUBLIC_DISCLAIMER,
      },
      { headers: gate.cacheHeaders },
    );
  } catch (error) {
    logServerError("corrections.list", error);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: gate.headers });
  }
}
