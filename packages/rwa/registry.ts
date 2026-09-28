// The canonical Stock Tokens /rwa reconstructs (SPEC patch 018).
//
// registry.json is a frozen snapshot of Robinhood's own asset list (the table on
// https://docs.robinhood.com/chain/contracts, "generated live from the on-chain
// asset registry"), each address checked on chain, with Chainlink's equity feed
// for the tokens that have one. Robinhood's page is explicit that a token with a
// matching name or ticker at another address is not a Robinhood Stock Token, so
// canonical here means "at this address", never "called this". Rebuild it with
// packages/rwa/scripts/snapshot-registry.ts.
import snapshot from "./registry.json";

export type CanonicalToken = {
  symbol: string;
  name: string;
  isin: string;
  /** EIP-55 */
  token: string;
  /** Chainlink equity feed proxy (8 decimals), or null when Chainlink lists none for this token */
  feed: string | null;
  feed_description: string | null;
};

export const REGISTRY = snapshot as {
  taken_at: string;
  chain_id: number;
  sources: { tokens: string; tokens_page: string; feeds: string };
  counts: { listed: number; written: number; with_feed: number; rejected: number };
  tokens: CanonicalToken[];
};

export const CANONICAL_TOKENS: readonly CanonicalToken[] = REGISTRY.tokens;
const BY_ADDRESS = new Map(CANONICAL_TOKENS.map((t) => [t.token.toLowerCase(), t]));
/** Lower-cased canonical addresses (receipts and topics arrive lower-cased). */
export const CANONICAL_SET: ReadonlySet<string> = new Set(BY_ADDRESS.keys());

export function tokenByAddress(address: string): CanonicalToken | null {
  return BY_ADDRESS.get(address.toLowerCase()) ?? null;
}
