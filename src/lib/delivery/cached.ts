// ============================================================
// 配達フィードの route 用キャッシュ（2026-10-28）。
// unstable_cache は tsx の pg テストでは動かないので、テストは sellers-feed.ts を直接呼ぶ。
// ============================================================
import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db/client";
import { PUBLIC_READ_REVALIDATE } from "@/lib/observatory/public-read-revalidate";
import { readDeliverySellersFeed, type DeliveryFeedPayload } from "./sellers-feed";
import type { DeliverySellersQuery } from "./sellers-feed-query";

function db() {
  const d = getDb();
  if (!d) throw new Error("database not configured");
  return d;
}

function cacheKey(query: DeliverySellersQuery): string[] {
  return [
    "delivery-sellers:v1",
    query.network ?? "",
    query.minDelivered === null ? "" : String(query.minDelivered),
    query.listedIn ?? "",
  ];
}

export function getDeliverySellersFeedCached(query: DeliverySellersQuery): Promise<DeliveryFeedPayload> {
  return unstable_cache(() => readDeliverySellersFeed(db(), query), cacheKey(query), {
    revalidate: PUBLIC_READ_REVALIDATE,
    tags: ["observatory"],
  })();
}
