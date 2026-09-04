// ============================================================
// schema.ts と実 DB の突合（2026-09-04 監査 D・P1）。読み取り専用・純粋関数。
//
// `drizzle-kit push` は schema.ts を正として DB を揃える——DB にだけあるものは **drop**、
// schema にだけあるものは create。job_leases（cron の排他）と部分索引
// x402_l1_purchases_pending_verify_idx が「DB にだけある」状態で放置されていた。
// push せずに「push したら何が起きるか」を読む道具。実接続は scripts/schema-drift.ts。
//
// 比べるのは 列（型・NOT NULL・default の有無）・索引（列・unique・partial）・主キー。
// 索引の WHERE 式や default の値は pg 側が正規化して書き換えるので文字比較しない
// （partial かどうか・default があるかどうか、までを見る）。
// ============================================================
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";

export type ColumnShape = { type: string; notNull: boolean; hasDefault: boolean };
export type IndexShape = { columns: string[]; unique: boolean; partial: boolean };
export type TableShape = {
  columns: Record<string, ColumnShape>;
  indexes: Record<string, IndexShape>;
  primaryKey: string[];
};
export type SchemaShape = Record<string, TableShape>;

/** pg の format_type と drizzle の getSQLType を同じ語彙へ寄せる。 */
export function normalizeType(raw: string): string {
  let t = raw.trim().toLowerCase();
  t = t.replace(/^character varying/, "varchar");
  t = t.replace(/^timestamp \(\d+\) with time zone$/, "timestamptz");
  t = t.replace(/^timestamp with time zone$/, "timestamptz");
  t = t.replace(/^timestamp without time zone$/, "timestamp");
  t = t.replace(/^timestamp \(\d+\) without time zone$/, "timestamp");
  t = t.replace(/^time without time zone$/, "time");
  if (t === "serial") return "integer";
  if (t === "bigserial") return "bigint";
  if (t === "smallserial") return "smallint";
  if (t === "int4") return "integer";
  if (t === "int8") return "bigint";
  if (t === "bool") return "boolean";
  return t;
}

export function expectedFromDrizzle(schemaModule: Record<string, unknown>): SchemaShape {
  const out: SchemaShape = {};
  for (const value of Object.values(schemaModule)) {
    if (!(value instanceof PgTable)) continue;
    const cfg = getTableConfig(value);
    const columns: Record<string, ColumnShape> = {};
    const primaryKey: string[] = [];
    for (const c of cfg.columns) {
      const sqlType = c.getSQLType();
      columns[c.name] = {
        type: normalizeType(sqlType),
        // 主キー列は暗黙に NOT NULL（pg 側は attnotnull=true で返る）。
        notNull: c.notNull || c.primary,
        hasDefault: c.hasDefault || /serial$/.test(sqlType),
      };
      if (c.primary) primaryKey.push(c.name);
    }
    for (const pk of cfg.primaryKeys) {
      for (const c of pk.columns) if (!primaryKey.includes(c.name)) primaryKey.push(c.name);
    }
    const indexes: Record<string, IndexShape> = {};
    for (const idx of cfg.indexes) {
      const name = idx.config.name;
      if (!name) continue;
      indexes[name] = {
        columns: idx.config.columns.map((c) => ("name" in c && typeof c.name === "string" ? c.name : "<expr>")),
        unique: Boolean(idx.config.unique),
        partial: Boolean(idx.config.where),
      };
    }
    out[cfg.name] = { columns, indexes, primaryKey };
  }
  return out;
}

/**
 * 差分を人が読める行にして返す。空配列 = drift 無し。
 * 各行の先頭は push が実行する操作（DROP/CREATE/ADD/ALTER）で、DROP は失うもの。
 */
