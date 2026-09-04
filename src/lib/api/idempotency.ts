// ============================================================
// Idempotency-Key の応答保存（2026-09-04 監査 B・P2）。
//
// /decision（§9.3）は同一 (APIキー, resource, role, payer, Idempotency-Key) の再送に
// 10 分間レート単位を二重に消費しない、と約束している。従来はプロセス内 Map に
// 「見た」ことだけを覚え、再送は**毎回再計算**していた。Vercel は複数インスタンスなので
// 別インスタンスへ落ちた再送は初回扱いになり、同じキーで違う応答が返り得る。
//
// ip_rate_limits と同じ DB 表 decision_idempotency に応答本体を保存し、再送はそれを
// そのまま返す。書き込みは ip_rate_limits と同じ「読んでから書かない」単一文
// （期限切れの掃除 + INSERT ... ON CONFLICT DO NOTHING を 1 つの CTE で）。
// DB が無い環境（ローカルの単体テスト）はプロセス内 Map で同じ約束を守る。
// 保存も読み出しも best-effort: 失敗しても判定は止めず、理由は logServerError へ。
// ============================================================
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { logServerError } from "@/lib/util/log";

const memory = new Map<string, { body: unknown; expiresAt: number }>();

/** 材料を長さ付きで連結して sha256 にする（"a|b","c" と "a","b|c" が衝突しない）。 */
export function idempotencyKeyHash(parts: string[]): string {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(String(Buffer.byteLength(p, "utf8")));
    h.update(":");
    h.update(p, "utf8");
  }
  return h.digest("hex");
}

function rowsOf(raw: unknown): { body: unknown }[] {
  if (Array.isArray(raw)) return raw as { body: unknown }[];
  return ((raw as { rows?: unknown[] })?.rows ?? []) as { body: unknown }[];
}

/** 期限内の保存応答。無ければ null。DB の失敗も null（理由はログ）。 */
export async function getIdempotentResponse(keyHash: string): Promise<unknown | null> {
  const db = getDb();
  if (!db) {
    const hit = memory.get(keyHash);
    if (hit && hit.expiresAt > Date.now()) return hit.body;
    memory.delete(keyHash);
    return null;
  }
  try {
    const raw = await db.execute(sql`
      SELECT body FROM decision_idempotency
      WHERE key_hash = ${keyHash} AND expires_at > now()
      LIMIT 1
    `);
    const rows = rowsOf(raw);
    return rows.length > 0 ? rows[0].body : null;
  } catch (error) {
    logServerError("idempotency.get", error);
    return null;
  }
}

/** 応答を TTL 付きで保存する。既にあれば触らない（先勝ち）。失敗しても投げない。 */
export async function saveIdempotentResponse(keyHash: string, body: unknown, ttlMs: number): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs);
  const db = getDb();
  if (!db) {
    if (!memory.has(keyHash)) memory.set(keyHash, { body, expiresAt: expiresAt.getTime() });
    if (memory.size > 10_000) {
      const now = Date.now();
      for (const [k, v] of memory) if (v.expiresAt <= now) memory.delete(k);
    }
    return;
  }
  try {
    await db.execute(sql`
      WITH gc AS (DELETE FROM decision_idempotency WHERE expires_at <= now())
      INSERT INTO decision_idempotency (key_hash, body, expires_at)
      VALUES (${keyHash}, ${JSON.stringify(body)}::jsonb, ${expiresAt})
      ON CONFLICT (key_hash) DO NOTHING
    `);
  } catch (error) {
    logServerError("idempotency.save", error);
  }
}
