// ============================================================
// vet402 Observatory L0 — Bazaar catalog source (design §3).
//
// Reads the CDP Bazaar discovery /list — public, no API key ("Bazaar
// discovery is public", verified live 2026-08-14: total≈15k, limit=100).
//
// Two invariants this module owns:
//
//  1. resourceKey STABILITY. The daily delisting diff compares key sets
//     across days; any key that flaps (query noise, host casing, trailing
//     slash) becomes a phantom delisting — the false-alarm class the
//     observatory exists to kill. Keys are host+path only.
//
//  2. HONEST partial fetches. When a page cannot be fetched even after
//     retries, the result says complete=false and the caller WITHHOLDS
//     delisting judgement for the day. A fetch gap must never read as
//     "the endpoint vanished" (verify-the-instrument).
//
// No scoring/chain imports — the observatory is an independent domain.
// ============================================================
import { declaredInputSummary } from "./declared-input-rules";
import type { DeclaredInputSummary } from "./declared-input-summary";

export const CATALOG_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";

export const CATALOG_SOURCE = "cdp_bazaar";

/** Methods the catalog can declare and the prober will honor. Anything else = undeclared. */
const DECLARED_METHODS = new Set(["GET", "POST", "HEAD", "DELETE"]);

export type ParsedCatalogItem = {
  resourceKey: string;
  resourceUrl: string;
  /** Uppercased declared method, or null when undeclared/unrecognized — the prober never guesses. */
  method: string | null;
  network: string | null;
  /** Lowercased so the claim-join against verifiedPayees.wallet (also lowercase) cannot miss on casing. */
  payTo: string | null;
  priceAmount: string | null;
  priceAsset: string | null;
  description: string | null;
  declaredSchema: unknown | null;
  /**
   * 送る規則（declared-input.ts）をこの掲載の `extensions.bazaar` に当てた要約（2026-09-29）。
   * /sellers と retest が「vet402 が宣言を送っていなかった」を、送る規則と同じ情報源で判定するため。
   */
  declaredInput?: DeclaredInputSummary | null;
  qualityCalls30d: number | null;
  qualityPayers30d: number | null;
  qualityLastCalledAt: Date | null;
  rawAccepts: unknown | null;
};

/**
 * host+path identity for an endpoint. Strips scheme/query/fragment, lowercases
 * the host (DNS is case-insensitive), preserves path case (paths are not),
 * and treats a trailing slash as no-op. Route-template variables (`:id`)
 * survive verbatim. Unparseable input falls back to the trimmed raw string —
 * a stable if ugly key beats a dropped row.
 */
export function normalizeResourceKey(raw: string): string {
  const trimmed = (raw ?? "").trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  const host = url.hostname.toLowerCase();
  const port = url.port ? `:${url.port}` : "";
  let path = url.pathname;
  while (path.endsWith("/")) path = path.slice(0, -1);
  return `${host}${port}${path}`;
}

/**
 * カタログの取り込みで残してよい resource か（2026-09-29 監査 6 周目・中・CSV injection）。http(s) の URL として
 * 読め、ホストがあり、空白・制御文字を含まないものだけ。`=HYPERLINK(...)` のような値は売り手が書いた文字列の
 * まま export に出ていた（既存の行は export の csvCell が無害化する）。URL の構文で弾くので、先頭の `=` `+` `-` `@` は
 * ここを通らない（URL は英字の scheme で始まる）。
 */
export function isImportableResourceUrl(raw: string): boolean {
  if (raw === "" || /[\u0000-\u0020\u007f]/.test(raw)) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (url.protocol === "https:" || url.protocol === "http:") && url.hostname !== "";
}

/**
 * Strip NUL (U+0000) from every string in an arbitrary structure. Found live
 * 2026-08-14: one catalog item carried a NUL inside its declared schema;
 * Postgres rejects NUL in text/jsonb ("invalid byte sequence for encoding
 * UTF8") and that single row failed its whole 500-row upsert chunk in
 * production. Third-party bytes must never take down the day's sync.
 */
function stripNul<T>(value: T): T {
  if (typeof value === "string") return value.replaceAll("\u0000", "") as T;
  if (Array.isArray(value)) return value.map(stripNul) as T;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[stripNul(k)] = stripNul(v);
    return out as T;
  }
  return value;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Extract the DB row shape from one raw catalog item. Defensive on every path — catalog data is third-party input. */
