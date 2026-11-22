// ============================================================
// operator-listings.ts の一覧 → x402_endpoints（source = 'operator'・2026-11-22）。
//
// cron は足さない。/api/cron/catalog-sync-aux（01:30 UTC）が Circle の後にこれを呼ぶ。
// 書き込みは他の目録と同じ syncCatalog（snapshot・delisted・relisted も同じ規則）。
// 'operator' は Bazaar / Circle の共有行の対に入らないので、同じ URL が目録にもあれば別の行になる（MPP と同じ）。
// ============================================================
import { syncCatalog, type SyncSummary } from "./catalog-sync";
import { OPERATOR_LISTINGS, OPERATOR_SOURCE, operatorFetchResult, type OperatorListing } from "./operator-listings";

export async function syncOperatorListings(
  options: { listings?: readonly OperatorListing[]; today?: string } = {},
): Promise<SyncSummary> {
  return syncCatalog({
    fetchResult: operatorFetchResult(options.listings ?? OPERATOR_LISTINGS),
    today: options.today,
    source: OPERATOR_SOURCE,
  });
}
