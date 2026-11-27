import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { x402CatalogSnapshots } from "@/lib/db/schema";
import { fetchFullCatalog, type CatalogFetchResult } from "./catalog-source";
import { RAIL402_DISCOVERY_URL } from "./listing-sources";

type Db = NonNullable<ReturnType<typeof getDb>>;

export async function recordSnapshotOnlyCatalog(
  db: Db,
  source: string,
  result: CatalogFetchResult | null,
  snapshotDate: string,
): Promise<void> {
  const failed =
    result === null || (result.fetchedCount === 0 && !result.complete);
  const totalCount = failed ? 0 : result.totalCount;
  const fetchedCount = failed ? 0 : result.fetchedCount;
  const resourceKeys = failed ? [] : result.items.map((i) => i.resourceKey);
  const complete = failed ? false : result.complete;
  await db.execute(sql`
    INSERT INTO x402_catalog_snapshots (snapshot_date, source, total_count, fetched_count, resource_keys, complete)
    VALUES (${snapshotDate}::text, ${source}::text, ${totalCount}::int, ${fetchedCount}::int, ${JSON.stringify(resourceKeys)}::jsonb, ${complete}::boolean)
    ON CONFLICT (snapshot_date, source) DO UPDATE
      SET total_count = excluded.total_count,
          fetched_count = excluded.fetched_count,
          resource_keys = excluded.resource_keys,
          complete = excluded.complete
      WHERE excluded.complete OR x402_catalog_snapshots.complete IS NOT TRUE`);
}

export type SnapshotOnlyDeps = {
  fetchCatalog?: typeof fetchFullCatalog;
  record?: typeof recordSnapshotOnlyCatalog;
  today?: string;
};

/** 件数の写しを 1 つの出どころについて取る（Rail402・Blocky402 の試験網）。取れなければ失敗の写しを残す。 */
export async function syncSnapshotOnlyCatalog(
  source: string,
  baseUrl: string,
  deps: SnapshotOnlyDeps = {},
): Promise<{
  source: string;
  totalCount: number;
  fetchedCount: number;
  complete: boolean;
}> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const today = deps.today ?? new Date().toISOString().slice(0, 10);
  const fetchCatalog = deps.fetchCatalog ?? fetchFullCatalog;
  const record = deps.record ?? recordSnapshotOnlyCatalog;
  let result: CatalogFetchResult | null = null;
  try {
    result = await fetchCatalog({ baseUrl, pageLimit: 100, deadlineMs: 20_000 });
  } catch {
    result = null;
  }
  await record(db, source, result, today);
  if (!result) return { source, totalCount: 0, fetchedCount: 0, complete: false };
  return {
    source,
    totalCount: result.totalCount,
    fetchedCount: result.fetchedCount,
    complete: result.complete,
  };
}

export async function syncRail402Discovery(deps: SnapshotOnlyDeps = {}) {
  return syncSnapshotOnlyCatalog("rail402_discovery", RAIL402_DISCOVERY_URL, deps);
}
