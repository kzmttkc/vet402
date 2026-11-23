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
  // 2026-11-23: 既定で NEAR が attestationSupported を付けた vllm モデルを全部調べる（初回は決め打ちの3つだけで、
  // 頁の nearaiModelCount が NEAR の 12 ではなく 3 になった）。?all=0 か NEARAI_PROBE_ALL=0 のときだけ3つに絞る。
  const allParam = request.nextUrl.searchParams.get("all");
  const narrow = allParam === "0" || allParam === "false" || process.env.NEARAI_PROBE_ALL === "0";
  try {
    const output = await runNearAiLiveProbe({ allNearai: !narrow });
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