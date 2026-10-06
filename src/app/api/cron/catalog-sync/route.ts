import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { syncCatalog } from "@/lib/observatory/catalog-sync";
import { notifyDelistedEvents } from "@/lib/observatory/notify";
import { logServerErrorSafe } from "@/lib/util/log-safe";

// vet402 Observatory L0 — daily Bazaar catalog ingestion + delisting diff.
// ~150 paged requests against the public CDP discovery API, then chunked
// upserts of ~15k rows: comfortably inside 300s, nowhere near 60s.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const summary = await syncCatalog();
    // Deliver claim-scoped delisting alerts right after the diff — a failed
    // delivery must not fail the sync (it retries on the next daily run via
    // the notified=false queue), so errors are logged, not thrown.
    let notify = { processed: 0, dispatched: 0 };
    try {
      notify = await notifyDelistedEvents();
    } catch (error) {
      logServerErrorSafe("cron.catalog-sync.notify", error);
    }
    // PayAI の受取人と Tempo の MPP directory は 2026-10-07 から /api/cron/catalog-sync-aux（別の関数・別の 300 秒）。
    // ここに残すと Bazaar の取得に使える時間が 150 秒に縮み、429 で止まる日に後半が読めなかった。
    return NextResponse.json({
      notify,
      ok: true,
      snapshotDate: summary.snapshotDate,
      totalCount: summary.totalCount,
      fetchedCount: summary.fetchedCount,
      complete: summary.complete,
      upserted: summary.upserted,
      skipped: summary.skipped,
      events: {
        delisted: summary.events.filter((e) => e.eventType === "delisted").length,
        relisted: summary.events.filter((e) => e.eventType === "relisted").length,
        settleDrop: summary.events.filter((e) => e.eventType === "settle_drop").length,
      },
    });
  } catch (error) {
    logServerErrorSafe("cron.catalog-sync", error);
    return NextResponse.json({ ok: false, error: "sync_failed" }, { status: 500 });
  }
}
