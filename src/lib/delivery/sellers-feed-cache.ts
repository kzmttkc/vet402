// ============================================================
// 配達フィードのプロセス内キャッシュ（2026-10-28 点検 H3）。300 秒・同時読み込み 1 本。
// export 枠は DB を読む側だけが取る（H2）。
// ============================================================
import type { getDb } from "@/lib/db/client";
import { acquireExportSlot } from "@/lib/api/export-guard";
import { readDeliverySellersFeedSnapshot, type DeliveryFeedSnapshot } from "./sellers-feed";

export const DELIVERY_FEED_CACHE_MS = 300_000;

export class DeliveryFeedExportBusy extends Error {
  readonly unavailable: boolean;
  constructor(unavailable: boolean) {
    super(unavailable ? "temporarily_unavailable" : "export_busy");
    this.unavailable = unavailable;
  }
}

type Db = NonNullable<ReturnType<typeof getDb>>;

let cached: { at: number; data: DeliveryFeedSnapshot } | null = null;
let inflight: Promise<DeliveryFeedSnapshot> | null = null;
let dbReadCount = 0;
let exportSlotAcquireCount = 0;

export function deliveryFeedDbReadCount(): number {
  return dbReadCount;
}

export function deliveryFeedExportSlotAcquireCount(): number {
  return exportSlotAcquireCount;
}

export function resetDeliveryFeedCacheForTest(): void {
  cached = null;
  inflight = null;
  dbReadCount = 0;
  exportSlotAcquireCount = 0;
}

async function loadSnapshot(db: Db): Promise<DeliveryFeedSnapshot> {
  const slot = await acquireExportSlot();
  exportSlotAcquireCount++;
  if (!slot.ok) throw new DeliveryFeedExportBusy(slot.unavailable);
  try {
    dbReadCount++;
    return await readDeliverySellersFeedSnapshot(db);
  } finally {
    await slot.release();
  }
}

export async function getDeliveryFeedSnapshotCached(db: Db): Promise<DeliveryFeedSnapshot> {
  const now = Date.now();
  if (cached && now - cached.at < DELIVERY_FEED_CACHE_MS) return cached.data;
  if (inflight) return inflight;
  inflight = (async () => {
    const data = await loadSnapshot(db);
    cached = { at: Date.now(), data };
    return data;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}
