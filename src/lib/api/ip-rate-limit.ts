import { sql } from "drizzle-orm";
import { isProduction } from "@/lib/config/env";
import { getDb } from "@/lib/db/client";
import { ipRateLimits } from "@/lib/db/schema";
import { logServerErrorSafe } from "@/lib/util/log-safe";
import { ipCounterKey } from "@/lib/decision/lookup-caller";

type Bucket = { count: number; resetAt: number };

const memoryBuckets = new Map<string, Bucket>();

// 2026-08-06 security (self-audit item 1): the key-less public paths
// (/api/v1/payees/verify, /api/badge/:address, /api/demo/score) previously
// either had no limit or returned a bare 429. A limiter the client cannot
// see is invisible to well-behaved integrators and useless as a documented
// contract, so the result now always carries enough to emit standard
// RateLimit-* headers — the caller learns the ceiling, what is left, and
// when the window resets, on EVERY response, not just the throttled one.
export type IpRateLimitResult = {
  allowed: boolean;
  /** Ceiling for this window. */
  limit: number;
  /** Requests still available in this window (0 when throttled). */
  remaining: number;
  /** Unix epoch seconds when the current window resets. */
  resetAt: number;
  /** Seconds until reset — only meaningful (and set) when throttled. */
  retryAfter?: number;
  /**
   * 2026-09-29 監査4周目（障害対応）: 共有の枠ストア（DB）に届かず、判定できなかったので
   * 拒否した。呼び手は「使いすぎ」（429）ではなく「いま答えられない」（503）として返せる。
   * 立っていなくても `allowed:false` なので、見ない呼び手も fail-closed のまま。
   */
  unavailable?: true;
};

/** DB 不通で fail-closed にしたときの Retry-After。窓の長さ（日次なら 1 日）ではなく短く——直ればすぐ戻れる。 */
export const IP_RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SEC = 30;

function unavailableResult(limit: number): IpRateLimitResult {
  const retryAfter = IP_RATE_LIMIT_UNAVAILABLE_RETRY_AFTER_SEC;
  return {
    allowed: false,
    limit,
    remaining: 0,
    resetAt: Math.ceil(Date.now() / 1000) + retryAfter,
    retryAfter,
    unavailable: true,
  };
}

/**
 * 枠の鍵の IP 部分を数える単位に丸める（2026-09-29 監査 6 周目・低）。鍵は呼び手が `用途:${ip}` で作る。
 * IPv6 は /64（1 回線に /64 が配られ、下位 64 bit は利用者が自由に回せる——丸めないと 1 人が無数の枠を持つ）、
 * IPv4 射影（::ffff:1.2.3.4）は IPv4。規則は /decision の問い合わせの数え方（lookup-caller.ts ipCounterKey）と共用。
 * IP でない部分（日付・ウォレット・agent id）と `:` の無い鍵はそのまま。
 */
export function ipBucketKey(key: string): string {
  const i = key.indexOf(":");
  if (i <= 0) return key;
  const rest = key.slice(i + 1);
  if (!rest.includes(":")) return key;
  const rounded = ipCounterKey(rest);
  if (rounded.endsWith("::/64") || /^\d{1,3}(\.\d{1,3}){3}$/.test(rounded)) return `${key.slice(0, i)}:${rounded}`;
  return key;
}

export async function consumeIpRateLimit(
  rawKey: string,
  limit: number,
  windowMs: number,
): Promise<IpRateLimitResult> {
  const key = ipBucketKey(rawKey);
  const db = getDb();
  if (db) {
    // 2026-09-29 監査4周目（重要度・高）: `getDb()` は DATABASE_URL があれば常に値を返す。
    // 下の fail-closed 分岐は「DB が設定されていない」ときにしか通らず、DB が**不通**の
    // ときは例外がそのまま投げられて、全ての鍵なし経路（health・resolve・decision・/rwa）が
    // 500 で終わっていた。例外を捕まえて fail-closed（拒否＋短い Retry-After＋unavailable）にする。
    // メモリ経路へは落とさない——インスタンスごとの枠は共有の上限にならない（資金ガードの
    // 日次予算もこの関数を通る）。
    try {
      return await consumeDbIpRateLimit(db, key, limit, windowMs);
    } catch (error) {
      logServerErrorSafe("ip_rate_limit.consume_unavailable", error);
      return unavailableResult(limit);
    }
  }

  if (isProduction()) {
    // Fail closed in production when the shared store is unreachable: better
    // to throttle everyone than to silently drop the only abuse barrier on a
    // key-less endpoint. Still emit a coherent window so headers stay valid.
    const resetAt = Math.ceil((Date.now() + windowMs) / 1000);
    return { allowed: false, limit, remaining: 0, resetAt, retryAfter: Math.ceil(windowMs / 1000) };
  }

  return consumeMemoryIpRateLimit(key, limit, windowMs);
}

