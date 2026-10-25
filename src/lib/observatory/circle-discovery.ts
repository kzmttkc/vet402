// ============================================================
// vet402 Observatory L0 — Circle x402 discovery（2026-10-26）。
//
// Gateway で受ける Arc の売り手は Circle 自身の目録に載る。CDP Bazaar には
// 載らないものがある。ページの形（items + pagination.total）は Bazaar と同じ
// なので fetchFullCatalog を使う。違うのは limit の上限が 200 なこと
// （201 は HTTP 400）と、method / description が metadata にあること
// （parseCatalogItem が bazaar の無いときだけ読む）。
//
// cron は足さない。/api/cron/catalog-sync-aux（01:30 UTC・maxDuration 300）が
// MPP の後にこれを呼ぶ。締切は 60 秒。途中で止まっても読めたページは upsert し、
// complete=false のあいだ delist は出さない（CDP と同じ規則）。
// ============================================================
import { fetchFullCatalog, type CatalogFetchResult } from "./catalog-source";
import { syncCatalog, type SyncSummary } from "./catalog-sync";
import { CIRCLE_DISCOVERY_SOURCE, CIRCLE_DISCOVERY_URL } from "./listing-sources";

export { CIRCLE_DISCOVERY_SOURCE, CIRCLE_DISCOVERY_URL };

/** Circle の discovery API が受け付ける limit の上限（2026-10-26 実測: 201 は 400）。 */
export const CIRCLE_DISCOVERY_PAGE_LIMIT = 200;
/**
 * aux の maxDuration は 300 秒で、PayAI と MPP も同じ関数で動く。
 * Circle の取得はこの締切で打ち切り、残りを食わない。
 */
export const CIRCLE_FETCH_DEADLINE_MS = 60_000;
export const CIRCLE_FETCH_CONCURRENCY = 3;
const CIRCLE_FETCH_SLEEP_MS = 150;
const CIRCLE_PAGE_RETRIES = 5;
const CIRCLE_THROTTLE_RETRIES = 4;

/** 呼び出しが 200 を超えても、送る limit は 200 以下。 */
export function circlePageLimit(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested < 1) return CIRCLE_DISCOVERY_PAGE_LIMIT;
  return Math.min(Math.floor(requested), CIRCLE_DISCOVERY_PAGE_LIMIT);
}

export async function fetchCircleDiscovery(
  options: {
    fetchImpl?: (url: string) => Promise<Response>;
    pageLimit?: number;
    sleepMs?: number;
    maxRetriesPerPage?: number;
    concurrency?: number;
    deadlineMs?: number;
    maxThrottleRetries?: number;
  } = {},
): Promise<CatalogFetchResult> {
  return fetchFullCatalog({
    fetchImpl: options.fetchImpl,
    baseUrl: CIRCLE_DISCOVERY_URL,
    pageLimit: circlePageLimit(options.pageLimit),
    sleepMs: options.sleepMs ?? CIRCLE_FETCH_SLEEP_MS,
    maxRetriesPerPage: options.maxRetriesPerPage ?? CIRCLE_PAGE_RETRIES,
    concurrency: options.concurrency ?? CIRCLE_FETCH_CONCURRENCY,
    deadlineMs: options.deadlineMs ?? CIRCLE_FETCH_DEADLINE_MS,
    maxThrottleRetries: options.maxThrottleRetries ?? CIRCLE_THROTTLE_RETRIES,
  });
}

/** 本番配線: Circle の目録 → x402_endpoints（source = circle_discovery）。pay_to は目録の値で上書きする。 */
export async function syncCircleDiscovery(
  options: { fetchResult?: CatalogFetchResult; today?: string } = {},
): Promise<SyncSummary> {
  const fetchResult = options.fetchResult ?? (await fetchCircleDiscovery());
  return syncCatalog({ fetchResult, today: options.today, source: CIRCLE_DISCOVERY_SOURCE });
}
