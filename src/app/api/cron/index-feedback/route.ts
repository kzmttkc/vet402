import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { isProduction } from "@/lib/config/env";
import { indexFeedbackEvents } from "@/lib/indexer/feedback-indexer";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 2026-09-04 監査 D・P1: lib の throw が理由なしの Next 既定 500 になっていた。
  // 理由をログへ残し、{ ok:false, error } を 500 で返す（cron は CRON_SECRET 越しの運用面）。
  try {
    // Production ignores attacker-controlled maxBlocks (RPC burn); use default.
    // 400k leaves margin for catching up after missed runs while staying far
    // inside the 300s budget. Since 2026-11-05 Base produces 432,000 blocks a
    // day (0.2 s); the 30-minute cron needs ~9,000 per run, and the 8-day
    // bootstrap (chain time, block-clock.ts) takes several runs.
    const raw = request.nextUrl.searchParams.get("maxBlocks");
    const requested = raw ? Number(raw) : 400_000;
    const maxBlocks = isProduction()
      ? 400_000
      : Math.min(1_000_000, Math.max(1_000, Number.isFinite(requested) ? requested : 400_000));

    const result = await indexFeedbackEvents({ maxBlocks: BigInt(maxBlocks) });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    logServerErrorSafe("cron.index-feedback", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
