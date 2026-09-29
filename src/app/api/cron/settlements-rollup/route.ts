import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
// 2026-09-29 会計監査 7 周目（低）: acquireLease は取得の例外で「取れた」を返す。取れたと確かめられたときだけ走る。
import { acquireLeaseFailClosed } from "@/lib/cron/lease-fail-closed";
import { runRollup } from "@/lib/settlements/rollup";
import { logServerErrorSafe } from "@/lib/util/log-safe";

// 2026-09-04 W15: 生行の保持期間を守る日次処理。7 日より古い UTC 日を
// settlement_daily へ畳んで消す。index-settlements（13:00 UTC）の後、
// 決済が入り終わってから走らせる。
//
// lease で二重起動を防ぐ: 畳む処理自体は冪等だが、同時に 2 本走ると
// 同じ行を消し合って片方が待たされるだけで、得るものが無い。
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const lease = await acquireLeaseFailClosed("settlements-rollup", 330);
  if (!lease.acquired && lease.reason === "unverified") {
    return NextResponse.json({ ok: false, error: "lease_unverified" }, { status: 503 });
  }
  if (!lease.acquired) {
    return NextResponse.json({ ok: true, skipped: "lease_held" });
  }
  try {
    const result = await runRollup({ apply: true });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    logServerErrorSafe("cron.settlements-rollup", error);
    return NextResponse.json({ ok: false, error: "rollup_failed" }, { status: 500 });
  } finally {
    await lease.release();
  }
}
