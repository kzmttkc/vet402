/**
 * x402_resource_aliases を全出品について埋める（2026-09-29 監査 7 周目・高）。
 * catalog-sync は新規・URL が変わった掲載の別名しか作らないので、DDL の直後と、揺れの規則
 * （src/lib/ids/canonical.ts resourceUrlVariants）を変えたあとに 1 回これを打つ。
 *
 * 全出品を id 順に読み、各出品の別名を全部作って足りない行だけを入れる（ON CONFLICT DO NOTHING）。
 * 既にある出品を飛ばさないので、何度流しても欠けが埋まる。1 文 = 1 トランザクションで、出品の別名は
 * 同じ文に入る（途中で落ちても出品単位で全部か無しか）。
 *
 * 既定は dry run（数えるだけ・書かない）。--apply で書く。表が無ければ（DDL 前）書かずに非ゼロで終わる。
 *
 * Usage:
 *   tsx scripts/backfill-resource-aliases.ts --dry-run
 *   tsx scripts/backfill-resource-aliases.ts --apply [--batch 2000]
 */
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db/client";
import { isMissingSchemaError } from "../src/lib/db/pg-errors";
import { aliasRowsFor, backfillResourceAliases, type AliasSource } from "../src/lib/resolve/aliases";
import { rowsOf } from "../src/lib/settlements/upsert";

const MISSING = "x402_resource_aliases does not exist: apply scripts/sql/2026-09-29-resource-aliases.sql first";

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const batchIdx = argv.indexOf("--batch");
  const batch = batchIdx >= 0 ? Math.max(1, Number(argv[batchIdx + 1]) || 2000) : 2000;
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not set");

  if (!apply) {
    try {
      const sources = rowsOf<AliasSource>(
        await db.execute(sql`
          SELECT resource_id, method, resource_url FROM x402_endpoints
          WHERE resource_id IS NOT NULL AND canonical_url IS NOT NULL`),
      );
      const { rows, skipped } = aliasRowsFor(sources);
      const have = rowsOf<{ n: number }>(await db.execute(sql`SELECT count(*)::int AS n FROM x402_resource_aliases`))[0]?.n ?? 0;
      console.log(JSON.stringify({ dryRun: true, resources: sources.length, aliasesWanted: rows.length, aliasesInTable: Number(have), skipped }));
    } catch (error) {
      if (isMissingSchemaError(error)) {
        console.error(MISSING);
        process.exit(2);
      }
      throw error;
    }
    return;
  }

  const r = await backfillResourceAliases(db, batch, (b, lastId) =>
    console.error(`batch: resources ${b.resources}, inserted ${b.inserted} (through ${lastId})`),
  );
  if (r.missingTable) {
    console.error(MISSING);
    process.exit(2);
  }
  console.log(JSON.stringify({ applied: true, ...r }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
