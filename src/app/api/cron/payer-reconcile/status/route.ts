import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { listPayerReconcileRuns } from "@/lib/settlements/payer-reconcile-runs";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";

/** 払い手照合の直近の実行記録（監視用・CRON_SECRET 必須）。 */
export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const limitRaw = request.nextUrl.searchParams.get("limit");
  const limit = limitRaw ? Math.min(100, Math.max(1, Number.parseInt(limitRaw, 10) || 30)) : 30;
  try {
    const runs = await listPayerReconcileRuns(limit);
    return NextResponse.json({ runs });
  } catch (error) {
    return NextResponse.json({ ok: false, error: "list_failed" }, { status: 500 });
  }
}
const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);