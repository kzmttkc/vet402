// ============================================================
// Bazaar discovery の delivery 欄（F10）。値は sellers.json スナップショットの行と 1 対 1。
// ============================================================

import { DECISION_RULES_VERSION, L1_WINDOW_DAYS } from "@/lib/decision/rules";
import { canonicalUrl, resourceId as toResourceId } from "@/lib/ids/canonical";
import { DELIVERY_RATE_FORMULA, type DeliveryRateBand } from "./delivery-rate";
import { deliveryFeedPublicRow, type DeliveryFeedPublicRow, type DeliveryFeedRow, type DeliveryFeedSnapshot } from "./sellers-feed";

const CATALOG_PROBE_METHODS = new Set(["GET", "POST", "HEAD", "DELETE"]);

export const BAZAAR_DELIVERY_MAX_ITEMS = 100;
export const BAZAAR_DELIVERY_MAX_BODY_BYTES = 2 * 1024 * 1024;
export const BAZAAR_DELIVERY_RATE_PER_MIN = 30;

export const BAZAAR_DELIVERY_FIELD_KEYS = [
  "paidAttempts30d",
  "delivered30d",
  "settledNotDelivered30d",
  "deliveryRateLowerBps30d",
  "deliveryRateBand30d",
  "lastAttemptAt30d",
  "lastDeliveredAt30d",
  "recordUrl",
  "network",
] as const;

export type BazaarDeliveryField = {
  paidAttempts30d: number;
  delivered30d: number;
  settledNotDelivered30d: number;
  deliveryRateLowerBps30d: number | null;
  deliveryRateBand30d: DeliveryRateBand;
  lastAttemptAt30d: string | null;
  lastDeliveredAt30d: string | null;
  recordUrl: string;
  network: string | null;
};

export type BazaarDeliveryEnvelope = {
  rules_version: typeof DECISION_RULES_VERSION;
  rate_formula: typeof DELIVERY_RATE_FORMULA;
  window_days: typeof L1_WINDOW_DAYS;
  as_of: string;
};

export function bazaarDeliveryFieldFromFeedPublicRow(pub: DeliveryFeedPublicRow): BazaarDeliveryField {
  return {
    paidAttempts30d: pub.paid_attempts_30d,
    delivered30d: pub.delivered_30d,
    settledNotDelivered30d: pub.settled_not_delivered_30d,
    deliveryRateLowerBps30d: pub.delivery_rate_lower_bps_30d,
    deliveryRateBand30d: pub.delivery_rate_band_30d,
    lastAttemptAt30d: pub.last_attempt_at_30d,
    lastDeliveredAt30d: pub.last_delivered_at_30d,
    recordUrl: pub.record_url,
    network: pub.network,
  };
}

export function bazaarDeliveryFieldFromFeedRow(row: DeliveryFeedRow): BazaarDeliveryField {
  return bazaarDeliveryFieldFromFeedPublicRow(deliveryFeedPublicRow(row));
}

export function bazaarDeliveryEnvelope(snapshot: Pick<DeliveryFeedSnapshot, "as_of">): BazaarDeliveryEnvelope {
  return {
    rules_version: DECISION_RULES_VERSION,
    rate_formula: DELIVERY_RATE_FORMULA,
    window_days: L1_WINDOW_DAYS,
    as_of: snapshot.as_of,
  };
}

/** catalog-source.ts と同じ: 宣言外の method は GET で引く。 */
export function bazaarCatalogProbeMethod(raw: string | null | undefined): string {
  const upper = raw?.trim().toUpperCase();
  if (!upper) return "GET";
  return CATALOG_PROBE_METHODS.has(upper) ? upper : "GET";
}

export function bazaarItemResourceUrl(item: unknown): string | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const r = (item as { resource?: unknown }).resource;
  return typeof r === "string" && r.trim() !== "" ? r.trim() : null;
}

export function bazaarItemMethod(item: unknown): string {
  const ext = item && typeof item === "object" && !Array.isArray(item) ? (item as { extensions?: unknown }).extensions : null;
  if (!ext || typeof ext !== "object") return "GET";
  const bazaar = (ext as { bazaar?: unknown }).bazaar;
  if (!bazaar || typeof bazaar !== "object") return "GET";
  const info = (bazaar as { info?: unknown }).info;
  if (!info || typeof info !== "object") return "GET";
  const input = (info as { input?: unknown }).input;
  if (!input || typeof input !== "object") return "GET";
  const method = (input as { method?: unknown }).method;
  return bazaarCatalogProbeMethod(typeof method === "string" ? method : null);
}

/** Bazaar item の primary accept の network（catalog-source.ts と同じく accepts[0]）。 */
export function bazaarItemAcceptNetwork(item: unknown): string | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const accepts = (item as { accepts?: unknown }).accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) return null;
  const first = accepts[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return null;
  const network = (first as { network?: unknown }).network;
  return typeof network === "string" && network.trim() !== "" ? network.trim() : null;
}

export function canonicalResourceLookupKey(rawUrl: string, method: string): { canonical: string; resourceId: string } | null {
  const c = canonicalUrl(rawUrl);
  if (!c) return null;
  return { canonical: c.url, resourceId: toResourceId(method, c.url) };
}