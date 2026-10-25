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
import { CIRCLE_DISCOVERY_SOURCE } from "./listing-sources";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { writeResourceAliases } from "@/lib/resolve/aliases";

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

/**
 * Pages in flight against the CDP discovery API. One page takes ~1.2s from Vercel; the catalog
 * reached 35k rows (350 pages) on 2026-10-04, so the old sequential fetch (~410s) timed out the
 * 300s cron on 10/4 and 10/5. The writes are cheap (10/3: 22.8k rows upserted in 9s).
 */
const FETCH_CONCURRENCY = 3;
/**
 * Stop fetching after this long and sync what we have as complete=false (no delisting that day).
 * Plus one in-flight request (25s), the upsert (~15s) and notify must fit the route's 300s. Since 2026-10-07 the PayAI
 * payees and the MPP directory run in their own cron (/api/cron/catalog-sync-aux), which is what frees the extra 70s.
 */
const FETCH_DEADLINE_MS = 220_000;
/** Backoff 0.5+1+2+4+8s: a throttled page gets ~15s to recover before the day is called incomplete (10/6: two manual re-runs died at 3 retries). */
const FETCH_PAGE_RETRIES = 5;
/**
 * 429s get their own budget (fetchFullCatalog pauses every worker on one). 10/6: six pages in flight hit 429 at ~205 of
 * 350 pages on every run. Three in flight plus a shared pause keeps the whole fetch near 140s when the API does not throttle.
 */
const FETCH_THROTTLE_RETRIES = 12;

type Db = NonNullable<ReturnType<typeof getDb>>;

/**
 * CDP Bazaar と Circle の目録は同じ resource_key を 1 行にする。先に書いた source が
 * 行の持ち主。後の同期は行を足さず、accepts を足して status を active に戻す。
 * snapshot は source ごとなので、片方の目録に残っている鍵は delist しない。
 * 兄弟の最新 snapshot が不完全なら、その鍵と、直前の完全な snapshot の鍵の和を
 * 「まだ載っている」と見る（読んでいないページを不在にしない）。
 * 兄弟の最新が完全で、その鍵が無く、この取得も完全で、以前の snapshot にあった鍵は、
 * 行の持ち主がどちらでも delist する。MPP はこの対に入れない。
 */
function sharedSibling(source: string): string | null {
  if (source === CATALOG_SOURCE) return CIRCLE_DISCOVERY_SOURCE;
  if (source === CIRCLE_DISCOVERY_SOURCE) return CATALOG_SOURCE;
  return null;
}

/** 完全な snapshot は total > 0 かつ fetched >= total。0/0 は不完全（既存の規則）。 */
function snapshotIsComplete(totalCount: number, fetchedCount: number): boolean {
  return totalCount > 0 && fetchedCount >= totalCount;
}

function keysOf(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? (value as string[]) : []);
}

/** 既存の accept を残し、相手の目録にしか無い accept を足す。同じ JSON は 1 回。 */
function unionAccepts(existing: unknown, incoming: unknown): unknown[] | null {
  const a = Array.isArray(existing) ? existing : [];
  const b = Array.isArray(incoming) ? incoming : [];
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of [...a, ...b]) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.length > 0 ? out : null;
}

type SiblingListing = { keys: Set<string>; latestComplete: boolean };