export function diffSchema(expected: SchemaShape, actual: SchemaShape): string[] {
  const out: string[] = [];
  const tables = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const t of [...tables].sort()) {
    const e = expected[t];
    const a = actual[t];
    if (!a) {
      out.push(`CREATE TABLE ${t} — schema.ts にだけある（push で作られる）`);
      continue;
    }
    if (!e) {
      out.push(`DROP TABLE ${t} — DB にだけある（push で drop される・${Object.keys(a.columns).length} 列）`);
      continue;
    }
    for (const c of Object.keys(e.columns).sort()) {
      const ec = e.columns[c];
      const ac = a.columns[c];
      if (!ac) {
        out.push(`ADD COLUMN ${t}.${c} — schema.ts にだけある（push で追加される）`);
        continue;
      }
      if (ec.type !== ac.type) out.push(`ALTER COLUMN ${t}.${c} — 型 schema=${ec.type} / db=${ac.type}`);
      if (ec.notNull !== ac.notNull)
        out.push(`ALTER COLUMN ${t}.${c} — NOT NULL schema=${ec.notNull} / db=${ac.notNull}`);
      if (ec.hasDefault !== ac.hasDefault)
        out.push(`ALTER COLUMN ${t}.${c} — default の有無 schema=${ec.hasDefault} / db=${ac.hasDefault}`);
    }
    for (const c of Object.keys(a.columns).sort()) {
      if (!e.columns[c]) out.push(`DROP COLUMN ${t}.${c} — DB にだけある（push で drop される・型 ${a.columns[c].type}）`);
    }
    for (const i of Object.keys(e.indexes).sort()) {
      const ei = e.indexes[i];
      const ai = a.indexes[i];
      if (!ai) {
        out.push(`CREATE INDEX ${i} ON ${t} — schema.ts にだけある（push で作られる）`);
        continue;
      }
      if (ei.columns.join(",") !== ai.columns.join(","))
        out.push(`ALTER INDEX ${i} ON ${t} — 列 schema=(${ei.columns.join(",")}) / db=(${ai.columns.join(",")})`);
      if (ei.unique !== ai.unique) out.push(`ALTER INDEX ${i} ON ${t} — unique schema=${ei.unique} / db=${ai.unique}`);
      if (ei.partial !== ai.partial) out.push(`ALTER INDEX ${i} ON ${t} — partial(WHERE) schema=${ei.partial} / db=${ai.partial}`);
    }
    for (const i of Object.keys(a.indexes).sort()) {
      if (!e.indexes[i]) out.push(`DROP INDEX ${i} ON ${t} — DB にだけある（push で drop される・列 ${a.indexes[i].columns.join(",")}）`);
    }
    if (e.primaryKey.join(",") !== a.primaryKey.join(",")) {
      out.push(`PRIMARY KEY ${t} — schema=(${e.primaryKey.join(",")}) / db=(${a.primaryKey.join(",")})`);
    }
  }
  return out;
}

/**
 * pg_indexes.indexdef（`CREATE [UNIQUE] INDEX name ON tbl USING btree (a, b) [WHERE ...]`）
 * から列・unique・partial を読む。列の括弧は WHERE 側の括弧と区別するため対応括弧で切る
 * （貪欲な正規表現だと `WHERE ((a IS NULL) AND (b IS NOT NULL))` の末尾まで列に含めてしまう）。
 */
export function parseIndexDef(def: string): IndexShape {
  const unique = /^CREATE UNIQUE INDEX/i.test(def);
  const usingAt = def.search(/USING \w+ \(/i);
  if (usingAt < 0) return { columns: ["<unparsed>"], unique, partial: /\sWHERE\s/i.test(def) };
  const open = def.indexOf("(", usingAt);
  let depth = 0;
  let close = -1;
  for (let i = open; i < def.length; i++) {
    if (def[i] === "(") depth++;
    else if (def[i] === ")") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  const inner = close > open ? def.slice(open + 1, close) : "";
  const rest = close > 0 ? def.slice(close + 1) : "";
  const columns = splitTopLevel(inner).map((c) => {
    const s = c
      .trim()
      .replace(/\s+(ASC|DESC)(\s+NULLS\s+(FIRST|LAST))?$/i, "")
      .replace(/^"(.*)"$/, "$1");
    return /[()]/.test(s) ? "<expr>" : s;
  });
  return { columns, unique, partial: /^\s*WHERE\s/i.test(rest) };
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
