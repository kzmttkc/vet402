// Indexed seller pages: ItemPage + Dataset JSON-LD (2026-11-28 SEO/AEO).
// Pure builders from SellerDetail — no DB. Numbers come from the same fields the page prints.
import { datasetJsonLd, publisherOrg, type VariableMeasuredEntry } from "@/lib/seo";
import { SITE_URL } from "@/lib/site-url";
import { exportDaysFor, sellerHeadline, type SellerDetail } from "./board";
import { SELLER_INDEX_DELIVERY_WINDOW_DAYS } from "./seller-index";
import {
  deliveredListings,
  reputationHeadline,
  reputationHostEvidence,
  reputationSellerPath,
} from "./reputation";
import { sellerDescription, sellerHeading, sellerPath } from "@/components/site/sellers/SellersViews";

const SELLER_RECORD_TECHNIQUE =
  "Each active Base listing for the host is shown with the latest purchase vet402 paid for. " +
  "Each row is sorted with the same function as /sellers and /api/v1/sellers/export.csv (classifySellerRow in fix-modes.ts). " +
  "Delivered means the purchase settled and returned HTTP 2xx other than 202 Accepted with a non-empty body.";

const SELLER_REPUTATION_TECHNIQUE =
  "Each Base listing vet402 bought where the latest purchase delivered a response. " +
  "Delivery age is measured from the purchase attempt time to the ledger read time on this page (same rules as GET /api/v1/check for this host).";

function ledgerExportWindowDays(detail: SellerDetail): number {
  const head = sellerHeadline(detail);
  const now = Date.parse(detail.fetchedAt);
  if (head.at && Number.isFinite(now)) {
    const d = exportDaysFor(head.at, now);
    if (d !== null) return Math.max(d, SELLER_INDEX_DELIVERY_WINDOW_DAYS);
  }
  return SELLER_INDEX_DELIVERY_WINDOW_DAYS;
}

export function sellerRecordVariableMeasured(detail: SellerDetail): VariableMeasuredEntry[] {
  const head = sellerHeadline(detail);
  const s = detail.summary;
  const v = detail.sellerView;
  const entries: VariableMeasuredEntry[] = [
    { name: "Base listings", value: s.listings },
    { name: "Latest result delivered (per listing)", value: v.delivered },
    { name: "Latest result failed on the seller's side (per listing)", value: v.seller },
    { name: "Listings with no delivered or seller-side result among attempts shown", value: v.none },
    { name: "Base listings with no purchase attempt", value: s.notTried },
  ];
  if (head.at) {
    entries.push({ name: "Latest purchase attempt time", value: head.at });
  }
  entries.push({ name: "Ledger read time", value: detail.fetchedAt });
  return entries;
}

export function sellerReputationVariableMeasured(detail: SellerDetail): VariableMeasuredEntry[] {
  const listings = deliveredListings(detail);
  const evidence = reputationHostEvidence(detail);
  const entries: VariableMeasuredEntry[] = [
    { name: "Listings where the latest purchase delivered", value: listings.length },
    { name: "Ledger read time", value: detail.fetchedAt },
  ];
  if (evidence.days_since_last_delivery !== null) {
    entries.push({
      name: "Days since the newest delivered purchase",
      value: evidence.days_since_last_delivery,
      unitText: "day",
    });
  }
  if (evidence.last_delivered_at) {
    entries.push({ name: "Newest delivered purchase time", value: evidence.last_delivered_at });
  }
  return entries;
}

export function sellerItemPageJsonLd(
  detail: SellerDetail,
  path: string,
  name: string,
  description: string,
  dateModified: string | null,
) {
  return {
    "@context": "https://schema.org",
    "@type": "ItemPage" as const,
    name,
    description,
    url: `${SITE_URL}${path}`,
    ...(dateModified ? { dateModified } : {}),
    isBasedOn: `${SITE_URL}/observatory/methodology`,
    publisher: publisherOrg(),
    about: { "@type": "Thing" as const, name: detail.host, identifier: detail.host },
  };
}

export function sellerPurchaseRecordDatasetJsonLd(detail: SellerDetail) {
  const head = sellerHeadline(detail);
  const path = sellerPath(detail.host);
  const name = sellerHeading(detail.host, head.at, head.chain);
  const description = sellerDescription(detail.host, head.chain);
  const days = ledgerExportWindowDays(detail);
  return datasetJsonLd({
    name,
    citeName: `seller purchase record for ${detail.host}`,
    description,
    path,
    citeUrl: `${SITE_URL}${path}`,
    // Data time: the newest purchase attempt the page shows (sellerHeadline), not the read time.
    ...(head.at ? { dateModified: head.at } : {}),
    retrievedAt: detail.fetchedAt,
    measurementTechnique: SELLER_RECORD_TECHNIQUE,
    variableMeasured: sellerRecordVariableMeasured(detail),
    keywords: ["x402", "HTTP 402", detail.host, "seller purchase record", "Base"],
    distribution: [
      {
        name: "Base listing outcomes for all sellers (CSV). Filter rows where host matches this seller",
        encodingFormat: "text/csv",
        contentUrl: `${SITE_URL}/api/v1/sellers/export.csv`,
      },
      {
        name: "Purchase ledger (CSV). Filter rows by resource_key for this host",
        encodingFormat: "text/csv",
        contentUrl: `${SITE_URL}/api/v1/observatory/export.csv?days=${days}`,
      },
    ],
  });
}

export function sellerReputationDatasetJsonLd(detail: SellerDetail) {
  const path = reputationSellerPath(detail.host);
  const name = reputationHeadline(detail.host, detail);
  const description = `vet402 purchase records for ${detail.host}: each listing vet402 bought with a real x402 payment where the latest purchase delivered a response, with delivery age on each row.`;
  return datasetJsonLd({
    name,
    citeName: `seller delivery record for ${detail.host}`,
    description,
    path,
    citeUrl: `${SITE_URL}${path}`,
    dateModified: detail.fetchedAt,
    retrievedAt: detail.fetchedAt,
    measurementTechnique: SELLER_REPUTATION_TECHNIQUE,
    variableMeasured: sellerReputationVariableMeasured(detail),
    keywords: ["x402", "HTTP 402", detail.host, "seller delivery", "delivery age"],
    distribution: [
      {
        name: "Seller delivery feed for listed endpoints (JSON). Filter rows by url host",
        encodingFormat: "application/json",
        contentUrl: `${SITE_URL}/api/v1/delivery/sellers.json`,
      },
      {
        name: "Purchase ledger (CSV). Filter rows by resource_key for this host",
        encodingFormat: "text/csv",
        contentUrl: `${SITE_URL}/api/v1/observatory/export.csv?days=${SELLER_INDEX_DELIVERY_WINDOW_DAYS}`,
      },
    ],
  });
}