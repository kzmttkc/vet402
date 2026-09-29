// ============================================================
// cron のリースを「取れたと確かめられたときだけ走る」側で取る（2026-09-29 会計監査 7 周目・低）。
//
// lease.ts の acquireLease は、取得の文が例外を投げると `{ acquired: true }` を返す（可用性優先の設計）。
// DB が一時的に不安定なときに、2 本の起動が両方「取れた」と読んで同時に走れる——l1-purchase なら同じ
// エンドポイントへの重複購入・孤児 in_flight の増減が戻る。lease.ts は凍結中なので、呼び手の側で倒し方を変える。
//
// 手順（どれか 1 つでも読めなければ走らない）:
//   1. DB の now() を読む（t0）。読めなければ止める。
//   2. acquireLease を呼ぶ。acquired: false ならそのまま返す（誰かが保持中）。
//   3. job_leases に「その名前で、t0 以後に取られ、まだ期限の来ていない行」があるかを読む。
//      本当に取れたなら、その upsert の now() は t0 より後なので必ずある。取得の文が例外で「通した」
//      だけなら、行は無い（表が無い・DB 不通）か、t0 より前に他者が取った行しかない——止める。
//      確かめられなかったときは release を呼ぶ（本当に取れていた場合にリースを期限まで握らない。
//      「通した」場合の release は何もしない）。
// DB の無い環境（ローカルのユニットテスト）は acquireLease と同じく取れた扱い（排他する相手の DB が無い）。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { acquireLease, type Lease } from "@/lib/cron/lease";
import { logServerErrorSafe } from "@/lib/util/log-safe";

export type FailClosedLease =
  | { acquired: true; release: () => Promise<void> }
  /** held = 誰かが保持中（従来の acquired: false）。unverified = 取れたと確かめられなかった（DB の障害など）。 */
  | { acquired: false; reason: "held" | "unverified" };

function rowsOf<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as T[];
}

export async function acquireLeaseFailClosed(
  name: string,
  ttlSeconds: number,
  deps: { acquire?: (name: string, ttlSeconds: number) => Promise<Lease> } = {},
): Promise<FailClosedLease> {
  const acquire = deps.acquire ?? acquireLease;
  const db = getDb();
  if (!db) {
    const lease = await acquire(name, ttlSeconds);
    return lease.acquired ? lease : { acquired: false, reason: "held" };
  }

  let t0: string;
  try {
    const raw = await db.execute(sql`SELECT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t0`);
    const v = rowsOf<{ t0: unknown }>(raw)[0]?.t0;
    if (typeof v !== "string") throw new Error("now() returned no value");
    t0 = v;
  } catch (error) {
    logServerErrorSafe(`cron.lease.fail_closed.${name}`, error);
    return { acquired: false, reason: "unverified" };
  }

  const lease = await acquire(name, ttlSeconds);
  if (!lease.acquired) return { acquired: false, reason: "held" };

  try {
    const raw = await db.execute(sql`
      SELECT count(*)::int AS n FROM job_leases
      WHERE name = ${name} AND acquired_at >= ${t0}::timestamptz AND expires_at > now()`);
    const n = rowsOf<{ n: unknown }>(raw)[0]?.n;
    if (Number(n) === 1) return lease;
    logServerErrorSafe(
      `cron.lease.fail_closed.${name}`,
      `acquireLease answered acquired, but no lease row taken at or after ${t0} is live; not running`,
    );
  } catch (error) {
    logServerErrorSafe(`cron.lease.fail_closed.${name}`, error);
  }
  await lease.release();
  return { acquired: false, reason: "unverified" };
}
