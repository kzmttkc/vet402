// GET /api/tokyo/state — 画面が1発で引く現在値・直前の操作 10 件・押せない理由。
// 読むだけ。変えてから 90 秒以上たって戻っていなければ revertDue を返す（画面が POST /reset を呼ぶ。W05）。
// 応答は Cache-Control: no-store。
import { handleState } from "../_lib/button";
import { realButtonDeps } from "../_lib/deps";
import { TOKYO_LIMITS, tokyoRateLimit } from "../_lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const limited = await tokyoRateLimit(request, TOKYO_LIMITS.state, "allow");
  if (limited) return limited;
  return handleState(request, realButtonDeps());
}
