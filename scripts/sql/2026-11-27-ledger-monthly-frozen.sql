-- vet402 2026-11-27 — 月次の購入台帳凍結（F5）。
--
-- Safe to re-run. Only creates the table.
--
-- Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-11-27-ledger-monthly-frozen.sql

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS ledger_monthly_frozen (
  month text NOT NULL PRIMARY KEY,
  period_start date NOT NULL,
  period_end_exclusive date NOT NULL,
  row_count integer NOT NULL,
  content_sha256 text NOT NULL,
  summary_json jsonb NOT NULL,
  frozen_at timestamptz NOT NULL
);

COMMIT;