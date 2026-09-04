import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { logServerError } from "@/lib/util/log";
import { scanWatchlist } from "@/lib/watchlist";

// N-15 — the monitoring heartbeat. Same engine, same fail-closed rules as a
// live lookup; webhooks fire only on verdict changes.
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 2026-09-04 監査 D・P1: lib の throw が理由なしの Next 既定 500 になっていた。
  // 理由をログへ残し、{ ok:false, error } を 500 で返す（cron は CRON_SECRET 越しの運用面）。
  try {
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? 100);
    const result = await scanWatchlist(Math.min(500, Math.max(1, limit)));
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    logServerError("cron.watchlist-scan", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