async function loadSiblingListing(db: Db, sibling: string): Promise<SiblingListing> {
  const latest = await db
    .select({
      snapshotDate: x402CatalogSnapshots.snapshotDate,
      totalCount: x402CatalogSnapshots.totalCount,
      fetchedCount: x402CatalogSnapshots.fetchedCount,
      resourceKeys: x402CatalogSnapshots.resourceKeys,
    })
    .from(x402CatalogSnapshots)
    .where(eq(x402CatalogSnapshots.source, sibling))
    .orderBy(desc(x402CatalogSnapshots.snapshotDate))
    .limit(1);
  if (latest.length === 0) return { keys: new Set(), latestComplete: false };
  const row = latest[0];
  const latestKeys = keysOf(row.resourceKeys);
  if (snapshotIsComplete(row.totalCount, row.fetchedCount)) return { keys: latestKeys, latestComplete: true };
  const prevComplete = await db
    .select({ resourceKeys: x402CatalogSnapshots.resourceKeys })
    .from(x402CatalogSnapshots)
    .where(
      and(
        eq(x402CatalogSnapshots.source, sibling),
        lt(x402CatalogSnapshots.snapshotDate, row.snapshotDate),
        sql`${x402CatalogSnapshots.totalCount} > 0`,
        sql`${x402CatalogSnapshots.fetchedCount} >= ${x402CatalogSnapshots.totalCount}`,
      ),
    )
    .orderBy(desc(x402CatalogSnapshots.snapshotDate))
    .limit(1);
  const keys = new Set(latestKeys);
  if (prevComplete.length > 0) for (const key of keysOf(prevComplete[0].resourceKeys)) keys.add(key);
  return { keys, latestComplete: false };
}

type SiblingRow = { id: string; resourceKey: string; status: string; rawAccepts: unknown };

