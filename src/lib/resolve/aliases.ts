// ============================================================
// resource_id の別名（2026-09-29 監査 7 周目・高）。
//
// なぜ要るか: SDK の payOrRefuse（凍結中）は resource_id を生の URL から sha256("<METHOD> <url>") で
// 作る。サーバの正規化（canonical.ts）を通さないので、`POST https://api.exa.ai/search/` のような
// 表記の揺れで /decision が 404 になり、SDK は「カタログ外」として受取人のスコアで決めていた。
// BLOCK の資源にも署名まで進みうる。
//
// ここは 2 つだけ持つ:
//   - 引く: 別名 → 正規の resource_id（getResource の完全一致が外れたときだけ）
//   - 書く: 出品の別名を全部作り、足りない行だけを入れる（catalog-sync は新規・URL が変わった掲載、backfill は全部）
// 別名の作り方は canonical.ts の resourceIdAliases の 1 箇所。表が無い DB（DDL 前）では
// 引く側は「別名なし」、書く側は missingTable を返す——どちらも従来の挙動に落ちるだけで止まらない。
// ============================================================
import { sql } from "drizzle-orm";
import type { getDb } from "@/lib/db/client";
import { isMissingSchemaError } from "@/lib/db/pg-errors";
import { x402ResourceAliases } from "@/lib/db/schema";
import { resourceId as toResourceId, resourceIdAliases, SHA256_HEX_RE } from "@/lib/ids/canonical";
import { rowsOf } from "@/lib/settlements/upsert";

type Db = NonNullable<ReturnType<typeof getDb>>;

/** 別名から正規の resource_id を引く。無ければ null。表が無い DB でも null（throw しない）。 */
export async function canonicalIdForAlias(db: Db, aliasId: string): Promise<string | null> {
  if (!SHA256_HEX_RE.test(aliasId)) return null;
  try {
    const rows = rowsOf<{ resource_id: string }>(
      await db.execute(sql`SELECT resource_id FROM x402_resource_aliases WHERE alias_id = ${aliasId} LIMIT 1`),
    );
    return rows[0]?.resource_id ?? null;
  } catch (error) {
    if (isMissingSchemaError(error)) return null;
    throw error;
  }
}

export type AliasSource = { resource_id: string; method: string | null; resource_url: string };

/**
 * 出品の行から別名の行を作る。純関数。保存されている resource_id が今の規則で作り直した値と
 * 違う行は作らない（別名を違う資源へ向けない）——数は skipped に返す。
 */
export function aliasRowsFor(rows: AliasSource[]): { rows: { aliasId: string; resourceId: string }[]; skipped: number } {
  const out = new Map<string, string>();
  let skipped = 0;
  for (const r of rows) {
    const method = (r.method ?? "GET").toUpperCase();
    if (toResourceId(method, r.resource_url) !== r.resource_id) {
      skipped++;
      continue;
    }
    for (const a of resourceIdAliases(method, r.resource_url)) if (!out.has(a)) out.set(a, r.resource_id);
  }
  return { rows: [...out].map(([aliasId, resourceId]) => ({ aliasId, resourceId })), skipped };
}

export type AliasWriteResult = { resources: number; aliases: number; inserted: number; skipped: number; missingTable: boolean };

/** 1 文に入れる別名の行の目安。出品の別名は必ず同じ文に入れる（出品の途中で文を切らない）。 */
const ROWS_PER_STATEMENT = 2000;

/**
 * 出品の別名を**全部**作って入れる（足りない行だけが入る・ON CONFLICT DO NOTHING）。
 * 1 文 = 1 トランザクションで、1 つの出品の別名は必ず 1 つの文に収める——途中で落ちても、その出品は
 * 全部入ったか全く入っていないかのどちらか。既にある出品を飛ばさないので、何度流しても欠けが埋まり、
 * 揺れの規則を変えたあとも再実行すれば追いつく。書き手は catalog-sync（新規・URL が変わった掲載）と backfill。
 */
export async function writeResourceAliases(db: Db, sources: AliasSource[]): Promise<AliasWriteResult> {
  const result: AliasWriteResult = { resources: sources.length, aliases: 0, inserted: 0, skipped: 0, missingTable: false };
  let batch: { aliasId: string; resourceId: string }[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const rows = batch;
    batch = [];
    const ins = await db.insert(x402ResourceAliases).values(rows).onConflictDoNothing().returning();
    result.inserted += ins.length;
  };
  try {
    for (const src of sources) {
      const { rows, skipped } = aliasRowsFor([src]);
      result.skipped += skipped;
      result.aliases += rows.length;
      if (batch.length > 0 && batch.length + rows.length > ROWS_PER_STATEMENT) await flush();
      batch.push(...rows);
    }
    await flush();
    return result;
  } catch (error) {
    if (isMissingSchemaError(error)) return { ...result, missingTable: true };
    throw error;
  }
}

/**
 * 全出品を id 順に `batchSize` 件ずつ読み、writeResourceAliases に渡す（backfill）。出品を飛ばさない。
 * `onBatch` は進み具合の表示用。
 */
export async function backfillResourceAliases(
  db: Db,
  batchSize: number,
  onBatch?: (r: AliasWriteResult, lastId: string) => void,
): Promise<AliasWriteResult> {
  const total: AliasWriteResult = { resources: 0, aliases: 0, inserted: 0, skipped: 0, missingTable: false };
  let after = "00000000-0000-0000-0000-000000000000";
  const limit = Math.max(1, Math.floor(batchSize));
  for (;;) {
    const rows = rowsOf<AliasSource & { id: string }>(
      await db.execute(sql`
        SELECT id::text AS id, resource_id, method, resource_url FROM x402_endpoints
        WHERE resource_id IS NOT NULL AND canonical_url IS NOT NULL AND id > ${after}::uuid
        ORDER BY id LIMIT ${limit}
      `),
    );
    if (rows.length === 0) return total;
    const r = await writeResourceAliases(db, rows);
    if (r.missingTable) return { ...total, missingTable: true };
    total.resources += r.resources;
    total.aliases += r.aliases;
    total.inserted += r.inserted;
    total.skipped += r.skipped;
    after = rows[rows.length - 1].id;
    onBatch?.(r, after);
    if (rows.length < limit) return total;
  }
}
