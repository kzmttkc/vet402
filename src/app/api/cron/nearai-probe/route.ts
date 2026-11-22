import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { utcDayString } from "@/lib/observatory/metrics-rollup";
import { runNearAiLiveProbe } from "@/lib/nearai/live-probe";
import { getNearAiStore } from "@/lib/nearai/store";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const allNearai = request.nextUrl.searchParams.get("all") === "1" || request.nextUrl.searchParams.get("all") === "true";
  try {
    const output = await runNearAiLiveProbe({ allNearai: allNearai || process.env.NEARAI_PROBE_ALL === "1" });
    const store = getNearAiStore();
    const run = await store.ingestProbeOutput(output, utcDayString());
    return NextResponse.json({
      ok: true,
      runId: run.id,
      modelCount: run.models.length,
      completedAt: output.completedAt,
      heldModels: run.models.filter((m) => m.held).length,
    });
  } catch (error) {
    logServerErrorSafe("cron.nearai-probe", error);
    return NextResponse.json({ ok: false, error: "nearai_probe_failed" }, { status: 500 });
  }
}

const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);