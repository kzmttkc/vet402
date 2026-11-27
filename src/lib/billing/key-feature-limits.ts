/**
 * Per-key feature caps enforced by the API. Public pricing and legal copy read
 * these constants so digits cannot drift from enforcement.
 */
export { MAX_WEBHOOKS_PER_KEY } from "@/lib/webhooks";
export { MAX_WATCHLIST_PER_KEY } from "@/lib/watchlist";

/** Observatory payee-wallet claims per API key (GET/POST /api/v1/observatory/watch). */
export const MAX_OBSERVATORY_WATCH_CLAIMS_PER_KEY = 20;