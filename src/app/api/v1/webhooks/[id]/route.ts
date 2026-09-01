import { NextRequest, NextResponse } from "next/server";
import { authenticateApiRequest } from "@/lib/api/guard";
import { deleteWebhook } from "@/lib/webhooks";
import { logServerError } from "@/lib/util/log";

/** DELETE /api/v1/webhooks/:id — remove an endpoint this key owns. */
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
    const deleted = await deleteWebhook(auth.ctx.apiKeyId, id);
    if (!deleted) {
      // Not found and not-yours are indistinguishable on purpose.
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    logServerError("webhooks_delete", error);
    return NextResponse.json({ error: "webhooks_unavailable" }, { status: 503 });
  }
}
