// GET /api/tokyo/state — 画面が1発で引く現在値・直前の操作 10 件・押せない理由。
// 変えてから 90 秒以上たっていれば、ここで先に戻す（W05）。応答は Cache-Control: no-store。
import { handleState } from "../_lib/button";
import { realButtonDeps } from "../_lib/deps";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  return handleState(request, realButtonDeps());
}
