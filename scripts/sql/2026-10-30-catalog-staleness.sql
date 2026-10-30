-- 2026-10-30: CDP Bazaar の目録を「続きから回り続けるカーソル」で読み、「何周も見えていない」で閉じる（設計 v5）。
--
-- 契約: docs/catalog-staleness-contract.md
--   x402_catalog_cursors   目録ごとに 1 行のカーソル（next_offset・pass_seq・lease）。
--   x402_catalog_passes    閉じた周回の記録（弱い周回の印 weak）。閉じる条件 (a) は weak = false を数える。
--   x402_endpoints.last_seen_pass  カーソルがその行を最後に見た周回の番号。
--
-- 追加だけ（CREATE / ALTER … IF NOT EXISTS）。既存の行は書き換えない。何度流しても同じ。
-- 旧コードのまま当てても安全: 旧コードはこの表と列を読まず書かない（列は NULL 可・既定なし）。
-- 適用: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-10-30-catalog-staleness.sql

CREATE TABLE IF NOT EXISTS x402_catalog_cursors (
  source text PRIMARY KEY,
  next_offset integer NOT NULL DEFAULT 0,
  pass_seq integer NOT NULL DEFAULT 1,
  pass_started_at timestamptz,
  pass_pages_read integer NOT NULL DEFAULT 0,
  pass_pages_failed integer NOT NULL DEFAULT 0,
  last_pass_completed_at timestamptz,
  last_strong_pass_completed_at timestamptz,
  lease_until timestamptz,
  lease_holder uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS x402_catalog_passes (
  source text NOT NULL,
  pass_seq integer NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  total_at_close integer NOT NULL,
  pages_read integer NOT NULL,
  pages_failed integer NOT NULL,
  weak boolean NOT NULL,
  CONSTRAINT x402_catalog_passes_source_pass_seq_pk PRIMARY KEY (source, pass_seq)
);

ALTER TABLE x402_endpoints ADD COLUMN IF NOT EXISTS last_seen_pass integer;

-- 確認:
-- SELECT table_name FROM information_schema.tables WHERE table_name IN ('x402_catalog_cursors', 'x402_catalog_passes');
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
--  WHERE table_name = 'x402_endpoints' AND column_name = 'last_seen_pass';
