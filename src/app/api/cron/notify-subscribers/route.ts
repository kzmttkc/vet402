import { NextRequest, NextResponse } from "next/server";
import { authorizeCron } from "@/lib/cron/auth";
import { logServerError } from "@/lib/util/log";
import { notifySubscribers } from "@/lib/observatory/record-subscriptions";

/**
 * GET /api/cron/notify-subscribers — 日次。record_subscriptions(kind=notify) の
 * last_verdict と現在の公開判定を比べ、変わっていれば 1 通送って進める。
 * 送信未設定なら進めない（設定された日に溜まった変更が届く）。
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 2026-09-04 監査 D・P1: lib の throw が理由なしの Next 既定 500 になっていた。
  // 理由をログへ残し、{ ok:false, error } を 500 で返す（cron は CRON_SECRET 越しの運用面）。
  try {
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? 500);
    const result = await notifySubscribers(Math.min(5_000, Math.max(1, limit)));
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    logServerError("cron.notify-subscribers", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
