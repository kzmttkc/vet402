import { NextRequest, NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/api/guard";
import { removeWatch } from "@/lib/watchlist";
import { logServerError } from "@/lib/util/log";

// 2026-09-02 監査: 静的化された route handler が prerender から古い判定を返すのを防ぐ（09c1fa0 と同じ欠陥）。
export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.error;
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }
  try {
    const removed = await removeWatch(auth.ctx.apiKeyId, id);
    return removed
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "not_found" }, { status: 404 });
  } catch (error) {
    logServerError("watchlist_remove", error);
    return NextResponse.json({ error: "watchlist_unavailable" }, { status: 503 });
  }
}
