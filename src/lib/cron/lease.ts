// ============================================================
// cron バッチの排他（2026-08-24 監査）。
//
// なぜ要るか: l1-purchase は実資金を動かすのにバッチ全体の排他が無かった。
// 予約 SQL (reserveSpend) が単一文で原子的なので**日次上限そのものは破れない**が、
// 二重起動すると孤児 in_flight の増減・summary の混乱・同じエンドポイントへの
// 重複購入が起きる。Vercel cron の重複発火は実在し得るし、手動トリガと定時が
// 重なることもある（デモ日に一番困る形）。
//
// advisory lock は使えない: neon-http はステートレスなHTTPで、セッションレベルの
// ロックが文をまたいで保たれない。reserveSpend を単一文にしたのと同じ制約なので、
// 同じ手を使う——**期限付きリースを1文の upsert で取る**。読んでから書かないので
// TOCTOU が無い。
//
// 期限を切ってあるのは、関数がプラットフォームに殺されたときリースが永久に
// 残らないようにするため。ロックを取れないより、少し遅れて取れる方が安全。
// ============================================================
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { logServerError } from "@/lib/util/log";

export type Lease = { acquired: true; release: () => Promise<void> } | { acquired: false };

/**
 * 名前付きリースを取る。取れなければ `{ acquired: false }`。
 *
 * @param ttlSeconds 保持期限。実行の maxDuration より少しだけ長くする——
 *   短いと走行中に別の起動へ奪われ、長いと殺された後の再開が遅れる。
 */
export async function acquireLease(name: string, ttlSeconds: number): Promise<Lease> {
  const db = getDb();
  if (!db) {
    // DB が無い環境（ローカルのユニットテスト等）は排他の対象外。
    // ここで false を返すと本番以外で全部止まるので、取れた扱いにする。
    return { acquired: true, release: async () => {} };
  }
  const holder = randomUUID();
  try {
    const raw = await db.execute(sql`
      INSERT INTO job_leases (name, holder, acquired_at, expires_at)
      VALUES (${name}, ${holder}::uuid, now(), now() + make_interval(secs => ${ttlSeconds}::int))
      ON CONFLICT (name) DO UPDATE
        SET holder = EXCLUDED.holder,
            acquired_at = EXCLUDED.acquired_at,
            expires_at = EXCLUDED.expires_at
        WHERE job_leases.expires_at <= now()
      RETURNING holder::text AS holder
    `);
    const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as {
      holder: string;
    }[];
    // 行が返らない = ON CONFLICT の WHERE が false = 誰かが保持中。
    if (rows.length === 0 || rows[0]?.holder !== holder) return { acquired: false };

    return {
      acquired: true,
      release: async () => {
        try {
          // 自分のリースだけ解放する。期限切れ後に他者が取り直していたら触らない。
          await db.execute(sql`
            DELETE FROM job_leases WHERE name = ${name} AND holder = ${holder}::uuid
          `);
        } catch (error) {
          // 解放できなくても期限で切れる。黙って消さない。
          logServerError("cron.lease.release", error);
        }
      },
    };
  } catch (error) {
    // リース表がまだ無い等で取得できないとき、バッチ全体を止めるかは判断が要る。
    // ここは**通す**: 排他は二重起動という運用事故への保険であって、正しさの
    // ゲートではない（正しさは reserveSpend の原子予約が持っている）。
    // 保険が張れないことを理由に日次の観測を止める方が損失が大きい。
    logServerError("cron.lease.acquire", error);
    return { acquired: true, release: async () => {} };
  }
}
