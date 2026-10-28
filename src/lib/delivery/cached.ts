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

export function getDeliverySellersFeedCached(query: DeliverySellersQuery): Promise<DeliveryFeedPayload> {
  return getDeliveryFeedSnapshotCached(db()).then((snapshot) => buildDeliveryFeedPayload(snapshot, query));
}
