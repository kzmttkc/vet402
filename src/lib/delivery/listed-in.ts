// ============================================================
// 配達フィードの listed_in 列（2026-10-28）。x402_endpoints.source を
// LISTING_SOURCES（listing-sources.ts）の 3 つの公開目録に寄せる。
// 'operator'（2026-11-22）は目録ではなく、vet402 が自分で足した出品（operator-listings.ts）。
// ============================================================
import { CATALOG_SOURCE } from "@/lib/observatory/catalog-source";
import { CIRCLE_DISCOVERY_SOURCE } from "@/lib/observatory/listing-sources";
import { OPERATOR_SOURCE } from "@/lib/observatory/operator-listings";
import { PAY_SKILLS_SOURCE } from "@/lib/observatory/pay-skills-listings";

export type FeedListedIn = "bazaar" | "circle" | "mpp" | "operator" | "pay_skills";

const MPP_DIRECTORY_SOURCE = "mpp_directory";

export function feedListedIn(source: string): FeedListedIn | null {
  if (source === CATALOG_SOURCE) return "bazaar";
  if (source === CIRCLE_DISCOVERY_SOURCE) return "circle";
  if (source === MPP_DIRECTORY_SOURCE) return "mpp";
  if (source === OPERATOR_SOURCE) return "operator";
  if (source === PAY_SKILLS_SOURCE) return "pay_skills";
  return null;
}

/** SQL の CASE 式（e.source を前提）。 */
export const LISTED_IN_CASE_SQL = `CASE e.source
  WHEN '${CATALOG_SOURCE}' THEN 'bazaar'
  WHEN '${CIRCLE_DISCOVERY_SOURCE}' THEN 'circle'
  WHEN '${MPP_DIRECTORY_SOURCE}' THEN 'mpp'
  WHEN '${OPERATOR_SOURCE}' THEN 'operator'
  WHEN '${PAY_SKILLS_SOURCE}' THEN 'pay_skills'
  ELSE NULL
END`;
