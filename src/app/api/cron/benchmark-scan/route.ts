import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { logServerError } from "@/lib/util/log";
import { benchmarkScanFailed, runBenchmarkScan } from "@/lib/benchmark/runner";

/**
 * Operator benchmark heartbeat (2026-08-06). WEEKLY on purpose — see
 * vercel.json: the plan's cron frequency ceiling is daily (a 6-hour cron
 * once made deploys fail silently for 9 hours), and ground-truth labels
 * don't move fast enough to justify daily RPC spend on ~40 addresses.
 * Same engine and fail-closed rules as a live lookup; results land in
 * verdict_outcomes under source='operator_benchmark' and surface in the
 * separate "Operator benchmark" section of /accuracy.
 */
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 2026-09-04 監査 D・P1: lib の throw が理由なしの Next 既定 500 になっていた。
  // 理由をログへ残し、{ ok:false, error } を 500 で返す（cron は CRON_SECRET 越しの運用面）。
  try {
    const limitParam = Number(request.nextUrl.searchParams.get("limit") ?? 100);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitParam) ? limitParam : 100));
    const result = await runBenchmarkScan({ limit });

    // 走査したのに1行も記録できなかった run を 200/ok で返していたことが、
    // 「本番の benchmark_seed は史上0行」を7日ごとに見えなくしていた（2026-08-13）。
    // 監視は HTTP ステータスしか見ないので、沈黙を止めるにはここを 500 にするしかない。
    const failed = benchmarkScanFailed(result);
    return NextResponse.json({ ok: !failed, ...result }, { status: failed ? 500 : 200 });
  } catch (error) {
    logServerError("cron.benchmark-scan", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
