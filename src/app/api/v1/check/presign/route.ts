import { NextRequest } from "next/server";
import { handleKeylessCheckRoute } from "@/lib/api/keyless-check-route";
import { handlePresign } from "@/lib/api/presign-handler";
import { exportDisallowedMethodHandlers } from "@/lib/api/method-not-allowed";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 署名前スキャン（F7）。402 の本文を受け、GET /api/v1/check と同じ判定と accept ごとの照合を返す。鍵なし・check と同じ IP の枠。 */
// Server-Timing は回数制限から応答までの全部（handler の値を上書きする）。公開の計測（public/data/presign-latency.json）はこの値を数える。
export async function POST(request: NextRequest) {
  const t0 = performance.now();
  const res = await handleKeylessCheckRoute(request, "rest:presign", handlePresign);
  res.headers.set("Server-Timing", `presign;dur=${(performance.now() - t0).toFixed(1)}`);
  return res;
}
const __disallowed = exportDisallowedMethodHandlers(["POST"]);
export const { GET, PUT, PATCH, DELETE, OPTIONS, HEAD } = __disallowed;
