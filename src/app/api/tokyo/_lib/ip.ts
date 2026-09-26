// 連打の間隔（20 秒）と IP ごとの1日の上限に使う呼び手の鍵。IP そのものは保存しない（sha256 の先頭 16 桁だけ）。
// 既存の client-ip（src/lib/api）は設定のモジュールを連れてきて env 名が増えるので使わない（W01）。
// Vercel では x-vercel-forwarded-for をプラットフォームが上書きする。無ければ全員が1つの鍵を共有する
// （締める側に倒れる。ヘッダの無い呼び手が何人いても、合わせて IP 1つぶんしか押せない。
// 本番の Vercel では必ず付くので、無いのは Vercel の外から来た要求だけ）。
// 間隔は関門に数えない。本当の関門は1日の上限（全体と IP ごと）と残高の床。
import { createHash } from "node:crypto";

export function callerKey(request: Request): string {
  const raw = request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}
