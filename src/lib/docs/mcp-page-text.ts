// ============================================================
// /docs/mcp の固定英文（2026-10-28）。tests/mcp-plain-english.test.ts が検査する。
// ============================================================
import { DELIVERY_FEED_PAGE_SIZE } from "@/lib/delivery/sellers-feed";

export const MCP_DOCS_INTRO =
  "The hosted MCP server at https://vet402.com/mcp returns what vet402 recorded when it paid x402 listings: when each attempt happened, which chain it used, whether content came back, and the transaction hash where vet402 recorded one. " +
  "The endpoint is read only, needs no key, and costs nothing to call.";

export const MCP_DOCS_CONNECT_CURSOR =
  '{"mcpServers":{"vet402":{"type":"http","url":"https://vet402.com/mcp"}}}';

export const MCP_DOCS_PRIVACY =
  "vet402 counts MCP calls by client kind. The usage counts do not include raw URLs, IP addresses or User-Agent strings. The rate limit keeps the caller's IP for a short time, as the privacy policy says.";

export const MCP_DOCS_DELIVERED_ONE_LINER =
  "Delivered means a purchase row where vet402 settled on chain and then received a 2xx response other than 202 Accepted, with a body not recorded as empty, as defined at the methodology page.";

export const MCP_DOCS_CONTACT = "support@vet402.com";

export const MCP_DOCS_SETTLED_NOT_DELIVERED_FEED =
  "settled_not_delivered_30d uses the same rule as check_x402_seller delivery.settled_not_delivered: payment moved on chain with no delivery, and the count excludes vet402-side rows and rows held while HTTP outcomes stay inconclusive.";

export const MCP_DOCS_FEED_INTRO =
  "GET /api/v1/delivery/sellers.json lists active listings where vet402 made at least one signed purchase attempt in the last 30 days. Each JSON row is one listing. Rows sort by url, method and network ascending. " +
  `Pages hold at most ${DELIVERY_FEED_PAGE_SIZE.toLocaleString("en-US")} rows. Use next_cursor to continue.`;

export const MCP_DOCS_FEED_STALENESS =
  "The feed snapshot is cached in the vet402 process for 300 seconds. HTTP responses use Cache-Control public, s-maxage=300, stale-while-revalidate=600.";

export const MCP_DOCS_FEED_FILTERS =
  "Filters: network (a chain id vet402 recognizes, for example eip155:8453 or solana), min_delivered (integer 0 through 100000), listed_in (bazaar, circle or mpp) and cursor (continuation token). Any other query parameter returns 400.";

export const MCP_DOCS_FEED_FIELD_URL = "Listing URL (one row per listing).";
export const MCP_DOCS_FEED_FIELD_METHOD = "HTTP method of the listing.";
export const MCP_DOCS_FEED_FIELD_NETWORK = "CAIP-2 network id when the catalog stores a known chain.";
export const MCP_DOCS_FEED_FIELD_PRICE =
  "Listed price in dollars when the catalog holds a USDC amount with six decimal places.";
export const MCP_DOCS_FEED_FIELD_LISTED_IN = "Catalog source: bazaar, circle or mpp.";
export const MCP_DOCS_FEED_FIELD_BAZAAR_PAYERS = "Bazaar quality payers in the last 30 days, or null outside Bazaar.";
export const MCP_DOCS_FEED_FIELD_PAID = "Signed purchase attempts in the last 30 days (same window as check_x402_seller).";
export const MCP_DOCS_FEED_FIELD_DELIVERED = "Delivered purchases in that window (same rule as check_x402_seller delivery.delivered).";
export const MCP_DOCS_FEED_FIELD_LAST_ATTEMPT =
  "Latest signed attempt timestamp inside the 30 day window (UTC ISO8601), or null when there were no signed attempts in the window.";
export const MCP_DOCS_FEED_FIELD_LAST_DELIVERED =
  "Latest delivered attempt timestamp inside the 30 day window (UTC ISO8601), or null when vet402 recorded no delivery in the window.";

export const MCP_DOCS_FEED_FIELDS: { name: string; meaning: string }[] = [
  { name: "url", meaning: MCP_DOCS_FEED_FIELD_URL },
  { name: "method", meaning: MCP_DOCS_FEED_FIELD_METHOD },
  { name: "network", meaning: MCP_DOCS_FEED_FIELD_NETWORK },
  { name: "price_usd", meaning: MCP_DOCS_FEED_FIELD_PRICE },
  { name: "listed_in", meaning: MCP_DOCS_FEED_FIELD_LISTED_IN },
  { name: "bazaar_payers_30d", meaning: MCP_DOCS_FEED_FIELD_BAZAAR_PAYERS },
  { name: "paid_attempts_30d", meaning: MCP_DOCS_FEED_FIELD_PAID },
  { name: "delivered_30d", meaning: MCP_DOCS_FEED_FIELD_DELIVERED },
  { name: "settled_not_delivered_30d", meaning: MCP_DOCS_SETTLED_NOT_DELIVERED_FEED },
  { name: "last_attempt_at_30d", meaning: MCP_DOCS_FEED_FIELD_LAST_ATTEMPT },
  { name: "last_delivered_at_30d", meaning: MCP_DOCS_FEED_FIELD_LAST_DELIVERED },
  { name: "record_url", meaning: "Public observatory record for this listing." },
];

/** plain-english 検査用。ページに載る固定文を全部返す。 */
export function allMcpDocsFixedText(): string[] {
  return [
    MCP_DOCS_INTRO,
    MCP_DOCS_PRIVACY,
    MCP_DOCS_DELIVERED_ONE_LINER,
    MCP_DOCS_SETTLED_NOT_DELIVERED_FEED,
    MCP_DOCS_FEED_INTRO,
    MCP_DOCS_FEED_STALENESS,
    MCP_DOCS_FEED_FILTERS,
    ...MCP_DOCS_FEED_FIELDS.map((f) => f.meaning),
    "Public observatory record for this listing.",
  ];
}
