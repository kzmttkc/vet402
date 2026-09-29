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
//   - 書く: まだ別名の無い出品の別名を作って入れる（catalog-sync が毎回上限つきで・backfill は全部）
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

/** catalog-sync 1 回で別名を作る出品の上限（残りは次の回か backfill）。 */
export const ALIAS_SYNC_MAX_RESOURCES = 3000;
const INSERT_CHUNK = 1000;

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

export type AliasBackfillResult = { resources: number; aliases: number; skipped: number; missingTable: boolean };

/**
 * まだ別名が 1 行も無い resource_id の出品について別名を作って入れる（最大 maxResources 行の出品）。
 * 別名の行は不変なので ON CONFLICT DO NOTHING。
 */
export async function backfillResourceAliases(db: Db, maxResources: number): Promise<AliasBackfillResult> {
  const result: AliasBackfillResult = { resources: 0, aliases: 0, skipped: 0, missingTable: false };
  try {
    const sources = rowsOf<AliasSource>(
      await db.execute(sql`
        SELECT e.resource_id, e.method, e.resource_url FROM x402_endpoints e
        WHERE e.resource_id IS NOT NULL AND e.canonical_url IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM x402_resource_aliases a WHERE a.resource_id = e.resource_id)
        ORDER BY e.resource_id
        LIMIT ${Math.max(1, Math.floor(maxResources))}
      `),
    );
    const { rows, skipped } = aliasRowsFor(sources);
    result.resources = sources.length;
    result.skipped = skipped;
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await db.insert(x402ResourceAliases).values(rows.slice(i, i + INSERT_CHUNK)).onConflictDoNothing();
    }
    result.aliases = rows.length;
    return result;
  } catch (error) {
    if (isMissingSchemaError(error)) return { ...result, missingTable: true };
    throw error;
  }
}
