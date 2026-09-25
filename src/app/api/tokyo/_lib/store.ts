// ============================================================
// 審査員ボタンの DB（tokyo_mutations・tokyo_mutation_log・既存の ip_rate_limits）。
// どれも1文で読み書きする（neon-http はセッションを持たない。lease.ts と同じ制約）。
// 押した人は記録しない（IP も鍵も入れない）。間隔の鍵は IP の sha256 の先頭だけ。
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { AMOUNT, REVERT_CLAIM_SECONDS } from "./constants";
import { rowsOf } from "./halt";
import type { LogRow, MutationRow, MutationStore } from "./types";

type Db = NonNullable<ReturnType<typeof getDb>>;

export class StoreUnavailable extends Error {}

function need(): Db {
  const db = getDb();
  if (!db) throw new StoreUnavailable("DATABASE_URL is not configured");
  return db;
}

const toDate = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

export function dbStore(): MutationStore {
  return {
    async ensureRow() {
      await need().execute(sql`
        INSERT INTO tokyo_mutations (id, current_value) VALUES (1, ${AMOUNT.off})
        ON CONFLICT (id) DO NOTHING
      `);
    },

    async readRow(): Promise<MutationRow> {
      const raw = await need().execute(sql`
        SELECT current_value, generation, mutated_at, reverting_until, last_tx
        FROM tokyo_mutations WHERE id = 1
      `);
      const r = rowsOf(raw)[0];
      if (!r) return { currentValue: AMOUNT.off, generation: 0, mutatedAt: null, revertingUntil: null, lastTx: null };
      return {
        currentValue: String(r.current_value),
        generation: Number(r.generation),
        mutatedAt: toDate(r.mutated_at),
        revertingUntil: toDate(r.reverting_until),
        lastTx: typeof r.last_tx === "string" ? r.last_tx : null,
      };
    },

    async claimRevert() {
      const raw = await need().execute(sql`
        UPDATE tokyo_mutations
          SET reverting_until = now() + make_interval(secs => ${REVERT_CLAIM_SECONDS}::int),
              generation = generation + 1
        WHERE id = 1 AND (reverting_until IS NULL OR reverting_until < now())
        RETURNING generation
      `);
      const r = rowsOf(raw)[0];
      return r ? Number(r.generation) : null;
    },

    async finishRevert(generation, tx) {
      const raw = await need().execute(sql`
        UPDATE tokyo_mutations
          SET current_value = ${AMOUNT.off}, reverting_until = NULL, last_tx = ${tx}
        WHERE id = 1 AND generation = ${generation}
        RETURNING id
      `);
      return rowsOf(raw).length > 0;
    },

    async releaseClaim(generation) {
      await need().execute(sql`
        UPDATE tokyo_mutations SET reverting_until = NULL WHERE id = 1 AND generation = ${generation}
      `);
    },

    async markClean(generation) {
      await need().execute(sql`
        UPDATE tokyo_mutations SET current_value = ${AMOUNT.off} WHERE id = 1 AND generation = ${generation}
      `);
    },

    async recordMutation(tx) {
      await need().execute(sql`
        UPDATE tokyo_mutations
          SET current_value = ${AMOUNT.on}, generation = generation + 1, mutated_at = now(),
              reverting_until = NULL, last_tx = ${tx}
        WHERE id = 1
      `);
    },

    async appendLog(from, to, tx) {
      await need().execute(sql`
        INSERT INTO tokyo_mutation_log (from_value, to_value, tx) VALUES (${from}, ${to}, ${tx})
      `);
    },

    async recentLog(limit): Promise<LogRow[]> {
      const raw = await need().execute(sql`
        SELECT at, from_value, to_value, tx FROM tokyo_mutation_log ORDER BY id DESC LIMIT ${limit}
      `);
      return rowsOf(raw).map((r) => ({
        at: toDate(r.at)?.toISOString() ?? String(r.at),
        from: String(r.from_value),
        to: String(r.to_value),
        tx: typeof r.tx === "string" ? r.tx : null,
      }));
    },

    async consumeDaily(key, max, resetAt) {
      // 比較は ON CONFLICT の WHERE の中。読んでから書く2文にしない（同時に押されても上限を越えない）。
      const raw = await need().execute(sql`
        INSERT INTO ip_rate_limits (bucket_key, count, reset_at)
        VALUES (${key}, 1, ${resetAt.toISOString()}::timestamptz)
        ON CONFLICT (bucket_key) DO UPDATE SET count = ip_rate_limits.count + 1
          WHERE ip_rate_limits.count < ${max}
        RETURNING count
      `);
      const r = rowsOf(raw)[0];
      return r ? Number(r.count) : null;
    },

    async peekDaily(key) {
      const raw = await need().execute(sql`SELECT count FROM ip_rate_limits WHERE bucket_key = ${key}`);
      const r = rowsOf(raw)[0];
      return r ? Number(r.count) : 0;
    },

    async consumeInterval(key, windowMs) {
      const secs = Math.max(1, Math.ceil(windowMs / 1000));
      const raw = await need().execute(sql`
        INSERT INTO ip_rate_limits (bucket_key, count, reset_at)
        VALUES (${key}, 1, now() + make_interval(secs => ${secs}::int))
        ON CONFLICT (bucket_key) DO UPDATE SET count = 1, reset_at = now() + make_interval(secs => ${secs}::int)
          WHERE ip_rate_limits.reset_at <= now()
        RETURNING count
      `);
      return rowsOf(raw).length > 0;
    },
  };
}
