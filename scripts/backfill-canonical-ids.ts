#!/usr/bin/env -S npx tsx
// ============================================================
// §5 canonical ID の backfill（2026-09-02）。
//
// catalog-sync は次回同期から算出するが、delisted 行や同期前の行は NULL のまま
// 残る。resource_id が NULL の行を 500 件ずつ読み、1 文の UPDATE … FROM (VALUES …)
// で埋める（neon-http は複文トランザクションを持てない。1 行 1 文だと本番 21,050 行で
// 10 分を超えたので、チャンクごとに 1 文にまとめる）。冪等。
//
// Usage: DATABASE_URL=... npx tsx scripts/backfill-canonical-ids.ts [--dry-run]
// ============================================================
import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { canonicalUrl, endpointHash, payeeId, resourceId } from "@/lib/ids/canonical";

type Row = { id: string; resource_url: string; method: string | null; network: string | null; pay_to: string | null };

const CHUNK = 500;

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
      LIMIT ${CHUNK}
    `);
    const rows = (Array.isArray(raw) ? raw : (raw as { rows?: unknown[] }).rows ?? []) as Row[];
    if (rows.length === 0) break;
    const values = rows.map((r) => {
      const c = canonicalUrl(r.resource_url);
      return sql`(${r.id}::uuid, ${c?.url ?? null}, ${resourceId(r.method ?? "GET", r.resource_url)}, ${endpointHash(r.resource_url)},
                  ${r.pay_to && r.network ? payeeId(r.network, r.pay_to) : null}, ${c ? JSON.stringify(c.undeclaredQuery) : null}::jsonb)`;
    });
    if (!dryRun) {
      await db.execute(sql`
        UPDATE x402_endpoints AS e
        SET canonical_url = v.canonical_url,
            resource_id = v.resource_id,
            endpoint_hash = v.endpoint_hash,
            payee_id = v.payee_id,
            undeclared_query = v.undeclared_query
        FROM (VALUES ${sql.join(values, sql`, `)}) AS v(id, canonical_url, resource_id, endpoint_hash, payee_id, undeclared_query)
        WHERE e.id = v.id AND e.resource_id IS NULL
      `);
    }
    total += rows.length;
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
