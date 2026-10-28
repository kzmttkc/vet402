// ============================================================
// 配達フィードのプロセス内キャッシュ（2026-10-28 点検 H3）。300 秒・同時読み込み 1 本。
// ============================================================
import type { getDb } from "@/lib/db/client";
import { readDeliverySellersFeedSnapshot, type DeliveryFeedSnapshot } from "./sellers-feed";

export const DELIVERY_FEED_CACHE_MS = 300_000;

type Db = NonNullable<ReturnType<typeof getDb>>;

let cached: { at: number; data: DeliveryFeedSnapshot } | null = null;
let inflight: Promise<DeliveryFeedSnapshot> | null = null;
let dbReadCount = 0;

export function deliveryFeedDbReadCount(): number {
  return dbReadCount;
}

export function resetDeliveryFeedCacheForTest(): void {
  cached = null;
  inflight = null;
  dbReadCount = 0;
}

export async function getDeliveryFeedSnapshotCached(db: Db): Promise<DeliveryFeedSnapshot> {
  const now = Date.now();
  if (cached && now - cached.at < DELIVERY_FEED_CACHE_MS) return cached.data;
  if (inflight) return inflight;
  inflight = (async () => {
    dbReadCount++;
    const data = await readDeliverySellersFeedSnapshot(db);
    cached = { at: Date.now(), data };
    return data;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}
