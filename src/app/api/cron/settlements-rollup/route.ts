import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { acquireLease } from "@/lib/cron/lease";
import { runRollup } from "@/lib/settlements/rollup";
import { logServerError } from "@/lib/util/log";

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
  const lease = await acquireLease("settlements-rollup", 330);
  if (!lease.acquired) {
    return NextResponse.json({ ok: true, skipped: "lease_held" });
  }
  try {
    const result = await runRollup({ apply: true });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    logServerError("cron.settlements-rollup", error);
    return NextResponse.json({ ok: false, error: "rollup_failed" }, { status: 500 });
  } finally {
    await lease.release();
  }
}
