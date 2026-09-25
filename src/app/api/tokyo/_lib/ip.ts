// 連打の間隔（20 秒）に使う呼び手の鍵。IP そのものは保存しない（sha256 の先頭 16 桁だけ）。
// 既存の client-ip（src/lib/api）は設定のモジュールを連れてきて env 名が増えるので使わない（W01）。
// Vercel では x-vercel-forwarded-for をプラットフォームが上書きする。無ければ全員が1つの鍵を共有する
// （締める側に倒れる）。この間隔は関門に数えない。本当の関門は1日の上限と残高の床。
import { createHash } from "node:crypto";

export function callerKey(request: Request): string {
  const raw = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}
