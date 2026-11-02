// ============================================================
// /api/tokyo の鍵なしの入口の IP ごとの枠（2026-11-02 監査 M2）。
//
// 他のルートの publicRateLimit（@/lib/api/ip-rate-limit・client-ip）はここで使わない。W01 が、
// 署名の鍵を持つ経路の読む env を4本に固定しているため（client-ip は設定のモジュールを連れてくる）。
// 同じ表 ip_rate_limits を、同じ規則（窓が切れていれば数え直す・1文の upsert）で数える。
// 古い行は log-retention の cron が reset_at で掃く。IP は保存しない（ip.ts の callerNetworkKey）。
// DATABASE_URL が無いとき（手元とテスト）はプロセス内の桶で数える。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { rowsOf } from "./halt";
import { callerNetworkKey } from "./ip";

export type TokyoRateRule = { bucket: string; limit: number };

const WINDOW_SECONDS = 60;

/** 1 分あたり。共有の会場の回線でも審査員を締め出さない数にする。 */
export const TOKYO_LIMITS = {
  verify: { bucket: "tokyo-rl-verify", limit: 30 },
  state: { bucket: "tokyo-rl-state", limit: 60 },
  reset: { bucket: "tokyo-rl-reset", limit: 30 },
  seller: { bucket: "tokyo-rl-seller", limit: 30 },
} as const satisfies Record<string, TokyoRateRule>;

const memory = new Map<string, { count: number; resetAt: number }>();

export function __resetTokyoRateLimitForTests(): void {
  memory.clear();
}

function countInMemory(key: string): number {
  const now = Date.now();
  const b = memory.get(key);
  if (!b || b.resetAt <= now) {
    memory.set(key, { count: 1, resetAt: now + WINDOW_SECONDS * 1000 });
    return 1;
  }
  b.count += 1;
  return b.count;
}

async function count(key: string): Promise<number> {
  const db = getDb();
  if (!db) return countInMemory(key);
  const raw = await db.execute(sql`
    INSERT INTO ip_rate_limits (bucket_key, count, reset_at)
    VALUES (${key}, 1, now() + make_interval(secs => ${WINDOW_SECONDS}::int))
    ON CONFLICT (bucket_key) DO UPDATE SET
      count = CASE WHEN ip_rate_limits.reset_at <= now() THEN 1 ELSE ip_rate_limits.count + 1 END,
      reset_at = CASE WHEN ip_rate_limits.reset_at <= now() THEN now() + make_interval(secs => ${WINDOW_SECONDS}::int) ELSE ip_rate_limits.reset_at END
    RETURNING count
  `);
  return Number(rowsOf(raw)[0]?.count ?? 1);
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

/**
 * 枠の内なら null、超えたら返す応答。表に届かないときは onStoreDown で決める:
 * refuse は 503（他の鍵なしルートと同じ）、allow は通す（state / reset は、この表が読めないときに
 * 押せない理由の1行を自分で返すので、ここで先に閉じない）。
 */
export async function tokyoRateLimit(
  request: Request,
  rule: TokyoRateRule,
  onStoreDown: "refuse" | "allow" = "refuse",
): Promise<Response | null> {
  let used: number;
  try {
    used = await count(`${rule.bucket}:${callerNetworkKey(request)}`);
  } catch {
    if (onStoreDown === "allow") return null;
    return Response.json({ error: "temporarily_unavailable" }, { status: 503, headers: { ...NO_STORE, "Retry-After": "30" } });
  }
  if (used <= rule.limit) return null;
  return Response.json(
    { error: "rate_limited" },
    { status: 429, headers: { ...NO_STORE, "Retry-After": String(WINDOW_SECONDS), "RateLimit-Limit": String(rule.limit), "RateLimit-Remaining": "0" } },
  );
}
