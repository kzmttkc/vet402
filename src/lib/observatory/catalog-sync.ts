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
// CDP Bazaar and Circle share one row per resource_key. The first writer
// owns `source`. Accepts are stored per source and unioned into raw_accepts.
// A delist of a shared row requires the other catalog's absence to be proven.
// A complete snapshot proves that snapshot's keys. An incomplete snapshot
// proves the union of every snapshot since the previous complete one. The
// daily reconcile runs only when this run's own fetch is complete, and then
// delists an active shared-source row absent from both proven sets.
// MPP stays a separate row.
//
// No scoring/chain imports. Writers here are trusted-cron-only — nothing in
// this module is reachable from a request handler that accepts user input.
// ============================================================
import { canonicalUrl, endpointHash, payeeId, resourceId } from "@/lib/ids/canonical";
import { and, eq, gte, inArray, lt, desc, sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { isUniqueViolationError } from "@/lib/db/pg-errors";
import {
  x402CatalogSnapshots,
  x402DelistingEvents,
  x402Endpoints,
  x402ResourceAliases,
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
/** Shared-row updates carry two jsonb blobs. Keep the VALUES list small. */
const SHARED_UPDATE_CHUNK = 100;

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

const SHARED_SOURCES = [CATALOG_SOURCE, CIRCLE_DISCOVERY_SOURCE] as const;

type Db = NonNullable<ReturnType<typeof getDb>>;

/**
 * CDP Bazaar と Circle の目録は同じ resource_key を 1 行にする。先に書いた source が
 * 行の持ち主。MPP はこの対に入れない。
 */
function sharedSibling(source: string): string | null {
  if (source === CATALOG_SOURCE) return CIRCLE_DISCOVERY_SOURCE;
  if (source === CIRCLE_DISCOVERY_SOURCE) return CATALOG_SOURCE;
  return null;
}

/** 件数だけの完全判定。complete 列が NULL の古い snapshot にだけ使う。 */
function snapshotIsComplete(totalCount: number, fetchedCount: number): boolean {
  return totalCount > 0 && fetchedCount >= totalCount;
}

/**
 * 取得側の finish() と同じ規則。complete が true/false なら件数が一致してもそれに従う
 * （page_shape は fetched >= total のまま complete=false になり得る）。NULL は旧規則。
 */
function snapshotRowComplete(row: { complete: boolean | null; totalCount: number; fetchedCount: number }): boolean {
  if (row.complete === true) return true;
  if (row.complete === false) return false;
  return snapshotIsComplete(row.totalCount, row.fetchedCount);
}

const COMPLETE_SNAPSHOT_SQL = sql`(
  ${x402CatalogSnapshots.complete} = true
  OR (
    ${x402CatalogSnapshots.complete} IS NULL
    AND ${x402CatalogSnapshots.totalCount} > 0
    AND ${x402CatalogSnapshots.fetchedCount} >= ${x402CatalogSnapshots.totalCount}
  )
)`;

function keysOf(value: unknown): Set<string> {
  return new Set(Array.isArray(value) ? (value as string[]) : []);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asAccepts(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 既存の accept を残し、相手の目録にしか無い accept を足す。同じ JSON は 1 回。空なら null。 */
function unionAccepts(existing: unknown, incoming: unknown): unknown[] | null {
  const a = asAccepts(existing);
  const b = asAccepts(incoming);
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

type StoredAccepts = { rawAccepts: unknown[] | null; acceptsBySource: Record<string, unknown[]> };

/**
 * この source の slice を今回の accepts で置き換える。keepSibling のときだけ相手の slice を残し、
 * raw_accepts はその和。相手が載せていない（不在が証明済み）ときは相手の slice を消す。
 * accepts_by_source が NULL の既存行で相手がまだ載せているときは、今回の取得に無い要素を
 * 相手の slice として 1 回だけ残す。
 */
function composeAccepts(input: {
  existingBySource: unknown;
  existingRaw: unknown;
  incoming: unknown;
  source: string;
  sibling: string | null;
  keepSibling: boolean;
}): StoredAccepts {
  const incoming = asAccepts(input.incoming);
  const by: Record<string, unknown[]> = {};
  const existing = asRecord(input.existingBySource);
  if (existing) {
    for (const [key, value] of Object.entries(existing)) {
      if (Array.isArray(value)) by[key] = value;
    }
  } else if (input.keepSibling && input.sibling && Array.isArray(input.existingRaw)) {
    const seen = new Set(incoming.map((item) => JSON.stringify(item)));
    const rest = input.existingRaw.filter((item) => !seen.has(JSON.stringify(item)));
    if (rest.length > 0) by[input.sibling] = rest;
  }
  by[input.source] = incoming;
  if (!input.keepSibling && input.sibling) delete by[input.sibling];
  const siblingSlice = input.keepSibling && input.sibling ? (by[input.sibling] ?? []) : [];
  return { rawAccepts: unionAccepts(siblingSlice, incoming), acceptsBySource: by };
}

/**
 * 第1段（2026-10-30 設計 v5）: cdp_bazaar に載る行は閉じない。載る行 = cdp が持ち主・カーソルが一度でも見た
 * （last_seen_pass がある）・cdp の accepts の slice を持つ。circle_discovery だけの行の閉じ方は origin/main のまま。
 * 下の SQL と同じ判定（docs/catalog-staleness-contract.md 4.2 の「cdp に載る行」）。
 */
function isCdpListedRow(row: { source: string; lastSeenPass: number | null; acceptsBySource: unknown }): boolean {
  return row.source === CATALOG_SOURCE || row.lastSeenPass !== null || hasSiblingSlice(row.acceptsBySource, CATALOG_SOURCE);
}

const CDP_LISTED_ROW_SQL = sql`(
  source = ${CATALOG_SOURCE}
  OR last_seen_pass IS NOT NULL
  -- accepts_by_source に cdp の鍵が無い行では -> が NULL になり、式全体が NULL になる（NOT NULL は偽扱いで行が外れる）。
  -- coalesce で false に倒す（2026-10-30 再点検: Circle だけの行が日次の突き合わせから全部外れていた）。
  -- CASE で順番を決める（AND は評価の順を約束しないので、配列でない値に jsonb_array_length を当てて落ちうる）。
  OR coalesce(CASE WHEN jsonb_typeof(accepts_by_source -> ${CATALOG_SOURCE}) = 'array' THEN jsonb_array_length(accepts_by_source -> ${CATALOG_SOURCE}) > 0 END, false)
)`;

function hasSiblingSlice(bySource: unknown, sibling: string): boolean {
  const rec = asRecord(bySource);
  return Array.isArray(rec?.[sibling]) && (rec?.[sibling] as unknown[]).length > 0;
}

export type SiblingListing = { keys: Set<string>; latestComplete: boolean; absenceProven: boolean };

/**
 * 兄弟の「載っている」集合。最新が完全ならその鍵だけ。不完全なら、直前の完全な
 * snapshot 以降のすべての snapshot の鍵（その完全な日を含む）。途中の部分取得で
 * 入った鍵を、後の部分取得が読まなかっただけで不在にしない。完全な snapshot が
 * 一度も無ければ不在は証明できない。
 */
async function loadSiblingListing(db: Db, sibling: string): Promise<SiblingListing> {
  const latest = await db
    .select({
      snapshotDate: x402CatalogSnapshots.snapshotDate,
      totalCount: x402CatalogSnapshots.totalCount,
      fetchedCount: x402CatalogSnapshots.fetchedCount,
      resourceKeys: x402CatalogSnapshots.resourceKeys,
      complete: x402CatalogSnapshots.complete,
    })
    .from(x402CatalogSnapshots)
    .where(eq(x402CatalogSnapshots.source, sibling))
    .orderBy(desc(x402CatalogSnapshots.snapshotDate))
    .limit(1);
  if (latest.length === 0) return { keys: new Set(), latestComplete: false, absenceProven: false };
  const row = latest[0];
  const latestKeys = keysOf(row.resourceKeys);
  if (snapshotRowComplete(row)) return { keys: latestKeys, latestComplete: true, absenceProven: true };
  const prevComplete = await db
    .select({ snapshotDate: x402CatalogSnapshots.snapshotDate })
    .from(x402CatalogSnapshots)
    .where(and(eq(x402CatalogSnapshots.source, sibling), lt(x402CatalogSnapshots.snapshotDate, row.snapshotDate), COMPLETE_SNAPSHOT_SQL))
    .orderBy(desc(x402CatalogSnapshots.snapshotDate))
    .limit(1);
  if (prevComplete.length === 0) return { keys: latestKeys, latestComplete: false, absenceProven: false };
  const since = await db
    .select({ resourceKeys: x402CatalogSnapshots.resourceKeys })
    .from(x402CatalogSnapshots)
    .where(and(eq(x402CatalogSnapshots.source, sibling), gte(x402CatalogSnapshots.snapshotDate, prevComplete[0].snapshotDate)));
  const keys = new Set<string>();
  for (const snap of since) for (const key of keysOf(snap.resourceKeys)) keys.add(key);
  return { keys, latestComplete: false, absenceProven: true };
}

/** この目録が宣言を持たないとき、移動先の declared_input は古い値のままにする。 */
function declaredInputForMove(incoming: ParsedCatalogItem["declaredInput"], prior: unknown): unknown {
  if (incoming && (incoming.query !== "empty" || incoming.body !== "empty")) return incoming;
  return prior ?? null;
}

type SiblingIdentity = { id: string; resourceKey: string; status: string };
type BlobRow = SiblingIdentity & { source: string; rawAccepts: unknown; acceptsBySource: unknown };

async function selectSiblingIdentity(db: Db, sibling: string, keys: string[] | null): Promise<SiblingIdentity[]> {
  if (keys === null) {
    return db
      .select({ id: x402Endpoints.id, resourceKey: x402Endpoints.resourceKey, status: x402Endpoints.status })
      .from(x402Endpoints)
      .where(eq(x402Endpoints.source, sibling));
  }
  const out: SiblingIdentity[] = [];
  for (let i = 0; i < keys.length; i += UPSERT_CHUNK) {
    const chunk = keys.slice(i, i + UPSERT_CHUNK);
    if (chunk.length === 0) continue;
    const part = await db
      .select({ id: x402Endpoints.id, resourceKey: x402Endpoints.resourceKey, status: x402Endpoints.status })
      .from(x402Endpoints)
      .where(and(eq(x402Endpoints.source, sibling), inArray(x402Endpoints.resourceKey, chunk)));
    out.push(...part);
  }
  return out;
}

async function selectBlobs(db: Db, sources: readonly string[], keys: string[]): Promise<BlobRow[]> {
  const out: BlobRow[] = [];
  for (let i = 0; i < keys.length; i += UPSERT_CHUNK) {
    const chunk = keys.slice(i, i + UPSERT_CHUNK);
    if (chunk.length === 0) continue;
    const part = await db
      .select({
        id: x402Endpoints.id,
        resourceKey: x402Endpoints.resourceKey,
        source: x402Endpoints.source,
        status: x402Endpoints.status,
        rawAccepts: x402Endpoints.rawAccepts,
        acceptsBySource: x402Endpoints.acceptsBySource,
      })
      .from(x402Endpoints)
      .where(and(inArray(x402Endpoints.source, [...sources]), inArray(x402Endpoints.resourceKey, chunk)));
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
    /**
     * 現在時刻（2026-10-30 設計 v5・docs/catalog-staleness-contract.md）。閉じる回（closeCatalogListings）に渡す now。
     * 既定 () => new Date()。実装が入るまで読まない（殻）。
     */
    clock?: () => Date;
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
      lastSeenPass: x402Endpoints.lastSeenPass,
      acceptsBySource: x402Endpoints.acceptsBySource,
    })
    .from(x402Endpoints)
    .where(eq(x402Endpoints.source, source));
  const knownEndpoints = new Map<string, KnownEndpointState>(
    knownRows.map((r) => [r.resourceKey, { status: r.status, qualityCalls30d: r.qualityCalls30d }]),
  );
  const idByKey = new Map(knownRows.map((r) => [r.resourceKey, r.id]));
  const knownRowByKey = new Map(knownRows.map((r) => [r.resourceKey, r]));

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
  const loadedSibling = sibling ? await loadSiblingListing(db, sibling) : { keys: new Set<string>(), latestComplete: false, absenceProven: false };
  // 第1段（2026-10-30 点検 X1）: Circle の同期では、cdp の兄弟の不在を証明済みとして扱わない。カーソルの周回の snapshot は
  // 読めないページ（5% まで）と並びのずれの読み落としを許すので、「cdp に無い」の証明には使えない。証明済みとして使うと、
  // cdp が載せている行の持ち主を Circle へ移して cdp の accepts を消し、cdp に載る印が無くなった行を次の日に閉じる。
  const cdpSiblingUnproven = sibling === CATALOG_SOURCE;
  const siblingListing: SiblingListing = cdpSiblingUnproven ? { ...loadedSibling, absenceProven: false } : loadedSibling;
  const siblingRows = new Map<string, SiblingIdentity>();
  if (sibling) {
    // Circle 側は行が少ないので id・鍵・status だけ全部読む。accepts は今回触る鍵だけ。
    // CDP 側は今回と前回の鍵だけ引く（CDP の全行は読まない）。
    const loaded =
      sibling === CIRCLE_DISCOVERY_SOURCE
        ? await selectSiblingIdentity(db, sibling, null)
        : await selectSiblingIdentity(db, sibling, [...new Set([...currentKeys, ...(prevKeys ?? [])])]);
    for (const row of loaded) siblingRows.set(row.resourceKey, row);
  }

  const blobKeys = new Set<string>();
  for (const key of currentKeys) {
    if (siblingRows.has(key) || siblingListing.keys.has(key)) blobKeys.add(key);
  }
  const blobs = blobKeys.size > 0 ? await selectBlobs(db, sibling ? [source, sibling] : [source], [...blobKeys]) : [];
  const blobByKey = new Map<string, BlobRow>();
  for (const row of blobs) blobByKey.set(`${row.source}\0${row.resourceKey}`, row);

  // 相手の不在がまだ証明できないあいだは、既に保存した相手の slice を消さない。
  if (sibling && !siblingListing.absenceProven) {
    const kept = await db
      .select({
        id: x402Endpoints.id,
        resourceKey: x402Endpoints.resourceKey,
        source: x402Endpoints.source,
        status: x402Endpoints.status,
        rawAccepts: x402Endpoints.rawAccepts,
        acceptsBySource: x402Endpoints.acceptsBySource,
      })
      .from(x402Endpoints)
      .where(and(eq(x402Endpoints.source, source), sql`${x402Endpoints.acceptsBySource} -> ${sibling} IS NOT NULL`));
    for (const row of kept) {
      if (!currentKeys.has(row.resourceKey)) continue;
      blobByKey.set(`${row.source}\0${row.resourceKey}`, row);
    }
  }

  const ownItems: ParsedCatalogItem[] = [];
  const sharedItems: ParsedCatalogItem[] = [];
  const transferItems: ParsedCatalogItem[] = [];
  for (const item of result.items) {
    const ownedBySibling = siblingRows.has(item.resourceKey);
    // 第1段: cdp が持ち主の行は Circle の同期で持ち主を移さない（cdpSiblingUnproven で absenceProven は false だが、ここでも止める）。
    if (ownedBySibling && !cdpSiblingUnproven && siblingListing.absenceProven && !siblingListing.keys.has(item.resourceKey)) {
      transferItems.push(item);
    } else if (ownedBySibling) {
      sharedItems.push(item);
    } else {
      ownItems.push(item);
    }
  }

  const keepSiblingSlice = (key: string, existingBySource: unknown): boolean => {
    if (!sibling) return false;
    // 第1段: Circle の同期は、行がもう持っている cdp の accepts の slice を消さない（無い slice は作らない。
    // accepts_by_source が NULL の旧い行に「cdp の slice」を作ると、Circle だけの行が閉じなくなる）。
    if (cdpSiblingUnproven && hasSiblingSlice(existingBySource, sibling)) return true;
    if (siblingListing.keys.has(key)) return true;
    return !siblingListing.absenceProven && hasSiblingSlice(existingBySource, sibling);
  };

  // ---- diff (pure) ----
  // 兄弟がまだ載せている鍵、不在が証明できない共有行、すでに delisted の兄弟行は記録しない。
  const events = computeCatalogDiff({
    prevKeys,
    currentKeys,
    currentComplete: result.complete,
    knownEndpoints,
    currentQuality: new Map(result.items.map((i) => [i.resourceKey, i.qualityCalls30d])),
  }).filter((event) => {
    if (event.eventType !== "delisted") return true;
    // 第1段: cdp_bazaar に載る行は閉じない。cdp の同期が「無い」と判定した鍵は、持ち主がどちらでも cdp に載っていた行。
    if (source === CATALOG_SOURCE) return false;
    const ownRow = knownRowByKey.get(event.resourceKey);
    if (ownRow && isCdpListedRow({ source, lastSeenPass: ownRow.lastSeenPass, acceptsBySource: ownRow.acceptsBySource })) return false;
    if (sibling === CATALOG_SOURCE && siblingRows.has(event.resourceKey)) return false;
    if (siblingListing.keys.has(event.resourceKey)) return false;
    const sib = siblingRows.get(event.resourceKey);
    const own = knownEndpoints.get(event.resourceKey);
    if (sib && !siblingListing.absenceProven) return false;
    if (sib && sib.status === "delisted" && own?.status !== "active") return false;
    return true;
  });

  // ---- upsert endpoints (chunked, row-fallback on chunk failure) ----
  let upserted = 0;
  let skipped = 0;
  const sharedRelists: CatalogDiffEvent[] = [];
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

  const mergeCrossSource = async (item: ParsedCatalogItem): Promise<boolean> => {
    if (!sibling) return false;
    const found = await db
      .select({
        id: x402Endpoints.id,
        status: x402Endpoints.status,
        rawAccepts: x402Endpoints.rawAccepts,
        acceptsBySource: x402Endpoints.acceptsBySource,
      })
      .from(x402Endpoints)
      .where(and(eq(x402Endpoints.resourceKey, item.resourceKey), inArray(x402Endpoints.source, [...SHARED_SOURCES])))
      .limit(1);
    const row = found[0];
    if (!row) return false;
    const stored = composeAccepts({
      existingBySource: row.acceptsBySource,
      existingRaw: row.rawAccepts,
      incoming: item.rawAccepts,
      source,
      sibling,
      keepSibling: true,
    });
    await db
      .update(x402Endpoints)
      .set({
        rawAccepts: stored.rawAccepts,
        acceptsBySource: stored.acceptsBySource,
        status: "active",
        delistedAt: null,
        lastSeenAt: sql`now()`,
      })
      .where(eq(x402Endpoints.id, row.id));
    if (row.status === "delisted") {
      sharedRelists.push({
        resourceKey: item.resourceKey,
        eventType: "relisted",
        prevValue: { status: "delisted" },
        newValue: { status: "active" },
      });
    }
    siblingRows.set(item.resourceKey, { id: row.id, resourceKey: item.resourceKey, status: "active" });
    return true;
  };

  const upsertChunk = async (chunk: ParsedCatalogItem[]) => {
    await db
      .insert(x402Endpoints)
      .values(
        chunk.map((item: ParsedCatalogItem) => {
          const existing = blobByKey.get(`${source}\0${item.resourceKey}`);
          const stored = composeAccepts({
            existingBySource: existing?.acceptsBySource,
            existingRaw: existing?.rawAccepts,
            incoming: item.rawAccepts,
            source,
            sibling,
            keepSibling: keepSiblingSlice(item.resourceKey, existing?.acceptsBySource),
          });
          return {
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
            rawAccepts: stored.rawAccepts,
            acceptsBySource: stored.acceptsBySource,
            ...idsOf(item),
          };
        }),
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
          acceptsBySource: sql`excluded.accepts_by_source`,
          canonicalUrl: sql`excluded.canonical_url`,
          resourceId: sql`excluded.resource_id`,
          endpointHash: sql`excluded.endpoint_hash`,
          payeeId: options.keepLearnedPayTo ? sql`coalesce(excluded.payee_id, ${x402Endpoints.payeeId})` : sql`excluded.payee_id`,
          undeclaredQuery: sql`excluded.undeclared_query`,
          lastSeenAt: sql`now()`,
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
      for (const item of chunk) {
        try {
          await upsertChunk([item]);
        } catch (rowError) {
          if (isUniqueViolationError(rowError)) {
            try {
              if (await mergeCrossSource(item)) {
                upserted += 1;
                continue;
              }
            } catch (mergeError) {
              logServerErrorSafe(
                "observatory.catalog-sync.row_skipped",
                new Error(`${item.resourceKey}: ${mergeError instanceof Error ? mergeError.message : String(mergeError)}`),
              );
            }
          }
          skipped++;
          logServerErrorSafe(
            "observatory.catalog-sync.row_skipped",
            new Error(`${item.resourceKey}: ${rowError instanceof Error ? rowError.message : String(rowError)}`),
          );
        }
      }
    }
  }

  // 持ち主の最新の完全な取得に無く、この目録が載せている鍵は、持ち主をこちらへ移す。
  // accepts はこちらのものに置き換える（古い slice を足さない）。
  // quality と declared_input は、この目録に値が無いとき古い値を残す。
  // method が変わって resource_id が変わるときは、移動の前の id を別名にする。
  const priorById = new Map<
    string,
    {
      resourceId: string | null;
      qualityCalls30d: number | null;
      qualityPayers30d: number | null;
      qualityLastCalledAt: Date | null;
      declaredInput: unknown;
    }
  >();
  const transferIds = transferItems.flatMap((item) => {
    const id = siblingRows.get(item.resourceKey)?.id;
    return id ? [id] : [];
  });
  for (let i = 0; i < transferIds.length; i += UPSERT_CHUNK) {
    const chunk = transferIds.slice(i, i + UPSERT_CHUNK);
    const priors = await db
      .select({
        id: x402Endpoints.id,
        resourceId: x402Endpoints.resourceId,
        qualityCalls30d: x402Endpoints.qualityCalls30d,
        qualityPayers30d: x402Endpoints.qualityPayers30d,
        qualityLastCalledAt: x402Endpoints.qualityLastCalledAt,
        declaredInput: x402Endpoints.declaredInput,
      })
      .from(x402Endpoints)
      .where(inArray(x402Endpoints.id, chunk));
    for (const prior of priors) priorById.set(prior.id, prior);
  }
  const movedAliases: { aliasId: string; resourceId: string }[] = [];
  for (const item of transferItems) {
    const row = siblingRows.get(item.resourceKey);
    if (!row) continue;
    const prior = priorById.get(row.id);
    const stored = composeAccepts({
      existingBySource: null,
      existingRaw: null,
      incoming: item.rawAccepts,
      source,
      sibling,
      keepSibling: false,
    });
    const ids = idsOf(item);
    try {
      await db
        .update(x402Endpoints)
        .set({
          source,
          resourceUrl: item.resourceUrl,
          method: item.method,
          network: item.network,
          payTo: item.payTo,
          priceAmount: item.priceAmount,
          priceAsset: item.priceAsset,
          description: item.description,
          declaredSchema: item.declaredSchema,
          declaredInput: declaredInputForMove(item.declaredInput, prior?.declaredInput),
          qualityCalls30d: item.qualityCalls30d ?? prior?.qualityCalls30d ?? null,
          qualityPayers30d: item.qualityPayers30d ?? prior?.qualityPayers30d ?? null,
          qualityLastCalledAt: item.qualityLastCalledAt ?? prior?.qualityLastCalledAt ?? null,
          rawAccepts: stored.rawAccepts,
          acceptsBySource: stored.acceptsBySource,
          ...ids,
          lastSeenAt: sql`now()`,
          status: "active",
          delistedAt: null,
        })
        .where(eq(x402Endpoints.id, row.id));
      upserted += 1;
      idByKey.set(item.resourceKey, row.id);
      if (prior?.resourceId && ids.resourceId && prior.resourceId !== ids.resourceId) {
        movedAliases.push({ aliasId: prior.resourceId, resourceId: ids.resourceId });
      }
      if (row.status === "delisted") {
        sharedRelists.push({
          resourceKey: item.resourceKey,
          eventType: "relisted",
          prevValue: { status: "delisted" },
          newValue: { status: "active" },
        });
      }
    } catch (rowError) {
      if (isUniqueViolationError(rowError)) {
        try {
          if (await mergeCrossSource(item)) {
            upserted += 1;
            continue;
          }
        } catch {
          // fall through to skipped
        }
      }
      skipped++;
      logServerErrorSafe(
        "observatory.catalog-sync.row_skipped",
        new Error(`${item.resourceKey}: ${rowError instanceof Error ? rowError.message : String(rowError)}`),
      );
    }
  }

  // 兄弟が持つ行は、こちらの slice を置き換えて和を書く。スカラー（pay_to 等）は持ち主のまま。
  const sharedUpdates: { id: string; rawAccepts: unknown; acceptsBySource: unknown; resourceKey: string; wasDelisted: boolean }[] = [];
  for (const item of sharedItems) {
    const row = siblingRows.get(item.resourceKey);
    if (!row) continue;
    const existing = blobByKey.get(`${sibling}\0${item.resourceKey}`);
    const stored = composeAccepts({
      existingBySource: existing?.acceptsBySource,
      existingRaw: existing?.rawAccepts,
      incoming: item.rawAccepts,
      source,
      sibling,
      keepSibling: true,
    });
    sharedUpdates.push({
      id: row.id,
      rawAccepts: stored.rawAccepts,
      acceptsBySource: stored.acceptsBySource,
      resourceKey: item.resourceKey,
      wasDelisted: row.status === "delisted",
    });
  }
  const applySharedUpdate = async (row: (typeof sharedUpdates)[number]) => {
    await db
      .update(x402Endpoints)
      .set({
        rawAccepts: row.rawAccepts,
        acceptsBySource: row.acceptsBySource,
        status: "active",
        delistedAt: null,
        lastSeenAt: sql`now()`,
      })
      .where(eq(x402Endpoints.id, row.id));
    upserted += 1;
    if (row.wasDelisted) {
      sharedRelists.push({
        resourceKey: row.resourceKey,
        eventType: "relisted",
        prevValue: { status: "delisted" },
        newValue: { status: "active" },
      });
    }
  };
  for (let i = 0; i < sharedUpdates.length; i += SHARED_UPDATE_CHUNK) {
    const chunk = sharedUpdates.slice(i, i + SHARED_UPDATE_CHUNK);
    try {
      const values = sql.join(
        chunk.map((row) => sql`(${row.id}::uuid, ${JSON.stringify(row.rawAccepts)}::jsonb, ${JSON.stringify(row.acceptsBySource)}::jsonb)`),
        sql`, `,
      );
      await db.execute(sql`
        UPDATE x402_endpoints AS e
        SET raw_accepts = v.raw_accepts,
            accepts_by_source = v.accepts_by_source,
            status = 'active',
            delisted_at = NULL,
            last_seen_at = now()
        FROM (VALUES ${values}) AS v(id, raw_accepts, accepts_by_source)
        WHERE e.id = v.id
      `);
      upserted += chunk.length;
      for (const row of chunk) {
        if (!row.wasDelisted) continue;
        sharedRelists.push({
          resourceKey: row.resourceKey,
          eventType: "relisted",
          prevValue: { status: "delisted" },
          newValue: { status: "active" },
        });
      }
    } catch {
      for (const row of chunk) {
        try {
          await applySharedUpdate(row);
        } catch (rowError) {
          skipped++;
          logServerErrorSafe(
            "observatory.catalog-sync.row_skipped",
            new Error(`${row.resourceKey}: ${rowError instanceof Error ? rowError.message : String(rowError)}`),
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
  // 不在が証明でき、鍵が兄弟の集合に無いとき、持ち主が兄弟でも行を delist する。
  // 最新が不完全でも、直前の完全な snapshot 以降の取得の和に無ければ閉じる。
  // 第1段: 兄弟が cdp_bazaar なら、その行は cdp に載る行なので閉じない。
  if (sibling && sibling !== CATALOG_SOURCE && siblingListing.absenceProven && delistedKeys.length > 0) {
    const extraKeys = delistedKeys.filter((key) => {
      const row = siblingRows.get(key);
      return row !== undefined && row.status !== "delisted" && !siblingListing.keys.has(key);
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

  // 日次の突き合わせ。自分の取得が完全な日だけ行う。両方の不在が証明でき、
  // どちらの集合にも無い active 行を閉じる。不完全な日は判定しない。
  const reconcileEvents: CatalogDiffEvent[] = [];
  // 突き合わせの開始は origin/main と同じ（読み込んだ兄弟の不在が証明できるとき）。第1段の X1 の守り（Circle の同期で cdp の
  // 不在を証明済みにしない）は持ち主の移動と slice の扱いだけに効かせ、ここでは読み込んだ値を使う。閉じるのは cdp に載る印の
  // 無い行だけ（CDP_LISTED_ROW_SQL）。cdp の完全な snapshot が一度も無いあいだは、origin/main と同じく走らない。
  if (sibling && result.complete && loadedSibling.absenceProven) {
    const flippedRaw = await db.execute(sql`
      UPDATE x402_endpoints
      SET status = 'delisted', delisted_at = now()
      WHERE status = 'active'
        AND source IN (${CATALOG_SOURCE}, ${CIRCLE_DISCOVERY_SOURCE})
        AND NOT ${CDP_LISTED_ROW_SQL}
        AND NOT (resource_key IN (SELECT jsonb_array_elements_text(${JSON.stringify([...currentKeys])}::jsonb)))
        AND NOT (resource_key IN (SELECT jsonb_array_elements_text(${JSON.stringify([...loadedSibling.keys])}::jsonb)))
      RETURNING id, resource_key
    `);
    const flipped = (Array.isArray(flippedRaw) ? flippedRaw : ((flippedRaw as unknown as { rows?: unknown[] }).rows ?? [])) as {
      id: string;
      resource_key: string;
    }[];
    for (const row of flipped) {
      idByKey.set(row.resource_key, row.id);
      reconcileEvents.push({
        resourceKey: row.resource_key,
        eventType: "delisted",
        prevValue: { status: "active" },
        newValue: { status: "delisted" },
      });
    }
  }

  // ---- record events (endpointId resolved from pre-write map; new endpoints can't have events) ----
  const eventIdByKey = new Map(idByKey);
  for (const event of events) {
    if (event.eventType !== "delisted" || eventIdByKey.has(event.resourceKey)) continue;
    const row = siblingRows.get(event.resourceKey);
    if (row) eventIdByKey.set(event.resourceKey, row.id);
  }
  for (const event of sharedRelists) {
    const row = siblingRows.get(event.resourceKey);
    if (row) eventIdByKey.set(event.resourceKey, row.id);
  }
  const eventsOut = [...events, ...sharedRelists, ...reconcileEvents];
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
        resourceKey: e.resourceKey,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
  if (eventRows.length > 0) {
    await db.insert(x402DelistingEvents).values(
      eventRows.map((row) => ({
        endpointId: row.endpointId,
        eventType: row.eventType,
        detectedOn: row.detectedOn,
        prevValue: row.prevValue,
        newValue: row.newValue,
      })),
    );
  }
  // 行に結び付かなかった delist は記録していないので、aux の件数にも出さない。
  const recordedEvents: CatalogDiffEvent[] = eventRows.map((row) => ({
    resourceKey: row.resourceKey,
    eventType: row.eventType,
    prevValue: row.prevValue,
    newValue: row.newValue,
  }));

  // ---- snapshot (idempotent per day: refresh on re-run) ----
  await db
    .insert(x402CatalogSnapshots)
    .values({
      snapshotDate: today,
      source,
      totalCount: result.totalCount,
      fetchedCount: result.fetchedCount,
      resourceKeys: [...currentKeys],
      complete: result.complete,
    })
    .onConflictDoUpdate({
      target: [x402CatalogSnapshots.snapshotDate, x402CatalogSnapshots.source],
      set: {
        totalCount: result.totalCount,
        fetchedCount: result.fetchedCount,
        resourceKeys: [...currentKeys],
        complete: result.complete,
      },
      // A partial re-run must not replace a full snapshot of the same day (2026-10-06).
      // complete=false（page_shape で件数だけ揃う日を含む）は、それより多く読んだ不完全な
      // snapshot だけを置き換える。complete が NULL の旧行は件数の規則のまま。
      ...(result.complete
        ? {}
        : {
            setWhere: sql`(
              ${x402CatalogSnapshots.complete} = false
              OR (
                ${x402CatalogSnapshots.complete} IS NULL
                AND (${x402CatalogSnapshots.fetchedCount} < ${x402CatalogSnapshots.totalCount} OR ${x402CatalogSnapshots.totalCount} = 0)
              )
            ) AND excluded.fetched_count > ${x402CatalogSnapshots.fetchedCount}`,
          }),
    });

  // ---- resource_id の別名 ----
  // 持ち主の method だけで作る。共有行を相手の method で別名にすると、どの行の resource_id も指さない。
  // 持ち主の移動で method が変わったときは、移動前の resource_id を新しい id へ向ける。
  try {
    if (movedAliases.length > 0) {
      await db.insert(x402ResourceAliases).values(movedAliases).onConflictDoNothing();
    }
    const prevByKey = new Map(knownRows.map((r) => [r.resourceKey, r]));
    const aliasItems = [...ownItems, ...transferItems];
    const aliasSources = aliasItems.flatMap((item) => {
      const ids = idsOf(item);
      if (!ids.canonicalUrl || !ids.resourceId) return [];
      const prev = prevByKey.get(item.resourceKey);
      const transferred = transferItems.includes(item);
      if (!transferred && prev && prev.resourceUrl === item.resourceUrl && prev.resourceId === ids.resourceId) return [];
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
    events: recordedEvents,
  };
}

// ============================================================
// カーソルの 1 ページ（2026-10-30 設計 v5 の 1・docs/catalog-staleness-contract.md 4.1 の 5）。
//
// runCatalogCursorCall がページを読むたびに呼ぶ。syncCatalog の cdp_bazaar の upsert と同じ列・同じ共有行の扱い
// （accepts_by_source・持ち主・持ち主の移動・別名）で書き、last_seen_at は差し込んだ clock の時刻、last_seen_pass は
// いまの周回の番号にする。閉じることはしない（第1段では cdp の行を閉じない。snapshot の差分も取らない）。
// relisted（delisted だった行が見えた）と settle_drop（30 日の呼び出し数が 70% 以上落ちた）は今と同じに書く。
// 複数文のトランザクションは使わない（本番は neon-http）。どの文も単独で正しい。
// ============================================================

export type CursorPageContext = {
  /** 差し込んだ clock の今。last_seen_at とイベントの日付に使う。 */
  now: Date;
  /** いまの周回の番号（x402_catalog_cursors.pass_seq）。 */
  passSeq: number;
  /** Circle の「載っている」集合。呼び出しごとに loadCursorCircleListing で 1 回読む。 */
  circle: SiblingListing;
};

export type CursorPageSummary = { upserted: number; skipped: number; events: number };

/** Circle の「載っている」集合（syncCatalog の兄弟の読み方と同じ）。 */
export async function loadCursorCircleListing(): Promise<SiblingListing> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");
  return loadSiblingListing(db, CIRCLE_DISCOVERY_SOURCE);
}

function cursorIdsOf(item: ParsedCatalogItem) {
  const c = canonicalUrl(item.resourceUrl);
  return {
    canonicalUrl: c?.url ?? null,
    resourceId: resourceId(item.method ?? "GET", item.resourceUrl),
    endpointHash: endpointHash(item.resourceUrl),
    payeeId: item.payTo && item.network ? payeeId(item.network, item.payTo) : null,
    undeclaredQuery: c?.undeclaredQuery ?? null,
  };
}

export async function upsertCatalogCursorPage(
  pageItems: readonly ParsedCatalogItem[],
  ctx: CursorPageContext,
): Promise<CursorPageSummary> {
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");
  const source = CATALOG_SOURCE;
  const sibling = CIRCLE_DISCOVERY_SOURCE;
  const seenAt = sql`${ctx.now.toISOString()}::timestamptz`;
  const detectedOn = ctx.now.toISOString().slice(0, 10);

  const byKey = new Map<string, ParsedCatalogItem>();
  for (const item of pageItems) if (item.resourceKey && !byKey.has(item.resourceKey)) byKey.set(item.resourceKey, item);
  if (byKey.size === 0) return { upserted: 0, skipped: 0, events: 0 };
  const keys = [...byKey.keys()];

  const existingRows = await db
    .select({
      id: x402Endpoints.id,
      resourceKey: x402Endpoints.resourceKey,
      source: x402Endpoints.source,
      status: x402Endpoints.status,
      rawAccepts: x402Endpoints.rawAccepts,
      acceptsBySource: x402Endpoints.acceptsBySource,
      qualityCalls30d: x402Endpoints.qualityCalls30d,
      qualityPayers30d: x402Endpoints.qualityPayers30d,
      qualityLastCalledAt: x402Endpoints.qualityLastCalledAt,
      declaredInput: x402Endpoints.declaredInput,
      resourceUrl: x402Endpoints.resourceUrl,
      resourceId: x402Endpoints.resourceId,
    })
    .from(x402Endpoints)
    .where(and(inArray(x402Endpoints.source, [...SHARED_SOURCES]), inArray(x402Endpoints.resourceKey, keys)));
  type Existing = (typeof existingRows)[number];
  const ownRows = new Map<string, Existing>();
  const circleRows = new Map<string, Existing>();
  for (const row of existingRows) (row.source === source ? ownRows : circleRows).set(row.resourceKey, row);

  const ownItems: ParsedCatalogItem[] = [];
  const sharedItems: ParsedCatalogItem[] = [];
  const transferItems: ParsedCatalogItem[] = [];
  for (const item of byKey.values()) {
    if (!circleRows.has(item.resourceKey)) ownItems.push(item);
    else if (ctx.circle.absenceProven && !ctx.circle.keys.has(item.resourceKey)) transferItems.push(item);
    else sharedItems.push(item);
  }
  const keepSiblingSlice = (key: string, existingBySource: unknown): boolean =>
    ctx.circle.keys.has(key) || (!ctx.circle.absenceProven && hasSiblingSlice(existingBySource, sibling));

  // relisted・settle_drop（delisted は出さない: prevKeys は空、currentComplete は false）。
  const events: CatalogDiffEvent[] = computeCatalogDiff({
    prevKeys: new Set<string>(),
    currentKeys: new Set(ownItems.map((i) => i.resourceKey)),
    currentComplete: false,
    knownEndpoints: new Map<string, KnownEndpointState>(
      [...ownRows.values()].map((r) => [r.resourceKey, { status: r.status, qualityCalls30d: r.qualityCalls30d }]),
    ),
    currentQuality: new Map(ownItems.map((i) => [i.resourceKey, i.qualityCalls30d])),
  });
  for (const item of [...sharedItems, ...transferItems]) {
    if (circleRows.get(item.resourceKey)?.status === "delisted") {
      events.push({ resourceKey: item.resourceKey, eventType: "relisted", prevValue: { status: "delisted" }, newValue: { status: "active" } });
    }
  }

  let upserted = 0;
  let skipped = 0;
  const skip = (key: string, error: unknown) => {
    skipped++;
    logServerErrorSafe("observatory.catalog-cursor.row_skipped", new Error(`${key}: ${error instanceof Error ? error.message : String(error)}`));
  };

  const updateShared = async (rowId: string, item: ParsedCatalogItem, existingBySource: unknown, existingRaw: unknown) => {
    const stored = composeAccepts({ existingBySource, existingRaw, incoming: item.rawAccepts, source, sibling, keepSibling: true });
    await db
      .update(x402Endpoints)
      .set({
        rawAccepts: stored.rawAccepts,
        acceptsBySource: stored.acceptsBySource,
        status: "active",
        delistedAt: null,
        lastSeenAt: seenAt,
        lastSeenPass: ctx.passSeq,
      })
      .where(eq(x402Endpoints.id, rowId));
  };

  const upsertOwn = async (chunk: ParsedCatalogItem[]) => {
    await db
      .insert(x402Endpoints)
      .values(
        chunk.map((item) => {
          const prior = ownRows.get(item.resourceKey);
          const stored = composeAccepts({
            existingBySource: prior?.acceptsBySource,
            existingRaw: prior?.rawAccepts,
            incoming: item.rawAccepts,
            source,
            sibling,
            keepSibling: keepSiblingSlice(item.resourceKey, prior?.acceptsBySource),
          });
          return {
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
            rawAccepts: stored.rawAccepts,
            acceptsBySource: stored.acceptsBySource,
            firstSeenAt: seenAt,
            lastSeenAt: seenAt,
            lastSeenPass: ctx.passSeq,
            ...cursorIdsOf(item),
          };
        }),
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
          declaredInput: sql`excluded.declared_input`,
          qualityCalls30d: sql`excluded.quality_calls_30d`,
          qualityPayers30d: sql`excluded.quality_payers_30d`,
          qualityLastCalledAt: sql`excluded.quality_last_called_at`,
          rawAccepts: sql`excluded.raw_accepts`,
          acceptsBySource: sql`excluded.accepts_by_source`,
          canonicalUrl: sql`excluded.canonical_url`,
          resourceId: sql`excluded.resource_id`,
          endpointHash: sql`excluded.endpoint_hash`,
          payeeId: sql`excluded.payee_id`,
          undeclaredQuery: sql`excluded.undeclared_query`,
          lastSeenAt: sql`excluded.last_seen_at`,
          lastSeenPass: sql`excluded.last_seen_pass`,
          status: sql`'active'`,
          delistedAt: sql`null`,
        },
      });
    upserted += chunk.length;
  };

  /** 一意の衝突（同じ鍵の行を Circle の同期が先に作った）なら共有行として書く。 */
  const mergeIntoShared = async (item: ParsedCatalogItem): Promise<boolean> => {
    const found = await db
      .select({ id: x402Endpoints.id, status: x402Endpoints.status, rawAccepts: x402Endpoints.rawAccepts, acceptsBySource: x402Endpoints.acceptsBySource })
      .from(x402Endpoints)
      .where(and(eq(x402Endpoints.resourceKey, item.resourceKey), inArray(x402Endpoints.source, [...SHARED_SOURCES])))
      .limit(1);
    const row = found[0];
    if (!row) return false;
    await updateShared(row.id, item, row.acceptsBySource, row.rawAccepts);
    return true;
  };

  if (ownItems.length > 0) {
    try {
      await upsertOwn(ownItems);
    } catch {
      for (const item of ownItems) {
        try {
          await upsertOwn([item]);
        } catch (rowError) {
          if (isUniqueViolationError(rowError)) {
            try {
              if (await mergeIntoShared(item)) {
                upserted++;
                continue;
              }
            } catch (mergeError) {
              skip(item.resourceKey, mergeError);
              continue;
            }
          }
          skip(item.resourceKey, rowError);
        }
      }
    }
  }

  for (const item of sharedItems) {
    const row = circleRows.get(item.resourceKey)!;
    try {
      await updateShared(row.id, item, row.acceptsBySource, row.rawAccepts);
      upserted++;
    } catch (rowError) {
      skip(item.resourceKey, rowError);
    }
  }

  // Circle の不在が証明でき、Circle の集合に無い鍵は、持ち主を cdp へ移す（syncCatalog と同じ規則）。
  const movedAliases: { aliasId: string; resourceId: string }[] = [];
  for (const item of transferItems) {
    const row = circleRows.get(item.resourceKey)!;
    const stored = composeAccepts({ existingBySource: null, existingRaw: null, incoming: item.rawAccepts, source, sibling, keepSibling: false });
    const ids = cursorIdsOf(item);
    try {
      await db
        .update(x402Endpoints)
        .set({
          source,
          resourceUrl: item.resourceUrl,
          method: item.method,
          network: item.network,
          payTo: item.payTo,
          priceAmount: item.priceAmount,
          priceAsset: item.priceAsset,
          description: item.description,
          declaredSchema: item.declaredSchema,
          declaredInput: declaredInputForMove(item.declaredInput, row.declaredInput),
          qualityCalls30d: item.qualityCalls30d ?? row.qualityCalls30d ?? null,
          qualityPayers30d: item.qualityPayers30d ?? row.qualityPayers30d ?? null,
          qualityLastCalledAt: item.qualityLastCalledAt ?? row.qualityLastCalledAt ?? null,
          rawAccepts: stored.rawAccepts,
          acceptsBySource: stored.acceptsBySource,
          ...ids,
          lastSeenAt: seenAt,
          lastSeenPass: ctx.passSeq,
          status: "active",
          delistedAt: null,
        })
        .where(eq(x402Endpoints.id, row.id));
      upserted++;
      if (row.resourceId && ids.resourceId && row.resourceId !== ids.resourceId) {
        movedAliases.push({ aliasId: row.resourceId, resourceId: ids.resourceId });
      }
    } catch (rowError) {
      skip(item.resourceKey, rowError);
    }
  }

  // イベント（行は今回より前からある。新しい行にイベントは無い）。
  const idByKey = new Map<string, string>();
  for (const row of existingRows) idByKey.set(row.resourceKey, row.id);
  const eventRows = events.flatMap((e) => {
    const endpointId = idByKey.get(e.resourceKey);
    return endpointId ? [{ endpointId, eventType: e.eventType, detectedOn, prevValue: e.prevValue, newValue: e.newValue }] : [];
  });
  if (eventRows.length > 0) await db.insert(x402DelistingEvents).values(eventRows);

  // 別名（新しい行・URL か resource_id が変わった行・持ち主を移した行）。
  try {
    if (movedAliases.length > 0) await db.insert(x402ResourceAliases).values(movedAliases).onConflictDoNothing();
    const aliasSources = [...ownItems, ...transferItems].flatMap((item) => {
      const ids = cursorIdsOf(item);
      if (!ids.canonicalUrl || !ids.resourceId) return [];
      const prev = ownRows.get(item.resourceKey);
      if (!transferItems.includes(item) && prev && prev.resourceUrl === item.resourceUrl && prev.resourceId === ids.resourceId) return [];
      return [{ resource_id: ids.resourceId, method: item.method ?? "GET", resource_url: item.resourceUrl }];
    });
    await writeResourceAliases(db, aliasSources);
  } catch (aliasError) {
    logServerErrorSafe("observatory.catalog-cursor.aliases", aliasError);
  }

  return { upserted, skipped, events: eventRows.length };
}
