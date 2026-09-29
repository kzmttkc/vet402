import { NextRequest, NextResponse } from "next/server";
import { publicRateLimit, PUBLIC_DISCLAIMER } from "@/lib/api/public-route";
import {
  CORRECTION_REASONS,
  CORRECTIONS_PAGE_MAX,
  countCorrections,
  decodeCorrectionCursor,
  encodeCorrectionCursor,
  listCorrections,
  type CorrectionCursor,
  type CorrectionReason,
} from "@/lib/observatory/corrections";
import { UUID_RE } from "@/lib/validation/uuid";
import { logServerErrorSafe } from "@/lib/util/log-safe";

// §10: GET /api/v1/observatory/corrections?endpoint=<uuid>&reason=&limit=&cursor=
// 公開判定が後から変わった記録（before/after）。自社に不利な訂正も同じ表から出す。
// 2026-09-29 監査 5 周目（データ記者）: /corrections の「Ledger status changes: 4,617」に対し、この API は
// 最新 500 件しか返せず、before / offset も効かなかった（全件を数え直せない）。1 頁の上限は 500 のまま、
// (created_at, id) の組のカーソルで最後まで遡れるようにし、フィルタに合う総数（total）を同じ応答に載せる。
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  const gate = await publicRateLimit(request, "corrections", 60);
  if (!gate.ok) return gate.response;
  const endpoint = request.nextUrl.searchParams.get("endpoint");
  if (endpoint && !UUID_RE.test(endpoint)) {
    return NextResponse.json({ error: "invalid_endpoint_id" }, { status: 400, headers: gate.headers });
  }
  const reasonRaw = request.nextUrl.searchParams.get("reason");
  if (reasonRaw !== null && !(CORRECTION_REASONS as readonly string[]).includes(reasonRaw)) {
    return NextResponse.json({ error: "invalid_reason" }, { status: 400, headers: gate.headers });
  }
  const reason = (reasonRaw ?? undefined) as CorrectionReason | undefined;
  const cursorRaw = request.nextUrl.searchParams.get("cursor");
  let before: CorrectionCursor | undefined;
  if (cursorRaw !== null) {
    const decoded = decodeCorrectionCursor(cursorRaw);
    if (!decoded) return NextResponse.json({ error: "invalid_cursor" }, { status: 400, headers: gate.headers });
    before = decoded;
  }
  const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? 100);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 100, 1), CORRECTIONS_PAGE_MAX);
  try {
    const filter = { endpointId: endpoint ?? undefined, reason };
    const [corrections, total] = await Promise.all([listCorrections({ ...filter, limit, before }), countCorrections(filter)]);
    const last = corrections[corrections.length - 1];
    const nextCursor = corrections.length === limit && last ? encodeCorrectionCursor(last) : null;
    return NextResponse.json(
      {
        corrections,
        /**
         * total: フィルタ（endpoint・reason）に合う訂正ログの行の総数（カーソルによらない）。
         * /corrections の見出しの 2 つの数はこの total を reason で分けたもの。
         */
        total,
        page: {
          limit,
          returned: corrections.length,
          nextCursor,
          order: "created_at DESC, id DESC",
          howToPage:
            "Pass nextCursor back as ?cursor= (with the same endpoint and reason) to read the next older page; nextCursor is null on the last page. Rows appended after your first request land at the top and do not shift the pages below your cursor, so paging from one starting point to the end returns each row that existed at that point exactly once.",
        },
        totalDefinition:
          "total counts the rows of the correction log that match endpoint and reason, regardless of cursor. On /corrections, 'Corrections' is the hand-written entries plus the rows whose reason is not settlement_backfill (reason=dispute_remeasure, reverify or path_template), and 'Ledger status changes' is the rows whose reason is settlement_backfill (?reason=settlement_backfill returns that total). A ledger status change is not an error correction; it is listed here so that the path from claim to confirmation can be audited.",
        definition:
          "Each row is a public verdict that changed after publication: dispute_remeasure (a seller's signed dispute triggered a re-measurement that overturned the verdict), settlement_backfill (a settlement moved up or down the ledger on on-chain evidence), reverify (a C4 re-verification overturned the verdict; since 2026-09-29 also a re-probe of a published L0 fail that rested on probes recorded under the rules before 2026-09-29, marked after.trigger=rule_change_reprobe), path_template (a fail measured against an unfilled URL template, returned to unverified). subject_id is an endpoint id when subject_type is endpoint and a purchase id when it is purchase; the purchase id is the purchase_id column of /api/v1/observatory/export.csv. before/after are the published values, and for settlement_backfill the settlement_path field names the path a row took, derived from before/after when the row is read (the stored values are not changed). verified_settled: before.status settle_claimed and vet402 re-read the transfer on-chain, after.status settled. claim_refuted: the transfer the seller asserted was not there, after.status settle_claim_refuted, a row against the seller. seller_named_tx_promoted: before.status delivered_no_receipt or settle_failed with a transaction the seller itself named in its PAYMENT-RESPONSE although the receipt did not say success; before.txHash and after.txHash are the same seller-named hash and the row went to the verifier as the seller's claim, so the export keeps settlement_source=seller_claim for it. vet402_index_link: the seller named no usable transaction (before.txHash empty, or a claimed hash that did not verify on a settle_claimed_unverifiable row) and vet402's own settlement index linked a transfer from our payer to that endpoint's payee, for the expected amount, inside the attempt window, that no other purchase could be claiming; after.status is settle_claimed, never settled, because a transfer that fits is not a proof that it belongs to that purchase, and the row then passes the same on-chain verifier as a seller-asserted one (the export marks it settlement_source=vet402_index once settled). late_link_withdrawn (after.lateLinkWithdrawn): that verifier could not confirm the linked transfer belonged to that purchase, so vet402 took its own inference back — after.status is the status the row held before the link, after.txHash drops the transaction vet402 had attached (it can carry the seller's own claimed hash again, for rows that came from settle_claimed_unverifiable), and the seller is not refuted for a link vet402 made; after.lateLinkWithdrawn carries the verifier's reason, so read the field rather than assuming it. seller_named_tx_declined (after.sellerDeclaredUnsettled): a seller-named transaction that the seller's own receipt had called unsuccessful did not verify, so the row returned to its earlier status without refuting the seller. other: a shape none of these names fit. Corrections unfavourable to vet402 are listed the same way; rows are never deleted.",
        disclaimer: PUBLIC_DISCLAIMER,
      },
      { headers: gate.cacheHeaders },
    );
  } catch (error) {
    logServerErrorSafe("corrections.list", error);
    return NextResponse.json({ error: "unavailable" }, { status: 503, headers: gate.headers });
  }
}
