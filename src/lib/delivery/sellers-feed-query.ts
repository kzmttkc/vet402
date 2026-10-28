// ============================================================
// GET /api/v1/delivery/sellers.json のクエリ（2026-10-28）。
// ============================================================
import type { FeedListedIn } from "./listed-in";

export type DeliverySellersQuery = {
  network: string | null;
  minDelivered: number | null;
  listedIn: FeedListedIn | null;
};

const CAIP2_QUERY =
  /^(?:eip155:[1-9]\d{0,14}|xrpl:\d+|solana:[1-9A-HJ-NP-Za-km-z]{32,44}|stellar:[a-z][a-z0-9-]*)$/;

const LISTED_IN_VALUES = new Set<string>(["bazaar", "circle", "mpp"]);

export function parseDeliverySellersQuery(params: URLSearchParams): DeliverySellersQuery | "invalid" {
  let network: string | null = null;
  let minDelivered: number | null = null;
  let listedIn: FeedListedIn | null = null;
  for (const [name, value] of params.entries()) {
    if (name === "network") {
      if (network !== null) return "invalid";
      if (!CAIP2_QUERY.test(value)) return "invalid";
      network = value;
    } else if (name === "min_delivered") {
      if (minDelivered !== null) return "invalid";
      if (!/^\d+$/.test(value)) return "invalid";
      const n = Number(value);
      if (n < 0 || n > 100_000) return "invalid";
      minDelivered = n;
    } else if (name === "listed_in") {
      if (listedIn !== null) return "invalid";
      if (!LISTED_IN_VALUES.has(value)) return "invalid";
      listedIn = value as FeedListedIn;
    } else {
      return "invalid";
    }
  }
  return { network, minDelivered, listedIn };
}
