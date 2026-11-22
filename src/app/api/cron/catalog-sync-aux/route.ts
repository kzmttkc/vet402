import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { syncCircleDiscovery } from "@/lib/observatory/circle-discovery";
import { syncMppDirectory } from "@/lib/observatory/mpp-directory";
import { syncOperatorListings } from "@/lib/observatory/operator-sync";
import { syncRail402Discovery } from "@/lib/observatory/snapshot-only-catalogs";
import { refreshSolanaDiscoveryPayees } from "@/lib/settlements/discovery-payees";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";

// The catalog-side jobs that used to run inside /api/cron/catalog-sync (moved 2026-10-07 so the
// Bazaar fetch there gets the function's time): the PayAI discovery payees for the settlement index,
// and Tempo's MPP directory (source = mpp_directory). Circle's x402 discovery (source = circle_discovery)
// runs here too, after MPP (2026-10-26). No new cron. Each failure is logged and reported; none
// blocks the others. Circle's own fetch deadline is 60s, inside this function's 300s.
// The operator list (source = operator, src/lib/observatory/operator-listings.ts) runs after Circle
// (2026-11-22): sellers vet402 adds itself. No fetch, the list is in the repo.
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
  let circleDiscovery: unknown = null;
  try {
    const c = await syncCircleDiscovery();
    circleDiscovery = { totalCount: c.totalCount, fetchedCount: c.fetchedCount, complete: c.complete, upserted: c.upserted, skipped: c.skipped, delisted: c.events.filter((e) => e.eventType === "delisted").length };
  } catch (error) {
    logServerErrorSafe("cron.catalog-sync-aux.circle-discovery", error);
    circleDiscovery = { error: "circle_discovery_failed" };
  }
  let operatorListings: unknown = null;
  try {
    const o = await syncOperatorListings();
    operatorListings = { totalCount: o.totalCount, complete: o.complete, upserted: o.upserted, skipped: o.skipped, delisted: o.events.filter((e) => e.eventType === "delisted").length };
  } catch (error) {
    logServerErrorSafe("cron.catalog-sync-aux.operator-listings", error);
    operatorListings = { error: "operator_listings_failed" };
  }
  let rail402Discovery: unknown = null;
  try {
    rail402Discovery = await syncRail402Discovery();
  } catch (error) {
    logServerErrorSafe("cron.catalog-sync-aux.rail402-discovery", error);
    rail402Discovery = { error: "rail402_discovery_failed" };
  }
  return NextResponse.json({ ok: true, discoveryPayees, mppDirectory, circleDiscovery, operatorListings, rail402Discovery });
}
const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);
