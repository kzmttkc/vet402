// POST /api/tokyo/reset — 画面の「10000 に戻す」ボタンと、state の revertDue を見た画面（時間の条件なし）。本文は {"to":"10000"} だけ。
import { handleReset } from "../_lib/button";
import { realButtonDeps } from "../_lib/deps";
import { TOKYO_LIMITS, tokyoRateLimit } from "../_lib/rate-limit";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const limited = await tokyoRateLimit(request, TOKYO_LIMITS.reset, "allow");
  if (limited) return limited;
  return handleReset(request, realButtonDeps(), { check: new URL(request.url).searchParams.get("check") !== "0" });
}