async function consumeDbIpRateLimit(
  db: NonNullable<ReturnType<typeof getDb>>,
  key: string,
  limit: number,
  windowMs: number,
): Promise<IpRateLimitResult> {
  const now = new Date();
  const resetAt = new Date(now.getTime() + windowMs);
  const nowIso = now.toISOString();
  const resetAtIso = resetAt.toISOString();

  const updated = await db
    .insert(ipRateLimits)
    .values({ bucketKey: key, count: 1, resetAt })
    .onConflictDoUpdate({
      target: ipRateLimits.bucketKey,
      set: {
        count: sql`CASE WHEN ${ipRateLimits.resetAt} <= ${nowIso} THEN 1 ELSE ${ipRateLimits.count} + 1 END`,
        resetAt: sql`CASE WHEN ${ipRateLimits.resetAt} <= ${nowIso} THEN ${resetAtIso} ELSE ${ipRateLimits.resetAt} END`,
      },
    })
    .returning();

  const row = updated[0];
  if (!row) {
    return { allowed: true, limit, remaining: limit - 1, resetAt: Math.ceil(resetAt.getTime() / 1000) };
  }

  const windowResetSec = Math.ceil(row.resetAt.getTime() / 1000);
  const remaining = Math.max(0, limit - row.count);

  if (row.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((row.resetAt.getTime() - Date.now()) / 1000));
    return { allowed: false, limit, remaining: 0, resetAt: windowResetSec, retryAfter };
  }

  return { allowed: true, limit, remaining, resetAt: windowResetSec };
}

function consumeMemoryIpRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): IpRateLimitResult {
  const now = Date.now();
  const bucket = memoryBuckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    const resetAt = now + windowMs;
    memoryBuckets.set(key, { count: 1, resetAt });
    const resetSec = Math.ceil(resetAt / 1000);
    // 2026-08-22 監査: ここが窓の1本目を **limit を見ずに** 通していた。
    // DB経路は `row.count > limit` で判定するので limit=0（「今日は1件も
    // 許さない」= デモ専用サブ予算のゼロ設定）を正しく拒否するのに、
    // メモリ経路だけ1本すり抜ける。判定を両経路で「消費後の count が
    // limit 以下か」に揃える——資金ガードの分岐が実行環境で変わってはいけない。
    if (1 > limit) {
      return {
        allowed: false,
        limit,
        remaining: 0,
        resetAt: resetSec,
        retryAfter: Math.max(1, Math.ceil(windowMs / 1000)),
      };
    }
    return { allowed: true, limit, remaining: limit - 1, resetAt: resetSec };
  }

  const resetSec = Math.ceil(bucket.resetAt / 1000);
  if (bucket.count >= limit) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      resetAt: resetSec,
      retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.count += 1;
  return { allowed: true, limit, remaining: Math.max(0, limit - bucket.count), resetAt: resetSec };
}

/**
 * 予約したトークンを 1 つ返す（2026-09-04 監査 B・P2）。
 *
 * demo/verify の日次デモ予算は runL1Batch の**前**に consumeIpRateLimit で取る（原子的な
 * 上限のため正しい）。だが購入が成立しなかったときにも減ったままだった。予約→不成立なら
 * 返金、で「実購入が成立した時だけ計上」にする。窓が既に切り替わっていれば触らない
 * （新しい窓の他人の分を減らさない）。best-effort: 失敗しても投げない。
 */
export async function refundIpRateLimit(rawKey: string): Promise<void> {
  const key = ipBucketKey(rawKey);
  const db = getDb();
  if (db) {
    try {
      await db.execute(sql`
        UPDATE ip_rate_limits
        SET count = GREATEST(count - 1, 0)
        WHERE bucket_key = ${key} AND reset_at > ${new Date().toISOString()}
      `);
    } catch (error) {
      logServerErrorSafe("ip_rate_limit.refund", error);
    }
    return;
  }
  const bucket = memoryBuckets.get(key);
  if (bucket && bucket.resetAt > Date.now() && bucket.count > 0) bucket.count -= 1;
}

// Standard, client-visible rate-limit headers for the key-less paths. Uses the
// IETF draft `RateLimit-*` names (distinct from the authenticated path's
// `X-RateLimit-*` in rate-limit.ts, which reports monthly plan usage rather
// than a short IP window). `Retry-After` is only added on a throttle.
export function ipRateLimitHeaders(result: IpRateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(result.limit),
    "RateLimit-Remaining": String(result.remaining),
    "RateLimit-Reset": String(result.resetAt),
  };
  if (!result.allowed && result.retryAfter !== undefined) {
    headers["Retry-After"] = String(result.retryAfter);
  }
  return headers;
}

/**
 * The subset that stays true on a response the shared CDN cache may replay to
 * a DIFFERENT caller.
 *
 * 2026-08-13, found by measuring the deploy rather than the code: /accuracy and
 * /api/demo/score answer most traffic from the edge with `s-maxage`, so the
 * `RateLimit-Remaining: 9` baked into that cached response is whoever's request
 * populated the cache — eleven requests later it still said 9, because the
 * function was never reached. A per-caller counter served to other callers is a
 * number that means something other than what it appears to mean, which is the
 * exact defect class this endpoint exists to avoid.
 *
 * `RateLimit-Limit` is a constant of the endpoint and is true for everyone, so
 * it stays. `Remaining`/`Reset` are per-caller and are emitted only on
 * responses the CDN does not share — chiefly the `429`, which also carries
 * `Retry-After` and is where a caller actually needs the numbers.
 */
export function sharedCacheRateLimitHeaders(result: IpRateLimitResult): Record<string, string> {
  return { "RateLimit-Limit": String(result.limit) };
}

export { getClientIp } from "@/lib/api/client-ip";
