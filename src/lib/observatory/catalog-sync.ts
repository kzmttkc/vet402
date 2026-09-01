// ============================================================
// vet402 Observatory L0 — catalog sync orchestrator (design §3).
//
// One run = one day: fetch the full Bazaar catalog, upsert endpoint rows,
// diff against the LAST snapshot BEFORE today, record events, write today's
// snapshot. Re-running the same day is idempotent by construction:
//  - the diff base excludes today's own snapshot (snapshot_date < today),
//  - delisted is suppressed for endpoints already status='delisted',
//  - settle_drop compares against the STORED call count, which the first
//    run of the day already advanced.
//
// No scoring/chain imports. Writers here are trusted-cron-only — nothing in
// this module is reachable from a request handler that accepts user input.
// ============================================================
import { canonicalUrl, endpointHash, payeeId, resourceId } from "@/lib/ids/canonical";
import { and, eq, inArray, lt, desc, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import {
  x402CatalogSnapshots,
  x402DelistingEvents,
  x402Endpoints,
} from "@/lib/db/schema";
import {
  CATALOG_SOURCE,
  fetchFullCatalog,
  type CatalogFetchResult,
  type ParsedCatalogItem,
} from "./catalog-source";
import { computeCatalogDiff, type CatalogDiffEvent, type KnownEndpointState } from "./catalog-diff";
import { logServerError } from "@/lib/util/log";

export type SyncSummary = {
  snapshotDate: string;
  totalCount: number;
  fetchedCount: number;
  complete: boolean;
  upserted: number;
  /** Rows the DB refused even alone (post-sanitation poison). Never silent: reported here and logged. */
  skipped: number;
  events: CatalogDiffEvent[];
};

/** Keep each INSERT under Postgres' 65535-parameter ceiling (~20 cols × 500 rows ≈ 10k). */
const UPSERT_CHUNK = 500;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function syncCatalog(
  options: {
    /** Injectable for tests; production omits it and fetches live. */
    fetchResult?: CatalogFetchResult;
    /** 'YYYY-MM-DD'; injectable for tests. */
    today?: string;
    source?: string;
  } = {},
): Promise<SyncSummary> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");

  const source = options.source ?? CATALOG_SOURCE;
  const today = options.today ?? todayUtc();
  const result = options.fetchResult ?? (await fetchFullCatalog());

  const currentKeys = new Set(result.items.map((i) => i.resourceKey));

  // ---- known state BEFORE any write (the diff needs yesterday's view) ----
  const knownRows = await db
    .select({
      id: x402Endpoints.id,
      resourceKey: x402Endpoints.resourceKey,
      status: x402Endpoints.status,
      qualityCalls30d: x402Endpoints.qualityCalls30d,
    })
    .from(x402Endpoints)
    .where(eq(x402Endpoints.source, source));
  const knownEndpoints = new Map<string, KnownEndpointState>(
    knownRows.map((r) => [r.resourceKey, { status: r.status, qualityCalls30d: r.qualityCalls30d }]),
  );
  const idByKey = new Map(knownRows.map((r) => [r.resourceKey, r.id]));

  // ---- previous snapshot: the latest STRICTLY BEFORE today ----
  const prevSnapshot = await db
    .select({
      resourceKeys: x402CatalogSnapshots.resourceKeys,
    })
    .from(x402CatalogSnapshots)
    .where(and(eq(x402CatalogSnapshots.source, source), lt(x402CatalogSnapshots.snapshotDate, today)))
    .orderBy(desc(x402CatalogSnapshots.snapshotDate))
    .limit(1);
  const prevKeys =
    prevSnapshot.length > 0 && Array.isArray(prevSnapshot[0].resourceKeys)
      ? new Set(prevSnapshot[0].resourceKeys as string[])
      : null;

  // ---- diff (pure) ----
  const events = computeCatalogDiff({
    prevKeys,
    currentKeys,
    currentComplete: result.complete,
    knownEndpoints,
    currentQuality: new Map(result.items.map((i) => [i.resourceKey, i.qualityCalls30d])),
  });

  // ---- upsert endpoints (chunked, row-fallback on chunk failure) ----
  // Live lesson (2026-08-14): ONE catalog item with a NUL byte failed its
  // whole 500-row chunk and with it the day's sync. parseCatalogItem now
  // sanitizes NUL, but the class of "one seller's bytes poison the batch"
  // stays: on a chunk failure, retry row-by-row and skip only what the DB
  // refuses — counted in `skipped`, never silently.
  let upserted = 0;
  let skipped = 0;
  // §5 canonical ID（2026-09-02）。method 未宣言は GET（§6.1 と同じ既定）。
  const idsOf = (item: ParsedCatalogItem) => {
    const c = canonicalUrl(item.resourceUrl);
    return {
      canonicalUrl: c?.url ?? null,
      resourceId: resourceId(item.method ?? "GET", item.resourceUrl),
      endpointHash: endpointHash(item.resourceUrl),
      payeeId: item.payTo && item.network ? payeeId(item.network, item.payTo) : null,
      undeclaredQuery: c?.undeclaredQuery ?? null,
    };
  };
  const upsertChunk = async (chunk: ParsedCatalogItem[]) => {
    await db
      .insert(x402Endpoints)
      .values(
        chunk.map((item: ParsedCatalogItem) => ({
          resourceKey: item.resourceKey,
          resourceUrl: item.resourceUrl,
          source,
          method: item.method,
          network: item.network,
          payTo: item.payTo,
          priceAmount: item.priceAmount,
          priceAsset: item.priceAsset,
          description: item.description,
          declaredSchema: item.declaredSchema,
          qualityCalls30d: item.qualityCalls30d,
          qualityPayers30d: item.qualityPayers30d,
          qualityLastCalledAt: item.qualityLastCalledAt,
          rawAccepts: item.rawAccepts,
          ...idsOf(item),
        })),
      )
      .onConflictDoUpdate({
        target: [x402Endpoints.resourceKey, x402Endpoints.source],
        set: {
          resourceUrl: sql`excluded.resource_url`,
          method: sql`excluded.method`,
          network: sql`excluded.network`,
          payTo: sql`excluded.pay_to`,
          priceAmount: sql`excluded.price_amount`,
          priceAsset: sql`excluded.price_asset`,
          description: sql`excluded.description`,
          declaredSchema: sql`excluded.declared_schema`,
          qualityCalls30d: sql`excluded.quality_calls_30d`,
          qualityPayers30d: sql`excluded.quality_payers_30d`,
          qualityLastCalledAt: sql`excluded.quality_last_called_at`,
          rawAccepts: sql`excluded.raw_accepts`,
          canonicalUrl: sql`excluded.canonical_url`,
          resourceId: sql`excluded.resource_id`,
          endpointHash: sql`excluded.endpoint_hash`,
          payeeId: sql`excluded.payee_id`,
          undeclaredQuery: sql`excluded.undeclared_query`,
          lastSeenAt: sql`now()`,
          // Presence in today's catalog IS the relist evidence; the event row
          // is written below from the pre-write diff.
          status: sql`'active'`,
          delistedAt: sql`null`,
        },
      });
    upserted += chunk.length;
  };

  for (let i = 0; i < result.items.length; i += UPSERT_CHUNK) {
    const chunk = result.items.slice(i, i + UPSERT_CHUNK);
    try {
      await upsertChunk(chunk);
    } catch {
      // Row-by-row fallback: isolate what the DB actually refuses.
      for (const item of chunk) {
        try {
          await upsertChunk([item]);
        } catch (rowError) {
          skipped++;
          logServerError(
            "observatory.catalog-sync.row_skipped",
            new Error(`${item.resourceKey}: ${rowError instanceof Error ? rowError.message : String(rowError)}`),
          );
        }
      }
    }
  }

  // ---- apply delisted status flips ----
  const delistedKeys = events.filter((e) => e.eventType === "delisted").map((e) => e.resourceKey);
  if (delistedKeys.length > 0) {
    for (let i = 0; i < delistedKeys.length; i += UPSERT_CHUNK) {
      const chunk = delistedKeys.slice(i, i + UPSERT_CHUNK);
      await db
        .update(x402Endpoints)
        .set({ status: "delisted", delistedAt: sql`now()` })
        .where(and(eq(x402Endpoints.source, source), inArray(x402Endpoints.resourceKey, chunk)));
    }
  }

  // ---- record events (endpointId resolved from pre-write map; new endpoints can't have events) ----
  const eventRows = events
    .map((e) => {
      const endpointId = idByKey.get(e.resourceKey);
      if (!endpointId) return null;
      return {
        endpointId,
        eventType: e.eventType,
        detectedOn: today,
        prevValue: e.prevValue,
        newValue: e.newValue,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (eventRows.length > 0) {
    await db.insert(x402DelistingEvents).values(eventRows);
  }

  // ---- snapshot (idempotent per day: refresh on re-run) ----
  await db
    .insert(x402CatalogSnapshots)
    .values({
      snapshotDate: today,
      source,
      totalCount: result.totalCount,
      fetchedCount: result.fetchedCount,
      resourceKeys: [...currentKeys],
    })
    .onConflictDoUpdate({
      target: [x402CatalogSnapshots.snapshotDate, x402CatalogSnapshots.source],
      set: {
        totalCount: result.totalCount,
        fetchedCount: result.fetchedCount,
        resourceKeys: [...currentKeys],
      },
    });

  return {
    snapshotDate: today,
    totalCount: result.totalCount,
    fetchedCount: result.fetchedCount,
    complete: result.complete,
    upserted,
    skipped,
    events,
  };
}
