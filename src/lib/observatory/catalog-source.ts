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
   * Politeness delay between pages. No documented rate limit; a live full
   * fetch (2026-08-14, 150 pages at 150ms) completed in 127s with zero 429s.
   * The default keeps the whole sync comfortably inside the cron's 300s.
   */
  sleepMs?: number;
  /** Retries per failing page with exponential backoff before giving up on the day. */
  maxRetriesPerPage?: number;
  baseUrl?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch the whole catalog, paging by offset until `pagination.total`.
 * A page that keeps failing ends the fetch early with complete=false rather
 * than looping forever or silently skipping a window of the keyspace.
 */
export async function fetchFullCatalog(
  options: FetchFullCatalogOptions = {},
): Promise<CatalogFetchResult> {
  const {
    fetchImpl = fetch,
    pageLimit = 100,
    sleepMs = 150,
    maxRetriesPerPage = 3,
    baseUrl = CATALOG_URL,
  } = options;

  const byKey = new Map<string, ParsedCatalogItem>();
  let totalCount = 0;
  let fetchedCount = 0;
  let offset = 0;
  let firstPage = true;

  for (;;) {
    const url = `${baseUrl}?limit=${pageLimit}&offset=${offset}`;

    let body: unknown = null;
    for (let attempt = 0; ; attempt++) {
      let res: Response | null = null;
      try {
        res = await fetchImpl(url);
      } catch {
        res = null; // network error — retry like a 5xx
      }
      if (res?.ok) {
        try {
          body = await res.json();
        } catch {
          body = null;
        }
        if (body !== null) break;
      }
      if (attempt >= maxRetriesPerPage) {
        // Give up on the DAY, not just the page: a skipped window would make
        // every endpoint in it look delisted. complete=false says so.
        return {
          items: [...byKey.values()],
          totalCount,
          fetchedCount,
          complete: totalCount > 0 && fetchedCount >= totalCount,
        };
      }
      await sleep(Math.min(10_000, 500 * 2 ** attempt) * (sleepMs === 0 ? 0 : 1));
    }

    const rec = asRecord(body);
    const items = Array.isArray(rec?.items) ? rec.items : [];
    const pagination = asRecord(rec?.pagination);
    const total = asFiniteNumber(pagination?.total);
    if (firstPage) {
      totalCount = total ?? items.length;
      firstPage = false;
    } else if (total !== null) {
      totalCount = total; // the catalog can grow/shrink mid-fetch; trust the latest
    }

    fetchedCount += items.length;
    for (const raw of items) {
      const parsed = parseCatalogItem(raw);
      if (!parsed.resourceKey) continue;
      if (!byKey.has(parsed.resourceKey)) byKey.set(parsed.resourceKey, parsed);
    }

    if (items.length === 0 || fetchedCount >= totalCount) {
      return {
        items: [...byKey.values()],
        totalCount,
        fetchedCount,
        complete: fetchedCount >= totalCount,
      };
    }

    offset += items.length;
    if (sleepMs > 0) await sleep(sleepMs);
  }
}
