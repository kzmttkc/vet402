import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { syncCatalog } from "@/lib/observatory/catalog-sync";
import { notifyDelistedEvents } from "@/lib/observatory/notify";
import { refreshSolanaDiscoveryPayees } from "@/lib/settlements/discovery-payees";
import { logServerError } from "@/lib/util/log";

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
      logServerError("cron.catalog-sync.notify", error);
    }
    // 決済索引の受取人（カタログの外・PayAI の公開 discovery）。失敗しても同期は成功のまま返す。
    let discoveryPayees: unknown = null;
    try {
      discoveryPayees = await refreshSolanaDiscoveryPayees();
    } catch (error) {
      logServerError("cron.catalog-sync.discovery-payees", error);
      discoveryPayees = { error: "discovery_payees_failed" };
    }
    return NextResponse.json({
      notify,
      discoveryPayees,
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
    logServerError("cron.catalog-sync", error);
    return NextResponse.json({ ok: false, error: "sync_failed" }, { status: 500 });
  }
}
