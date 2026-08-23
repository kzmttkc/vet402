import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { acquireLease } from "@/lib/cron/lease";
import { runL1Batch } from "@/lib/observatory/l1-runner";
import { logServerError } from "@/lib/util/log";

// vet402 Observatory L1 — daily covert-purchase batch (design §5 W3).
// The weekly full sweep of the real-demand set emerges from the daily $25
// budget, not from a scheduler: each firing walks the highest-demand
// endpoints not purchased in the last 6 days and stops at the budget line.
// Dark-launch safe: with OBSERVATORY_L1_ENABLED unset or the wallet key
// absent, the batch refuses before any network traffic (tested).
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 2026-08-24 監査: バッチ全体の排他。予約SQLは単一文で原子的なので日次上限
  // そのものは破れないが、二重起動は孤児 in_flight の増減・summary の混乱・
  // 同じエンドポイントへの重複購入を生む。Vercel cron の重複発火は実在し得るし、
  // 手動トリガと定時が重なることもある（デモ日に一番困る形）。
  // TTL は maxDuration より少しだけ長く——短いと走行中に奪われ、長いと
  // 殺された後の再開が遅れる。
  const lease = await acquireLease("l1-purchase", 330);
  if (!lease.acquired) {
    return NextResponse.json(
      { ok: true, skipped: "already_running" },
      { status: 409 },
    );
  }

  try {
    const summary = await runL1Batch();
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    logServerError("cron.l1-purchase", error);
    return NextResponse.json({ ok: false, error: "l1_failed" }, { status: 500 });
  } finally {
    await lease.release();
  }
}
