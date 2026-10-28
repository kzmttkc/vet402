// ============================================================
// GET /api/v1/delivery/sellers.json のクエリ（2026-10-28・点検 H4）。
// ============================================================
import { canonicalNetworkId, isKnownNetworkFilterInput, networkFilterIds } from "@/lib/observatory/chains";
import type { FeedListedIn } from "./listed-in";

export type DeliverySellersQuery = {
  network: string | null;
  minDelivered: number | null;
  listedIn: FeedListedIn | null;
  cursor: string | null;
};

const LISTED_IN_VALUES = new Set<string>(["bazaar", "circle", "mpp"]);

export type FeedCursor = { url: string; method: string; network: string | null };

export function compareFeedRows(
  a: Pick<FeedCursor, "url" | "method" | "network">,
  b: Pick<FeedCursor, "url" | "method" | "network">,
): number {
  const u = a.url.localeCompare(b.url);
  if (u !== 0) return u;
  const m = a.method.localeCompare(b.method);
  if (m !== 0) return m;
  const na = a.network ?? "";
  const nb = b.network ?? "";
  return na.localeCompare(nb);
}

export function encodeFeedCursor(c: FeedCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeFeedCursor(raw: string): FeedCursor | "invalid" {
  try {
    const j = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (typeof j !== "object" || j === null) return "invalid";
    const o = j as Record<string, unknown>;
    if (typeof o.url !== "string" || typeof o.method !== "string") return "invalid";
    const network = o.network === null || o.network === undefined ? null : String(o.network);
    if (network !== null && network === "") return "invalid";
    return { url: o.url, method: o.method, network };
  } catch {
    return "invalid";
  }
}

function isKnownNetworkQuery(value: string): boolean {
  return isKnownNetworkFilterInput(value);
}

export function parseDeliverySellersQuery(params: URLSearchParams): DeliverySellersQuery | "invalid" {
  let network: string | null = null;
  let minDelivered: number | null = null;
  let listedIn: FeedListedIn | null = null;
  let cursor: string | null = null;
  for (const [name, value] of params.entries()) {
    if (name === "network") {
      if (network !== null) return "invalid";
      if (!isKnownNetworkQuery(value)) return "invalid";
      network = canonicalNetworkId(value);
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
    } else if (name === "cursor") {
      if (cursor !== null) return "invalid";
      if (value === "" || decodeFeedCursor(value) === "invalid") return "invalid";
      cursor = value;
    } else {
      return "invalid";
    }
  }
  return { network, minDelivered, listedIn, cursor };
}

/** 文書に許す network クエリの例（chains.ts の NETWORK_FILTER_SPELLINGS から代表）。 */
export const DELIVERY_FEED_NETWORK_QUERY_EXAMPLES = [
  "eip155:8453",
  "eip155:5042",
  "eip155:42220",
  "solana",
  "stellar:pubnet",
] as const;