export function parseCatalogItem(item: unknown): ParsedCatalogItem {
  const rec = stripNul(asRecord(item) ?? {});
  const resourceUrl = asString(rec.resource) ?? "";

  // Declared method: extensions.bazaar.info.input.method. Unknown strings are
  // treated as undeclared (null) — fail-closed toward `unverified`, not toward
  // probing with a guessed method (#3113 class).
  const bazaar = asRecord(asRecord(rec.extensions)?.bazaar);
  const input = asRecord(asRecord(bazaar?.info)?.input);
  const rawMethod = asString(input?.method)?.toUpperCase() ?? null;
  const method = rawMethod && DECLARED_METHODS.has(rawMethod) ? rawMethod : null;

  // The JSON Schema has been observed at extensions.bazaar.schema (live) and
  // is documented at extensions.bazaar.info.schema in places — accept either.
  const declaredSchema = bazaar?.schema ?? asRecord(bazaar?.info)?.schema ?? null;

  const accepts = Array.isArray(rec.accepts) ? rec.accepts : [];
  const first = asRecord(accepts[0]);
  const payToRaw = asString(first?.payTo) ?? asString(first?.recipient);

  const quality = asRecord(rec.quality);

  return {
    resourceKey: normalizeResourceKey(resourceUrl),
    resourceUrl,
    method,
    network: asString(first?.network),
    // 0x（EVM）だけ小文字化する。EVMのアドレスは大文字小文字非依存で、
    // verifiedPayees.wallet（小文字）へのclaim-joinを外さないための正規化。
    // base58（Solana等）は大文字小文字が情報そのもの——小文字化は破壊
    // （2026-08-20 実測: 本番218件のSolana行が復元不能な形で保存されていた）。
    payTo: payToRaw ? (payToRaw.startsWith("0x") ? payToRaw.toLowerCase() : payToRaw) : null,
    priceAmount: asString(first?.amount),
    priceAsset: asString(first?.asset),
    description: asString(rec.description),
    declaredSchema,
    declaredInput: declaredInputSummary({ resourceUrl, document: rec }),
    qualityCalls30d: asFiniteNumber(quality?.l30DaysTotalCalls),
    qualityPayers30d: asFiniteNumber(quality?.l30DaysUniquePayers),
    qualityLastCalledAt: asDate(quality?.lastCalledAt),
    rawAccepts: accepts.length > 0 ? accepts : null,
  };
}

export type CatalogFetchResult = {
  /** Parsed items, deduped by resourceKey (first occurrence wins). */
  items: ParsedCatalogItem[];
  /** What the API says exists. */
  totalCount: number;
  /** Raw items actually received (before dedup) — honesty metric vs totalCount. */
  fetchedCount: number;
  /** true only when fetchedCount >= totalCount. Callers withhold delisting judgement when false. */
  complete: boolean;
};

