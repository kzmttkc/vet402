// POST /api/tokyo/reset — 画面の「10000 に戻す」ボタン（時間の条件なし）。本文は {"to":"10000"} だけ。
import { handleReset } from "../_lib/button";
import { realButtonDeps } from "../_lib/deps";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleReset(request, realButtonDeps());
}
