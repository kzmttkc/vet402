// 本番: scripts/sql/2026-11-26-payer-reconcile.sql を当ててからデプロイすること（payer_reconcile_runs）。
import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { acquireLeaseFailClosed } from "@/lib/cron/lease-fail-closed";
import {
  runPayerReconcile,
  LOG_TAG_PAYER_RECONCILE_UNRECORDED,
  LOG_TAG_PAYER_RECONCILE_UNAVAILABLE,
} from "@/lib/settlements/payer-reconcile";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { exportDisallowedMethodHandlers, headFromGet } from "@/lib/api/method-not-allowed";

// 払い手送金と公開台帳 tx_hash の毎日の照合（読み取りのみ）。verify-settlements の後に走らせる。
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const lease = await acquireLeaseFailClosed("payer-reconcile", 330);
  if (!lease.acquired && lease.reason === "unverified") {
    return NextResponse.json({ ok: false, error: "lease_unverified" }, { status: 503 });
  }
  if (!lease.acquired) {
    return NextResponse.json({ ok: true, skipped: "lease_held" });
  }
  try {
    const deadlineAt = Date.now() + (maxDuration - 15) * 1000;
    const result = await runPayerReconcile({ deadlineAt });
    const status = result.ok ? 200 : 500;
    if (!result.ok) {
      if (result.totalUnrecorded > 0) {
        logServerErrorSafe(
          LOG_TAG_PAYER_RECONCILE_UNRECORDED,
          new Error(`${result.totalUnrecorded} unrecorded payer transfer(s) in the reconcile window`),
        );
      }
      if (result.anyUnavailable) {
        logServerErrorSafe(
          LOG_TAG_PAYER_RECONCILE_UNAVAILABLE,
          new Error("one or more chains were unavailable during payer reconcile"),
        );
      }
    }
    return NextResponse.json({ ...result }, { status });
  } catch (error) {
    logServerErrorSafe("cron.payer-reconcile", error);
    return NextResponse.json({ ok: false, error: "reconcile_failed" }, { status: 500 });
  } finally {
    await lease.release();
  }
}
const __disallowed = exportDisallowedMethodHandlers(["GET"]);
export const { POST, PUT, PATCH, DELETE, OPTIONS } = __disallowed;
export const HEAD = headFromGet(GET);