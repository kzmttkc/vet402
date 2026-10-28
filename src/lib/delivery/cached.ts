// ============================================================
// 配達フィードの route 用キャッシュ（2026-10-28 点検 H3）。
// ============================================================
import { getDb } from "@/lib/db/client";
import { buildDeliveryFeedPayload, type DeliveryFeedPayload } from "./sellers-feed";
import { getDeliveryFeedSnapshotCached } from "./sellers-feed-cache";
import type { DeliverySellersQuery } from "./sellers-feed-query";

function db() {
  const d = getDb();
  if (!d) throw new Error("database not configured");
  return d;
}

let feedCachedForTest: ((query: DeliverySellersQuery) => Promise<DeliveryFeedPayload>) | null = null;

/** route テスト用: DB 読みを差し替える。 */
export function setDeliveryFeedCachedForTest(loader: typeof feedCachedForTest): void {
  feedCachedForTest = loader;
}

export function getDeliverySellersFeedCached(query: DeliverySellersQuery): Promise<DeliveryFeedPayload> {
  if (feedCachedForTest) return feedCachedForTest(query);
  return getDeliveryFeedSnapshotCached(db()).then((snapshot) => buildDeliveryFeedPayload(snapshot, query));
}
