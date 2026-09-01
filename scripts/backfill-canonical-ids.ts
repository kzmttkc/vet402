#!/usr/bin/env -S npx tsx
// ============================================================
// §5 canonical ID の backfill（2026-09-02）。
//
// catalog-sync は次回同期から算出するが、delisted 行や同期前の行は NULL のまま
// 残る。resource_id が NULL の行を 500 件ずつ読み、単文 UPDATE で埋める
// （neon-http は複文トランザクションを持てない）。冪等——何度走らせても同じ。
//
// Usage: DATABASE_URL=... npx tsx scripts/backfill-canonical-ids.ts [--dry-run]
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { canonicalUrl, endpointHash, payeeId, resourceId } from "@/lib/ids/canonical";

type Row = { id: string; resource_url: string; method: string | null; network: string | null; pay_to: string | null };

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const db = getDb();
  if (!db) throw new Error("DATABASE_URL is not configured");
  let total = 0;
  for (;;) {
    const raw = await db.execute(sql`
      SELECT id::text AS id, resource_url, method, network, pay_to
      FROM x402_endpoints
      WHERE resource_id IS NULL
      ORDER BY first_seen_at ASC NULLS FIRST
      LIMIT 500
    `);
    const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Row[];
    if (rows.length === 0) break;
    for (const r of rows) {
      const c = canonicalUrl(r.resource_url);
      const ids = {
        canonicalUrl: c?.url ?? null,
        resourceId: resourceId(r.method ?? "GET", r.resource_url),
        endpointHash: endpointHash(r.resource_url),
        payeeId: r.pay_to && r.network ? payeeId(r.network, r.pay_to) : null,
        undeclaredQuery: c ? JSON.stringify(c.undeclaredQuery) : null,
      };
      if (!dryRun) {
        await db.execute(sql`
          UPDATE x402_endpoints
          SET canonical_url = ${ids.canonicalUrl},
              resource_id = ${ids.resourceId},
              endpoint_hash = ${ids.endpointHash},
              payee_id = ${ids.payeeId},
              undeclared_query = ${ids.undeclaredQuery}::jsonb
          WHERE id = ${r.id}::uuid AND resource_id IS NULL
        `);
      }
      total++;
    }
    console.log(`backfilled ${total}${dryRun ? " (dry-run)" : ""}`);
    if (dryRun) break;
  }
  console.log(JSON.stringify({ ok: true, backfilled: total, dryRun }));
}

main()
  .then(() => process.exit(0)) // postgres-js の接続プールがプロセスを生かし続けるので明示的に終える
  .catch((e) => {
    console.error(String(e));
    process.exit(1);
  });
