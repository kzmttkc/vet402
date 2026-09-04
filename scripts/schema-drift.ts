// ============================================================
// npm run db:drift — schema.ts と DATABASE_URL の実 DB を突合する（読み取り専用）。
//
// 2026-09-04 監査 D・P1: 本番には raw SQL で作った job_leases と部分索引があり、
// schema.ts に無かった。`drizzle-kit push` を 1 回叩けば drop される状態が 11 日続いた。
// push の前にこれを走らせ、「DROP」で始まる行が出たら push しない。
//
// 発行するのは pg_catalog / pg_indexes への SELECT だけ。DDL も DML も無い。
// 終了コード: drift 無し 0 / drift あり 1 / 接続不能 2。
// ============================================================
import postgres from "postgres";
import * as schema from "../src/lib/db/schema";
import { diffSchema, expectedFromDrizzle, normalizeType, parseIndexDef, type SchemaShape } from "../src/lib/db/schema-drift";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("schema-drift: DATABASE_URL is not set");
  process.exit(2);
}

// drizzle-kit 自身の管理表。schema.ts に無くて当然なので比較から外す。
const IGNORED_TABLES = new Set(["__drizzle_migrations"]);

async function readActual(sql: postgres.Sql): Promise<SchemaShape> {
  const cols = await sql<{ table: string; column: string; type: string; notnull: boolean; hasdef: boolean }[]>`
    SELECT c.relname AS "table", a.attname AS "column",
           format_type(a.atttypid, a.atttypmod) AS "type",
           a.attnotnull AS "notnull", a.atthasdef AS "hasdef"
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum
  `;
  const idxs = await sql<{ table: string; name: string; def: string }[]>`
    SELECT tablename AS "table", indexname AS "name", indexdef AS "def"
    FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname
  `;
  const pks = await sql<{ table: string; index: string; columns: string[] }[]>`
    SELECT c.relname AS "table", con.conindid::regclass::text AS "index",
           array_agg(a.attname ORDER BY k.ord) AS "columns"
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE con.contype = 'p' AND n.nspname = 'public'
    GROUP BY c.relname, con.conindid
  `;
  const out: SchemaShape = {};
  for (const r of cols) {
    if (IGNORED_TABLES.has(r.table)) continue;
    out[r.table] ??= { columns: {}, indexes: {}, primaryKey: [] };
    out[r.table].columns[r.column] = { type: normalizeType(r.type), notNull: r.notnull, hasDefault: r.hasdef };
  }
  // 主キーを支える索引（単列は *_pkey、複合は drizzle 命名の *_pk）は PRIMARY KEY として別に比べる。
  const pkIndexes = new Set(pks.map((r) => r.index.replace(/^public\./, "").replace(/^"(.*)"$/, "$1")));
  for (const r of idxs) {
    if (!out[r.table]) continue;
    if (pkIndexes.has(r.name)) continue;
    out[r.table].indexes[r.name] = parseIndexDef(r.def);
  }
  for (const r of pks) {
    if (!out[r.table]) continue;
    out[r.table].primaryKey = r.columns;
  }
  return out;
}

async function main() {
  const sql = postgres(url!, { max: 1, connect_timeout: 10 });
  try {
    const [row] = await sql`SELECT current_database() AS db, inet_server_addr()::text AS host`;
    const actual = await readActual(sql);
    const expected = expectedFromDrizzle(schema as Record<string, unknown>);
    const drift = diffSchema(expected, actual);
    console.log(
      `schema-drift: db=${row.db} tables schema=${Object.keys(expected).length} db=${Object.keys(actual).length}`,
    );
    if (drift.length === 0) {
      console.log("schema-drift: OK — schema.ts と DB は一致");
      return;
    }
    const drops = drift.filter((l) => l.startsWith("DROP"));
    console.log(`schema-drift: ${drift.length} 件の差分（うち DROP ${drops.length} 件 = push で失うもの）`);
    for (const l of drift) console.log(`  ${l}`);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && /schema-drift\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(`schema-drift: failed — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
}
