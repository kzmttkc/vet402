// /sellers の 3 頁で共有する IP ごとの上限（鍵なしの公開面）。既存の consumeIpRateLimit を使う。
// 窓は 1 分・30 回。頁の本体は cached.ts の Data Cache から読むので、上限は DB を守るための線。
import { headers } from "next/headers";
import { getClientIp } from "@/lib/api/client-ip";
import { consumeIpRateLimit } from "@/lib/api/ip-rate-limit";

export const SELLERS_RL_LIMIT = 30;
export const SELLERS_RL_WINDOW_MS = 60_000;

/** 通ってよければ null、上限なら待つ秒数。 */
export async function sellersRateLimit(): Promise<number | null> {
  const ip = getClientIp(new Request("http://localhost", { headers: await headers() })) ?? "unknown";
  const limited = await consumeIpRateLimit(`sellers-page:${ip}`, SELLERS_RL_LIMIT, SELLERS_RL_WINDOW_MS);
  return limited.allowed ? null : (limited.retryAfter ?? 60);
}
