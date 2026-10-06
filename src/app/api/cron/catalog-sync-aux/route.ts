import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { syncMppDirectory } from "@/lib/observatory/mpp-directory";
import { refreshSolanaDiscoveryPayees } from "@/lib/settlements/discovery-payees";
import { logServerErrorSafe } from "@/lib/util/log-safe";

// The two catalog-side jobs that used to run inside /api/cron/catalog-sync (moved 2026-10-07 so the
// Bazaar fetch there gets the function's time): the PayAI discovery payees for the settlement index,
// and Tempo's MPP directory (source = mpp_directory). Each failure is logged and reported; neither
// one blocks the other.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let discoveryPayees: unknown = null;
  try {
    discoveryPayees = await refreshSolanaDiscoveryPayees();
  } catch (error) {
    logServerErrorSafe("cron.catalog-sync-aux.discovery-payees", error);
    discoveryPayees = { error: "discovery_payees_failed" };
  }
  let mppDirectory: unknown = null;
  try {
    const m = await syncMppDirectory();
    mppDirectory = { totalCount: m.totalCount, fetchedCount: m.fetchedCount, complete: m.complete, upserted: m.upserted, skipped: m.skipped, delisted: m.events.filter((e) => e.eventType === "delisted").length };
  } catch (error) {
    logServerErrorSafe("cron.catalog-sync-aux.mpp-directory", error);
    mppDirectory = { error: "mpp_directory_failed" };
  }
  return NextResponse.json({ ok: true, discoveryPayees, mppDirectory });
}
