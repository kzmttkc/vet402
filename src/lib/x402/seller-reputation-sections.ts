import { KEYLESS_READ_STOP, keylessResolvePerMinute } from "@/lib/api/keyless-limits";
import { SITE_URL } from "@/lib/site-url";
import { VERDICT_DOCS } from "@/lib/decision/rules-text";

/** Body copy for /x402/seller-reputation-api (HTML and .md share these strings). */
export const SELLER_REPUTATION_API = {
  path: "/x402/seller-reputation-api",
  title: "x402 seller reputation API",
  h1: "x402 seller reputation API",
  description:
    "Key-less GET /api/v1/check and GET /api/v1/resources/{resourceId}/decision return what vet402 recorded when it paid an x402 seller, with ALLOW, WARN, or BLOCK.",
  lead: [
    "An x402 seller reputation read is the JSON vet402 publishes from real purchases: recommendation, delivery counts, reason codes, verified_terms, and recent attempts.",
    "vet402 does not sell a separate reputation product. The same records back GET /api/v1/check and the hosted MCP tool check_x402_seller.",
  ] as const,
  sections: {
    curl: {
      title: "Call the API (no key)",
      body: `curl -sS "${SITE_URL}/api/v1/check?url=" + percent-encoded-https-url needs no API key. It shares the per-IP limit with POST /api/v1/resolve (${keylessResolvePerMinute()} requests a minute). ${KEYLESS_READ_STOP} Shapes and error codes are in the API reference at ${SITE_URL}/docs/api.`,
    },
    fields: {
      title: "Fields in the check response",
      body:
        "The document carries recommendation (ALLOW, WARN, or BLOCK), delivery (paid attempts and delivered counts in the window), reason_codes, verified_terms, verified_pay_to_by_network, rules_version, l1_purchases (recent attempts), and as_of (when the read finished).",
    },
    decision: {
      title: "Read by resource id",
      body: `When you already hold a resource_id, GET /api/v1/resources/{resourceId}/decision returns the same L0, L1, and L2 facts with the same recommendation field.`,
    },
    verdicts: {
      title: "ALLOW, WARN, and BLOCK",
      allow: VERDICT_DOCS.ALLOW,
      warn: VERDICT_DOCS.WARN,
      block: VERDICT_DOCS.BLOCK,
    },
  },
} as const;

export const SELLER_REPUTATION_CHECK_FIELDS: readonly { field: string; meaning: string }[] = [
  { field: "recommendation", meaning: "ALLOW, WARN, or BLOCK from vet402 purchase records" },
  { field: "delivery", meaning: "paid_attempts, delivered, settled_not_delivered, window_days for the seller URL" },
  { field: "reason_codes", meaning: "codes that explain the recommendation; listed at /docs/api#reason-codes" },
  { field: "verified_terms", meaning: "pay_to, asset, amount, network, scheme from the last delivered purchase" },
  { field: "l1_purchases", meaning: "recent signed attempts with chain, status, and settlement when recorded" },
  { field: "rules_version", meaning: "version of the published decision rules" },
  { field: "as_of", meaning: "UTC time when this read finished" },
];