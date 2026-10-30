import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { runCatalogCursorCall } from "@/lib/observatory/catalog-cursor";
import { notifyDelistedEvents } from "@/lib/observatory/notify";
import { logServerErrorSafe } from "@/lib/util/log-safe";

// vet402 Observatory L0 — CDP Bazaar catalog ingestion (2026-10-30 design v5, docs/catalog-staleness-contract.md).
// The catalog (~100k listings, ~1,000 pages) does not fit one 300s function. Each run takes the cursor's lease,
// reads from where the previous run stopped for up to 200s, writes each page as it is read, and closes the pass
// when it passes the catalog's total. vercel.json schedules this about every 2 hours (Hobby may start a run
// anywhere in the scheduled hour; overlapping runs are stopped by the lease). Phase 1 closes no Bazaar listing.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    const result = await runCatalogCursorCall();
    if (result.skipped === "leased") {
      return NextResponse.json({ ok: true, skipped: "leased" });
    }
    // Deliver claim-scoped delisting alerts after the run — a failed delivery must not fail the sync (it retries on
    // the next run via the notified=false queue), so errors are logged, not thrown.
    let notify = { processed: 0, dispatched: 0 };
    try {
      notify = await notifyDelistedEvents();
    } catch (error) {
      logServerErrorSafe("cron.catalog-sync.notify", error);
    }
    // PayAI の受取人と Tempo の MPP directory・Circle は /api/cron/catalog-sync-aux（別の関数・別の 300 秒）。
    return NextResponse.json({
      notify,
      ok: true,
      passSeq: result.passSeq,
      startOffset: result.startOffset,
      nextOffset: result.nextOffset,
      total: result.total,
      pagesRead: result.pagesRead,
      pagesFailed: result.pagesFailed,
      itemsUpserted: result.itemsUpserted,
      closedPass: result.closedPass
        ? {
            passSeq: result.closedPass.passSeq,
            completedAt: result.closedPass.completedAt.toISOString(),
            pagesRead: result.closedPass.pagesRead,
            pagesFailed: result.closedPass.pagesFailed,
            weak: result.closedPass.weak,
          }
        : null,
      passStale: result.watchdog.stale,
    });
  } catch (error) {
    logServerErrorSafe("cron.catalog-sync", error);
    return NextResponse.json({ ok: false, error: "sync_failed" }, { status: 500 });
  }
}
