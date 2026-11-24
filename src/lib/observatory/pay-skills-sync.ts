// ============================================================
// pay-skills-listings-data.ts → x402_endpoints（source = pay_skills・2026-11-24）。
// catalog-sync-aux が Circle のあとに呼ぶ（operator と同型）。
// ============================================================
import { syncCatalog, type SyncSummary } from "./catalog-sync";
import { PAY_SKILLS_LISTINGS, PAY_SKILLS_SOURCE, paySkillsFetchResult, type PaySkillsListing } from "./pay-skills-listings";

export async function syncPaySkillsListings(
  options: { listings?: readonly PaySkillsListing[]; today?: string } = {},
): Promise<SyncSummary> {
  return syncCatalog({
    fetchResult: paySkillsFetchResult(options.listings ?? PAY_SKILLS_LISTINGS),
    today: options.today,
    source: PAY_SKILLS_SOURCE,
  });
}