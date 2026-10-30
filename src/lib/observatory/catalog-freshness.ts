// ============================================================
// CDP Bazaar の取り込みの鮮度（2026-10-30 設計 v5 の 4・docs/catalog-staleness-contract.md 4.4 / 4.5）。
//
// 見張り（catalog-cursor.ts の checkCatalogPassFreshness）と公開の鮮度の欄（reader.ts の
// getCdpBazaarIngestFreshness）が同じ規則で判定するための小さな部品。重い同期のモジュールを引かない。
//
// 規則: 最後に閉じた **強い** 周回（x402_catalog_cursors.last_strong_pass_completed_at）から 36 時間たったら古い。
// 強い周回が一度も無いときは、カーソルの行ができた時刻（created_at）から 36 時間で古い。行が無ければ古くない
// （カーソルがまだ一度も動いていない環境）。行の max(last_seen_at) では判定しない（弱い周回だけが続いても行は見え続ける）。
// ============================================================
import { sql } from "drizzle-orm";
import type { getDb } from "@/lib/db/client";
import { CATALOG_SOURCE } from "./catalog-source";

/** 強い周回がこの時間閉じていなければ「古い」。 */
export const PASS_STALE_ALERT_HOURS = 36;

export type PassFreshness = { lastStrongPassCompletedAt: Date | null; stale: boolean };

type Db = NonNullable<ReturnType<typeof getDb>>;

function rowsOf<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

function asDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 純粋な判定。 */
export function passFreshnessOf(input: { lastStrongPassCompletedAt: Date | null; cursorCreatedAt: Date | null; now: Date }): PassFreshness {
  const limitMs = PASS_STALE_ALERT_HOURS * 3_600_000;
  const since = input.lastStrongPassCompletedAt ?? input.cursorCreatedAt;
  const stale = since !== null && input.now.getTime() - since.getTime() >= limitMs;
  return { lastStrongPassCompletedAt: input.lastStrongPassCompletedAt, stale };
}

/** カーソルの行を読んで判定する（ログは出さない）。 */
export async function readCdpPassFreshness(db: Db, now: Date): Promise<PassFreshness> {
  const rows = rowsOf<{ last_strong: unknown; created_at: unknown }>(
    await db.execute(sql`
      SELECT last_strong_pass_completed_at AS last_strong, created_at
      FROM x402_catalog_cursors WHERE source = ${CATALOG_SOURCE}`),
  );
  const row = rows[0];
  return passFreshnessOf({
    lastStrongPassCompletedAt: asDate(row?.last_strong),
    cursorCreatedAt: asDate(row?.created_at),
    now,
  });
}
