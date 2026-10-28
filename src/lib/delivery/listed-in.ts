// ============================================================
// 配達フィードの listed_in 列（2026-10-28）。x402_endpoints.source を
// LISTING_SOURCES（listing-sources.ts）の 3 つの公開目録に寄せる。
// ============================================================
import { CATALOG_SOURCE } from "@/lib/observatory/catalog-source";
import { CIRCLE_DISCOVERY_SOURCE } from "@/lib/observatory/listing-sources";

export type FeedListedIn = "bazaar" | "circle" | "mpp";

const MPP_DIRECTORY_SOURCE = "mpp_directory";

export function feedListedIn(source: string): FeedListedIn | null {
  if (source === CATALOG_SOURCE) return "bazaar";
  if (source === CIRCLE_DISCOVERY_SOURCE) return "circle";
  if (source === MPP_DIRECTORY_SOURCE) return "mpp";
  return null;
}

/** SQL の CASE 式（e.source を前提）。 */
export const LISTED_IN_CASE_SQL = `CASE e.source
  WHEN '${CATALOG_SOURCE}' THEN 'bazaar'
  WHEN '${CIRCLE_DISCOVERY_SOURCE}' THEN 'circle'
  WHEN '${MPP_DIRECTORY_SOURCE}' THEN 'mpp'
  ELSE NULL
END`;
