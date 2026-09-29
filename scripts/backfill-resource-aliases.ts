/**
 * x402_resource_aliases を全出品について埋める（2026-09-29 監査 7 周目・高）。
 * catalog-sync は 1 回 3,000 出品までしか作らないので、DDL の直後に 1 回これを打つ。
 *
 * 既定は dry run（数えるだけ・書かない）。--apply で書く。表が無ければ（DDL 前）書かずに非ゼロで終わる。
 * 別名の行は不変なので何度打っても同じ（ON CONFLICT DO NOTHING・別名の無い出品だけを拾う）。
 *
 * Usage:
 *   tsx scripts/backfill-resource-aliases.ts --dry-run
 *   tsx scripts/backfill-resource-aliases.ts --apply [--batch 5000]
 */
import { sql } from "drizzle-orm";
import { getDb } from "../src/lib/db/client";
import { isMissingSchemaError } from "../src/lib/db/pg-errors";
import { aliasRowsFor, backfillResourceAliases, type AliasSource } from "../src/lib/resolve/aliases";
import { rowsOf } from "../src/lib/settlements/upsert";

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const batchIdx = argv.indexOf("--batch");
  const batch = batchIdx >= 0 ? Math.max(1, Number(argv[batchIdx + 1]) || 5000) : 5000;
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not set");

  if (!apply) {
    try {
      const sources = rowsOf<AliasSource>(
        await db.execute(sql`
          SELECT e.resource_id, e.method, e.resource_url FROM x402_endpoints e
          WHERE e.resource_id IS NOT NULL AND e.canonical_url IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM x402_resource_aliases a WHERE a.resource_id = e.resource_id)`),
      );
      const { rows, skipped } = aliasRowsFor(sources);
      console.log(JSON.stringify({ dryRun: true, resources: sources.length, aliases: rows.length, skipped }));
    } catch (error) {
      if (isMissingSchemaError(error)) {
        console.error("x402_resource_aliases does not exist: apply scripts/sql/2026-09-29-resource-aliases.sql first");
        process.exit(2);
      }
      throw error;
    }
    return;
  }

  const total = { resources: 0, aliases: 0, skipped: 0 };
  for (;;) {
    const r = await backfillResourceAliases(db, batch);
    if (r.missingTable) {
      console.error("x402_resource_aliases does not exist: apply scripts/sql/2026-09-29-resource-aliases.sql first");
      process.exit(2);
    }
    total.resources += r.resources;
    total.aliases += r.aliases;
    total.skipped += r.skipped;
    // 取った出品が全部 skipped（今の規則で id が作り直せない）だと、同じ行を取り続ける。1 周で止める。
    if (r.resources < batch || r.aliases === 0) break;
  }
  console.log(JSON.stringify({ applied: true, ...total }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
