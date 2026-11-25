// ============================================================
// Bazaar delivery API の読み（F10）。sellers.json と同じスナップショット行を写す。
// ============================================================

import type { getDb } from "@/lib/db/client";
import { canonicalUrl } from "@/lib/ids/canonical";
import { toCaip2 } from "@/lib/observatory/chains";
import { getDeliveryFeedSnapshotCached } from "./sellers-feed-cache";
import type { DeliveryFeedRow, DeliveryFeedSnapshot } from "./sellers-feed";
import { compareFeedRows } from "./sellers-feed-query";
import {
  bazaarCatalogProbeMethod,
  bazaarDeliveryFieldFromFeedRow,
  bazaarItemAcceptNetwork,
  bazaarItemMethod,
  bazaarItemResourceUrl,
  type BazaarDeliveryField,
} from "./bazaar-field";

export type Db = NonNullable<ReturnType<typeof getDb>>;

function rowLookupKey(url: string, method: string): string | null {
  const c = canonicalUrl(url);
  if (!c) return null;
  return `${c.url}\0${bazaarCatalogProbeMethod(method)}`;
}

export function buildBazaarFeedRowIndex(rows: readonly DeliveryFeedRow[]): Map<string, DeliveryFeedRow[]> {
  const index = new Map<string, DeliveryFeedRow[]>();
  for (const row of rows) {
    const key = rowLookupKey(row.url, row.method);
    if (!key) continue;
    const list = index.get(key) ?? [];
    list.push(row);
    index.set(key, list);
  }
  return index;
}

function networkMatches(rowNetwork: string | null, hint: string): boolean {
  const rowCaip = rowNetwork === null ? null : (toCaip2(rowNetwork) ?? rowNetwork);
  const hintCaip = toCaip2(hint) ?? hint;
  if (rowCaip !== null && rowCaip.toLowerCase() === hintCaip.toLowerCase()) return true;
  return (rowNetwork ?? "").toLowerCase() === hint.toLowerCase();
}

function pickFeedRow(candidates: readonly DeliveryFeedRow[], networkHint: string | null): DeliveryFeedRow | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;
  if (networkHint) {
    const match = candidates.find((r) => networkMatches(r.network, networkHint));
    if (match) return match;
  }
  return [...candidates].sort((a, b) => compareFeedRows(a, b))[0]!;
}

function lookupInIndex(
  index: Map<string, DeliveryFeedRow[]>,
  rawUrl: string,
  method: string,
  networkHint: string | null,
): DeliveryFeedRow | null {
  const c = canonicalUrl(rawUrl);
  if (!c) return null;
  const key = `${c.url}\0${bazaarCatalogProbeMethod(method)}`;
  return pickFeedRow(index.get(key) ?? [], networkHint);
}

export function lookupBazaarDeliveryInSnapshot(
  snapshot: DeliveryFeedSnapshot,
  rawUrl: string,
  method: string,
  networkHint?: string | null,
): { canonicalUrl: string; delivery: BazaarDeliveryField | null } | null {
  const c = canonicalUrl(rawUrl);
  if (!c) return null;
  const index = buildBazaarFeedRowIndex(snapshot.rows);
  const row = lookupInIndex(index, rawUrl, method, networkHint ?? null);
  return {
    canonicalUrl: c.url,
    delivery: row ? bazaarDeliveryFieldFromFeedRow(row) : null,
  };
}

export async function readBazaarDeliveryByResourceUrl(
  db: Db,
  rawUrl: string,
  methodHint?: string | null,
): Promise<{ snapshot: DeliveryFeedSnapshot; canonicalUrl: string; delivery: BazaarDeliveryField | null } | null> {
  const snapshot = await getDeliveryFeedSnapshotCached(db);
  const index = buildBazaarFeedRowIndex(snapshot.rows);
  const methods =
    methodHint != null && methodHint !== ""
      ? [bazaarCatalogProbeMethod(methodHint)]
      : (["GET", "POST"] as const);

  for (const method of methods) {
    const c = canonicalUrl(rawUrl);
    if (!c) return null;
    const row = lookupInIndex(index, rawUrl, method, null);
    if (row) {
      return { snapshot, canonicalUrl: c.url, delivery: bazaarDeliveryFieldFromFeedRow(row) };
    }
  }
  const c = canonicalUrl(rawUrl);
  if (!c) return null;
  return { snapshot, canonicalUrl: c.url, delivery: null };
}

export type BazaarAnnotateKey = { index: number; canonical: string; method: string; network: string | null };

export function bazaarAnnotateKeys(items: unknown[]): BazaarAnnotateKey[] {
  const out: BazaarAnnotateKey[] = [];
  for (let index = 0; index < items.length; index++) {
    const url = bazaarItemResourceUrl(items[index]);
    if (!url) continue;
    const method = bazaarItemMethod(items[index]);
    const c = canonicalUrl(url);
    if (!c) continue;
    out.push({
      index,
      canonical: c.url,
      method,
      network: bazaarItemAcceptNetwork(items[index]),
    });
  }
  return out;
}

export async function readBazaarDeliveryAnnotateBatch(
  db: Db,
  keys: BazaarAnnotateKey[],
): Promise<{ snapshot: DeliveryFeedSnapshot; byIndex: Map<number, BazaarDeliveryField | null> }> {
  const snapshot = await getDeliveryFeedSnapshotCached(db);
  const index = buildBazaarFeedRowIndex(snapshot.rows);
  const byIndex = new Map<number, BazaarDeliveryField | null>();
  for (const k of keys) {
    const row = lookupInIndex(index, k.canonical, k.method, k.network);
    byIndex.set(k.index, row ? bazaarDeliveryFieldFromFeedRow(row) : null);
  }
  return { snapshot, byIndex };
}