async function selectSiblingRows(db: Db, sibling: string, keys: string[]): Promise<SiblingRow[]> {
  const out: SiblingRow[] = [];
  for (let i = 0; i < keys.length; i += UPSERT_CHUNK) {
    const chunk = keys.slice(i, i + UPSERT_CHUNK);
    if (chunk.length === 0) continue;
    const part = await db
      .select({
        id: x402Endpoints.id,
        resourceKey: x402Endpoints.resourceKey,
        status: x402Endpoints.status,
        rawAccepts: x402Endpoints.rawAccepts,
      })
      .from(x402Endpoints)
      .where(and(eq(x402Endpoints.source, sibling), inArray(x402Endpoints.resourceKey, chunk)));
    out.push(...part);
  }
  return out;
}

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
    /**
     * 出どころが受取先を載せない（MPP directory・2026-09-17）とき true。再同期の行が
     * pay_to を null で運んでも、L0 が生きた challenge から学習した pay_to / payee_id を
     * 消さない。Bazaar（既定 false）は従来どおり出どころの値で上書きする。
     */
    keepLearnedPayTo?: boolean;
  } = {},
): Promise<SyncSummary> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");

  const source = options.source ?? CATALOG_SOURCE;
  const today = options.today ?? todayUtc();
  const result =
    options.fetchResult ??
    (await fetchFullCatalog({ concurrency: FETCH_CONCURRENCY, deadlineMs: FETCH_DEADLINE_MS, maxRetriesPerPage: FETCH_PAGE_RETRIES, maxThrottleRetries: FETCH_THROTTLE_RETRIES }));

  if (!result.complete) {
    // A partial day is safe (delisting is withheld) but a repeat means the fetch no longer fits its budget.
    logServerErrorSafe(
      "observatory.catalog-sync.incomplete",
      new Error(`fetched ${result.fetchedCount} of ${result.totalCount} (${result.stoppedBecause ?? "short count"}${result.lastPageError ? `, last page error ${result.lastPageError}` : ""}); delisting withheld today`),
    );
  }

  const currentKeys = new Set(result.items.map((i) => i.resourceKey));

  // ---- known state BEFORE any write (the diff needs yesterday's view) ----
  const knownRows = await db
    .select({
      id: x402Endpoints.id,
      resourceKey: x402Endpoints.resourceKey,
      status: x402Endpoints.status,
      qualityCalls30d: x402Endpoints.qualityCalls30d,
      resourceUrl: x402Endpoints.resourceUrl,
      resourceId: x402Endpoints.resourceId,
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

  const sibling = sharedSibling(source);
  const siblingListing = sibling ? await loadSiblingListing(db, sibling) : { keys: new Set<string>(), latestComplete: false };
  const siblingRows = new Map<string, SiblingRow>();
  if (sibling) {
    // Circle 側は行が少ないので全部読む。CDP 側は今回と前回の鍵だけ引く。
    const loaded =
      sibling === CIRCLE_DISCOVERY_SOURCE
        ? await db
            .select({
              id: x402Endpoints.id,
              resourceKey: x402Endpoints.resourceKey,
              status: x402Endpoints.status,
              rawAccepts: x402Endpoints.rawAccepts,
            })
            .from(x402Endpoints)
            .where(eq(x402Endpoints.source, sibling))
        : await selectSiblingRows(db, sibling, [...new Set([...currentKeys, ...(prevKeys ?? [])])]);
    for (const row of loaded) siblingRows.set(row.resourceKey, row);
  }
  const ownItems: ParsedCatalogItem[] = [];
  const sharedItems: ParsedCatalogItem[] = [];
  for (const item of result.items) {
    if (siblingRows.has(item.resourceKey)) sharedItems.push(item);
    else ownItems.push(item);
  }

  // ---- diff (pure) ----
  // 兄弟の snapshot がまだその鍵を載せている delist は記録しない。
  const events = computeCatalogDiff({
    prevKeys,
    currentKeys,
    currentComplete: result.complete,
    knownEndpoints,
    currentQuality: new Map(result.items.map((i) => [i.resourceKey, i.qualityCalls30d])),
  }).filter((e) => e.eventType !== "delisted" || !siblingListing.keys.has(e.resourceKey));

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
          declaredInput: item.declaredInput ?? null,
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
          payTo: options.keepLearnedPayTo ? sql`coalesce(excluded.pay_to, ${x402Endpoints.payTo})` : sql`excluded.pay_to`,
          priceAmount: sql`excluded.price_amount`,
          priceAsset: sql`excluded.price_asset`,
          description: sql`excluded.description`,
          declaredSchema: sql`excluded.declared_schema`,
          declaredInput: sql`excluded.declared_input`,
          qualityCalls30d: sql`excluded.quality_calls_30d`,
          qualityPayers30d: sql`excluded.quality_payers_30d`,
          qualityLastCalledAt: sql`excluded.quality_last_called_at`,
          rawAccepts: sql`excluded.raw_accepts`,
          canonicalUrl: sql`excluded.canonical_url`,
          resourceId: sql`excluded.resource_id`,
          endpointHash: sql`excluded.endpoint_hash`,
          payeeId: options.keepLearnedPayTo ? sql`coalesce(excluded.payee_id, ${x402Endpoints.payeeId})` : sql`excluded.payee_id`,
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

  for (let i = 0; i < ownItems.length; i += UPSERT_CHUNK) {
    const chunk = ownItems.slice(i, i + UPSERT_CHUNK);
    try {
      await upsertChunk(chunk);
    } catch {
      // Row-by-row fallback: isolate what the DB actually refuses.
      for (const item of chunk) {
        try {
          await upsertChunk([item]);
        } catch (rowError) {
          skipped++;
          logServerErrorSafe(
            "observatory.catalog-sync.row_skipped",
            new Error(`${item.resourceKey}: ${rowError instanceof Error ? rowError.message : String(rowError)}`),
          );
        }
      }
    }
  }

  // 兄弟が持つ行は accepts を足すだけ。CDP の upsert の set（raw_accepts = excluded）は変えない。
  const sharedRelists: CatalogDiffEvent[] = [];
  for (const item of sharedItems) {
    const row = siblingRows.get(item.resourceKey);
    if (!row) continue;
    try {
      await db
        .update(x402Endpoints)
        .set({
          rawAccepts: unionAccepts(row.rawAccepts, item.rawAccepts),
          status: "active",
          delistedAt: null,
          lastSeenAt: sql`now()`,
        })
        .where(eq(x402Endpoints.id, row.id));
      upserted += 1;
      if (row.status === "delisted") {
        sharedRelists.push({
          resourceKey: item.resourceKey,
          eventType: "relisted",
          prevValue: { status: "delisted" },
          newValue: { status: "active" },
        });
      }
    } catch (rowError) {
      skipped++;
      logServerErrorSafe(
        "observatory.catalog-sync.row_skipped",
        new Error(`${item.resourceKey}: ${rowError instanceof Error ? rowError.message : String(rowError)}`),
      );
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
  // 行の持ち主が兄弟のとき、この source の UPDATE は 0 行。兄弟の最新 snapshot が
  // 完全でその鍵を持たないときだけ、兄弟の行を delist する。
  if (sibling && siblingListing.latestComplete && delistedKeys.length > 0) {
    const extraKeys = delistedKeys.filter((key) => {
      const row = siblingRows.get(key);
      return row !== undefined && row.status !== "delisted";
    });
    for (let i = 0; i < extraKeys.length; i += UPSERT_CHUNK) {
      const chunk = extraKeys.slice(i, i + UPSERT_CHUNK);
      if (chunk.length === 0) continue;
      await db
        .update(x402Endpoints)
        .set({ status: "delisted", delistedAt: sql`now()` })
        .where(and(eq(x402Endpoints.source, sibling), inArray(x402Endpoints.resourceKey, chunk)));
    }
  }

  // ---- record events (endpointId resolved from pre-write map; new endpoints can't have events) ----
  const eventIdByKey = new Map(idByKey);
  if (sibling && siblingListing.latestComplete) {
    for (const [key, row] of siblingRows) if (!eventIdByKey.has(key)) eventIdByKey.set(key, row.id);
  }
  for (const e of sharedRelists) {
    const row = siblingRows.get(e.resourceKey);
    if (row) eventIdByKey.set(e.resourceKey, row.id);
  }
  const eventsOut = [...events, ...sharedRelists];
  const eventRows = eventsOut
    .map((e) => {
      const endpointId = eventIdByKey.get(e.resourceKey);
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
      // A partial re-run must not replace a full snapshot of the same day (2026-10-06: a manual re-run
      // fetched 25,000 of 35,028 and overwrote the complete 01:00 snapshot — tomorrow's diff base).
      // A complete run always writes; a partial one writes only over an earlier partial (or empty) one that read fewer rows.
      ...(result.complete
        ? {}
        : {
            setWhere: sql`(${x402CatalogSnapshots.fetchedCount} < ${x402CatalogSnapshots.totalCount} or ${x402CatalogSnapshots.totalCount} = 0) and excluded.fetched_count > ${x402CatalogSnapshots.fetchedCount}`,
          }),
    });

  // ---- resource_id の別名（2026-09-29 監査 7 周目・高）----
  // 生の URL から id を作る SDK が、表記の揺れで BLOCK をカタログ外と読まないように。新規の掲載と、URL か
  // resource_id が変わった掲載の別名をここで作る（backfill と同じ writeResourceAliases）。既存の掲載の欠けと
  // 揺れの規則の変更は scripts/backfill-resource-aliases.ts の再実行で埋まる。別名は補助の索引なので、失敗しても
  // 同期そのものは止めない（表の無い DB では missingTable が返るだけ）。
  try {
    const prevByKey = new Map(knownRows.map((r) => [r.resourceKey, r]));
    const aliasSources = result.items.flatMap((item) => {
      const ids = idsOf(item);
      if (!ids.canonicalUrl) return [];
      const prev = prevByKey.get(item.resourceKey);
      if (prev && prev.resourceUrl === item.resourceUrl && prev.resourceId === ids.resourceId) return [];
      return [{ resource_id: ids.resourceId, method: item.method ?? "GET", resource_url: item.resourceUrl }];
    });
    await writeResourceAliases(db, aliasSources);
  } catch (aliasError) {
    logServerErrorSafe("observatory.catalog-sync.aliases", aliasError);
  }

  return {
    snapshotDate: today,
    totalCount: result.totalCount,
    fetchedCount: result.fetchedCount,
    complete: result.complete,
    upserted,
    skipped,
    events: eventsOut,
  };
}
