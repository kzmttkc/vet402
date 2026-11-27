// ============================================================
// vet402 Observatory L0 — Blocky402 discovery（2026-11-27・Hedera レーン）。
//
// Blocky402 は Hedera の x402 facilitator。/discovery/resources の形（items + pagination.total・
// extensions.bazaar）は CDP Bazaar と同じなので fetchFullCatalog / parseCatalogItem をそのまま使う。
// 2026-11-27 実測: 本番 1 件（Agent Weather の id-mint・hedera:mainnet の HBAR）、試験 2 件（hedera:testnet）。
//
//   本番  https://api.blocky402.com/discovery/resources        → x402_endpoints（source = blocky402_discovery）
//   試験  https://api.testnet.blocky402.com/discovery/resources → 件数の写しだけ（x402_catalog_snapshots・
//         source = blocky402_testnet_discovery）。試験網の出品を本番の L0 / L1 の対象に入れない
//         （Rail402 と同じ snapshot-only の扱い）。
//
// cron は足さない。/api/cron/catalog-sync-aux（01:30 UTC）が Circle の後に呼ぶ。締切は各 20 秒。
// 途中で止まっても読めたページは upsert し、complete=false のあいだ delist は出さない（CDP と同じ規則）。
// ============================================================
import { fetchFullCatalog, type CatalogFetchResult } from "./catalog-source";
import { syncCatalog, type SyncSummary } from "./catalog-sync";
import { BLOCKY402_DISCOVERY_SOURCE, BLOCKY402_DISCOVERY_URL, BLOCKY402_TESTNET_DISCOVERY_SOURCE, BLOCKY402_TESTNET_DISCOVERY_URL } from "./listing-sources";
import { syncSnapshotOnlyCatalog, type SnapshotOnlyDeps } from "./snapshot-only-catalogs";

export { BLOCKY402_DISCOVERY_SOURCE, BLOCKY402_DISCOVERY_URL };

export const BLOCKY402_FETCH_DEADLINE_MS = 20_000;

export async function fetchBlocky402Discovery(
  options: { fetchImpl?: (url: string) => Promise<Response>; baseUrl?: string } = {},
): Promise<CatalogFetchResult> {
  return fetchFullCatalog({
    fetchImpl: options.fetchImpl,
    baseUrl: options.baseUrl ?? BLOCKY402_DISCOVERY_URL,
    pageLimit: 100,
    sleepMs: 150,
    maxRetriesPerPage: 3,
    deadlineMs: BLOCKY402_FETCH_DEADLINE_MS,
  });
}

/** 本番配線: Blocky402（Hedera mainnet）の目録 → x402_endpoints（source = blocky402_discovery）。 */
export async function syncBlocky402Discovery(
  options: { fetchResult?: CatalogFetchResult; today?: string } = {},
): Promise<SyncSummary> {
  const fetchResult = options.fetchResult ?? (await fetchBlocky402Discovery());
  return syncCatalog({ fetchResult, today: options.today, source: BLOCKY402_DISCOVERY_SOURCE });
}

/** 試験網の目録は件数の写しだけ（x402_endpoints には入れない）。 */
export async function syncBlocky402TestnetDiscovery(deps: SnapshotOnlyDeps = {}) {
  return syncSnapshotOnlyCatalog(BLOCKY402_TESTNET_DISCOVERY_SOURCE, BLOCKY402_TESTNET_DISCOVERY_URL, deps);
}
