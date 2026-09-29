// ============================================================
// cron のリースを「取れたと確かめられたときだけ走る」側で取る（2026-09-29 会計監査 7 周目・低）。
//
// lease.ts の acquireLease は、取得の文が例外を投げると `{ acquired: true }` を返す（可用性優先の設計）。
// DB が一時的に不安定なときに、2 本の起動が両方「取れた」と読んで同時に走れる——l1-purchase なら同じ
// エンドポイントへの重複購入・孤児 in_flight の増減が戻る。lease.ts は凍結中なので、呼び手の側で倒し方を変える。
//
// acquireLease を呼んだ後に表を読み直す形（初版）は、自分の取得が例外で終わった後に別の起動が取った行を
// 自分のものと数えて走れた（独立レビューの警告・テスト DB で再現）。持ち主を名指せないのが原因なので、
// ここでは lease.ts と同じ 1 文の upsert（同じ job_leases・同じ期限の規則）を自分で打ち、起動ごとの holder（uuid）が
// RETURNING に返ったときだけ取れた扱いにする。
//   - RETURNING が自分の holder             → acquired（release は自分の holder の行だけ消す）
//   - 行が返らない（期限内の他者が保持中）   → held
//   - 例外（表が無い・DB 不通・その他）       → unverified（走らない）
// DB の無い環境（ローカルのユニットテスト）は lease.ts と同じく取れた扱い（排他する相手の DB が無い）。
// ============================================================
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { logServerErrorSafe } from "@/lib/util/log-safe";

export type FailClosedLease =
  | { acquired: true; release: () => Promise<void> }
  /** held = 誰かが保持中（従来の acquired: false）。unverified = 取れたと確かめられなかった（DB の障害など）。 */
  | { acquired: false; reason: "held" | "unverified" };

function rowsOf<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as T[];
}

export async function acquireLeaseFailClosed(name: string, ttlSeconds: number): Promise<FailClosedLease> {
  const db = getDb();
  if (!db) return { acquired: true, release: async () => {} };

  const holder = randomUUID();
  let rows: { holder: unknown }[];
  try {
    rows = rowsOf<{ holder: unknown }>(
      await db.execute(sql`
        INSERT INTO job_leases (name, holder, acquired_at, expires_at)
        VALUES (${name}, ${holder}::uuid, now(), now() + make_interval(secs => ${ttlSeconds}::int))
        ON CONFLICT (name) DO UPDATE
          SET holder = EXCLUDED.holder,
              acquired_at = EXCLUDED.acquired_at,
              expires_at = EXCLUDED.expires_at
          WHERE job_leases.expires_at <= now()
        RETURNING holder::text AS holder`),
    );
  } catch (error) {
    logServerErrorSafe(`cron.lease.fail_closed.${name}`, error);
    return { acquired: false, reason: "unverified" };
  }
  // 行が返らない = ON CONFLICT の WHERE が false = 期限内の他者が保持中。
  if (rows.length === 0) return { acquired: false, reason: "held" };
  if (rows.length !== 1 || String(rows[0].holder).toLowerCase() !== holder) {
    logServerErrorSafe(`cron.lease.fail_closed.${name}`, "the lease upsert returned a holder that is not ours; not running");
    return { acquired: false, reason: "unverified" };
  }
  return {
    acquired: true,
    release: async () => {
      try {
        // 自分のリースだけ解放する。期限切れ後に他者が取り直していたら触らない。
        await db.execute(sql`DELETE FROM job_leases WHERE name = ${name} AND holder = ${holder}::uuid`);
      } catch (error) {
        // 解放できなくても期限で切れる。黙って消さない。
        logServerErrorSafe(`cron.lease.fail_closed.${name}.release`, error);
      }
    },
  };
}