export type FetchFullCatalogOptions = {
  fetchImpl?: (url: string) => Promise<Response>;
  /** Page size (API max 100). Tests shrink it. */
  pageLimit?: number;
  /**
   * Politeness delay between one worker's pages. No documented rate limit; a live full
   * fetch (2026-08-14, 150 pages at 150ms) completed in 127s with zero 429s.
   */
  sleepMs?: number;
  /** Retries per failing page with exponential backoff before giving up on the day. */
  maxRetriesPerPage?: number;
  baseUrl?: string;
  /**
   * Pages in flight at once (default 1 = sequential, the old behaviour). The Bazaar sync passes
   * more: a page takes ~1.2s from Vercel and the catalog passed 35k rows (350 pages, ~410s
   * sequential) on 2026-10-04, past the cron's 300s — 10/4 and 10/5 both timed out. The first
   * page is always fetched alone (it carries `total`); the rest are claimed in offset order.
   */
  concurrency?: number;
  /**
   * Stop claiming new pages after this many ms (default: none) and report complete=false, so the
   * caller upserts what it has, withholds delisting, and the function still finishes inside its
   * maxDuration instead of being killed with nothing written.
   */
  deadlineMs?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A hung request must not eat the whole function budget; the default fetch gives up per page. */
const PAGE_TIMEOUT_MS = 25_000;
const defaultFetch = (url: string) => fetch(url, { signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });

/**
 * Fetch the whole catalog, paging by offset until `pagination.total`.
 * A page that keeps failing (or the deadline) ends the fetch early with complete=false rather
 * than looping forever or silently skipping a window of the keyspace: a skipped window would
 * make every endpoint in it look delisted.
 */
export async function fetchFullCatalog(
  options: FetchFullCatalogOptions = {},
): Promise<CatalogFetchResult> {
  const {
    fetchImpl = defaultFetch,
    pageLimit = 100,
    sleepMs = 150,
    maxRetriesPerPage = 3,
    baseUrl = CATALOG_URL,
    concurrency = 1,
    deadlineMs,
  } = options;
  const deadlineAt = deadlineMs === undefined ? Infinity : Date.now() + deadlineMs;

  /** Parsed, importable items per page, keyed by page index so the merge below is in offset order. */
  const pages = new Map<number, ParsedCatalogItem[]>();
  let totalCount = 0;
  let fetchedCount = 0;
  /** The largest total any page reported: every page up to it must have been read, whatever a later page said. */
  let maxTotal = 0;
  let step = 0;
  let aborted = false;

  /** One page with retries. null = gave up (retries exhausted). */
  const fetchPage = async (offset: number): Promise<{ items: unknown[]; total: number | null } | null> => {
    const url = `${baseUrl}?limit=${pageLimit}&offset=${offset}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await fetchImpl(url);
      } catch {
        res = null; // network error or timeout — retry like a 5xx
      }
      let body: unknown = null;
      if (res?.ok) {
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        if (body !== null) {
          const rec = asRecord(body);
          return {
            items: Array.isArray(rec?.items) ? rec.items : [],
            total: asFiniteNumber(asRecord(rec?.pagination)?.total),
          };
        }
      }
      if (attempt >= maxRetriesPerPage || Date.now() >= deadlineAt) return null;
      await sleep(Math.min(10_000, 500 * 2 ** attempt) * (sleepMs === 0 ? 0 : 1));
    }
  };

  const take = (index: number, got: { items: unknown[]; total: number | null }) => {
    fetchedCount += got.items.length;
    const parsedItems: ParsedCatalogItem[] = [];
    for (const raw of got.items) {
      const parsed = parseCatalogItem(raw);
      if (!parsed.resourceKey) continue;
      // URL として読めない resource は取り込まない（監査 6 周目）。fetchedCount には数えたまま（complete の判定は
      // 「API が返した件数を全部受け取ったか」で、残した件数ではない）。
      if (!isImportableResourceUrl(parsed.resourceUrl)) continue;
      parsedItems.push(parsed);
    }
    pages.set(index, parsedItems);
  };

  const finish = (): CatalogFetchResult => {
    const byKey = new Map<string, ParsedCatalogItem>();
    for (const index of [...pages.keys()].sort((a, b) => a - b)) {
      // first occurrence (lowest offset) wins
      for (const parsed of pages.get(index)!) if (!byKey.has(parsed.resourceKey)) byKey.set(parsed.resourceKey, parsed);
    }
    // complete means "every page of the keyspace was read", not just "enough items were counted":
    // an overlap in one place must never cancel out a gap in another (that would read as delisted).
    let allPages = step > 0;
    for (let i = 0; allPages && i < Math.ceil(maxTotal / step); i++) allPages = pages.has(i);
    return {
      items: [...byKey.values()],
      totalCount,
      fetchedCount,
      complete: !aborted && totalCount > 0 && fetchedCount >= totalCount && (maxTotal === 0 || allPages),
    };
  };

  // The first page alone: it says how many pages there are and how many items a page really holds.
  const first = await fetchPage(0);
  if (first === null) {
    aborted = true;
    return finish();
  }
  totalCount = first.total ?? first.items.length;
  maxTotal = totalCount;
  take(0, first);
  step = first.items.length; // what the API actually returned (it may cap below pageLimit)
  if (step === 0 || fetchedCount >= totalCount) return finish();

  let nextIndex = 1;
  const worker = async () => {
    for (;;) {
      if (aborted) return;
      if (Date.now() >= deadlineAt) {
        aborted = true; // out of time: stop honestly, never read the gap as "delisted"
        return;
      }
      const index = nextIndex++;
      const offset = index * step;
      if (offset >= totalCount) return;
      const got = await fetchPage(offset);
      if (got === null) {
        aborted = true;
        return;
      }
      if (got.total !== null) {
        totalCount = got.total; // the catalog can grow/shrink mid-fetch; trust the latest
        maxTotal = Math.max(maxTotal, totalCount);
      }
      take(index, got);
      // Offsets are index * step, so every page but the last must hold exactly `step` items. A short
      // (or long) page in the middle means a gap or an overlap: stop and say so — never let the
      // item count balance it out.
      const isTail = offset + got.items.length >= totalCount;
      if (got.items.length !== step && !isTail) {
        aborted = true;
        return;
      }
      if (got.items.length === 0) return;
      if (sleepMs > 0) await sleep(sleepMs);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.floor(concurrency)) }, worker));
  return finish();
}
