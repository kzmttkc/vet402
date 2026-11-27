// ============================================================
// I4 (2026-11-27): /sellers/{host} index gate — delivered in the window or payee claim.
// Pure rules live here; host sets come from reader.ts + cached.ts.
// ============================================================
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db/client";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/public-read-revalidate";
import { parseSellerHostParam } from "./host";
import { getSellerBoardCached } from "./cached";
import { HOST_BADGE_WINDOW_DAYS, readHostsWithDeliveredInWindow, readHostsWithPayeeClaim } from "./reader";

/** Same 30-day window as the host badge and export.csv?days=30. */
export const SELLER_INDEX_DELIVERY_WINDOW_DAYS = HOST_BADGE_WINDOW_DAYS;

type Db = NonNullable<ReturnType<typeof getDb>>;

export type SellerIndexGate = {
  host: string;
  /** At least one delivered purchase on this host in the last SELLER_INDEX_DELIVERY_WINDOW_DAYS. */
  deliveredWithinWindow: boolean;
  /** Host-bound payee claim, or a wallet claim when this host is not undelivered-only on the latest row. */
  payeeClaimed: boolean;
};

/** Whether /sellers/{host} (and the parallel /x402/sellers/{host} surface) may leave noindex. */
export function sellerPageIndexable(gate: SellerIndexGate): boolean {
  if (parseSellerHostParam(gate.host) !== gate.host) return false;
  return gate.deliveredWithinWindow || gate.payeeClaimed;
}

export function sellerIndexGateOf(
  host: string,
  deliveredHosts: ReadonlySet<string>,
  claimedHosts: ReadonlySet<string>,
): SellerIndexGate {
  return {
    host,
    deliveredWithinWindow: deliveredHosts.has(host),
    payeeClaimed: claimedHosts.has(host),
  };
}

export type SellerIndexCounts = {
  /** Hosts that pass sellerPageIndexable (same set the sitemap uses for /sellers/{host}). */
  indexablePages: number;
  /** Seller URLs written to sitemap output (equals indexablePages for the /sellers/ lane). */
  sitemapUrls: number;
};

export function sellerIndexCounts(hosts: readonly string[]): SellerIndexCounts {
  const n = hosts.length;
  return { indexablePages: n, sitemapUrls: n };
}

/** Board hosts that pass the gate, sorted. Hosts missing from both sets stay out (C1). */
export function selectIndexableSellerHosts(
  boardHosts: readonly string[],
  deliveredHosts: ReadonlySet<string>,
  claimedHosts: ReadonlySet<string>,
): string[] {
  const out = boardHosts.filter((h) => sellerPageIndexable(sellerIndexGateOf(h, deliveredHosts, claimedHosts)));
  return [...new Set(out)].sort((a, b) => a.localeCompare(b));
}

/** Reads both host sets and applies the gate. A failed read throws; callers treat that as "list none". */
export async function readIndexableSellerHosts(db: Db, boardHosts: readonly string[]): Promise<string[]> {
  const [deliveredHosts, claimedHosts] = await Promise.all([
    readHostsWithDeliveredInWindow(db, SELLER_INDEX_DELIVERY_WINDOW_DAYS),
    readHostsWithPayeeClaim(db),
  ]);
  return selectIndexableSellerHosts(boardHosts, deliveredHosts, claimedHosts);
}

async function collectIndexableSellerHosts(): Promise<string[]> {
  const db = getDb();
  if (!db) return [];
  const board = await getSellerBoardCached();
  return readIndexableSellerHosts(
    db,
    board.sellers.map((s) => s.host),
  );
}

export const getIndexableSellerHostsCached: () => Promise<string[]> = unstable_cache(
  collectIndexableSellerHosts,
  ["sellers:indexable-hosts:v1"],
  { revalidate: PUBLIC_READ_REVALIDATE, tags: ["observatory"] },
);

export async function readSellerIndexCounts(): Promise<SellerIndexCounts> {
  const hosts = await getIndexableSellerHostsCached().catch(() => [] as string[]);
  return sellerIndexCounts(hosts);
}
