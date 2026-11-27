-- vet402 2026-11-27 — 月次の購入台帳凍結（F5）。
--
-- Safe to re-run. Only creates the table and immutability triggers. Runs in one transaction.
-- A frozen month is written once: INSERT stamps frozen_at with the DB clock; UPDATE and DELETE are refused.
-- Restoring a data-only dump into a migrated DB: use pg_restore/psql with --disable-triggers, or the INSERT
-- trigger restamps frozen_at. A full dump (schema + data) restores the original values (data before triggers).
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
  content_csv text NOT NULL,
  summary_json jsonb NOT NULL,
  frozen_at timestamptz NOT NULL
);

ALTER TABLE ledger_monthly_frozen
  ADD COLUMN IF NOT EXISTS content_csv text;

UPDATE ledger_monthly_frozen
  SET content_csv = ''
  WHERE content_csv IS NULL;

ALTER TABLE ledger_monthly_frozen
  ALTER COLUMN content_csv SET NOT NULL;

ALTER TABLE ledger_monthly_frozen
  ALTER COLUMN frozen_at SET DEFAULT now();

ALTER TABLE ledger_monthly_frozen
  DROP CONSTRAINT IF EXISTS ledger_monthly_frozen_frozen_at_not_past;

CREATE OR REPLACE FUNCTION ledger_monthly_frozen_set_frozen_at() RETURNS trigger AS $$
DECLARE
  frozen_iso text;
BEGIN
  NEW.frozen_at := now();
  frozen_iso := to_char(NEW.frozen_at AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
  NEW.summary_json := NEW.summary_json || jsonb_build_object('frozenAt', frozen_iso);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION ledger_monthly_frozen_immutable_cols() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_monthly_frozen rows are immutable (% refused)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_monthly_frozen_set_frozen_at ON ledger_monthly_frozen;
CREATE TRIGGER ledger_monthly_frozen_set_frozen_at
  BEFORE INSERT ON ledger_monthly_frozen
  FOR EACH ROW EXECUTE FUNCTION ledger_monthly_frozen_set_frozen_at();

DROP TRIGGER IF EXISTS ledger_monthly_frozen_immutable_cols ON ledger_monthly_frozen;
CREATE TRIGGER ledger_monthly_frozen_immutable_cols
  BEFORE UPDATE OR DELETE ON ledger_monthly_frozen
  FOR EACH ROW EXECUTE FUNCTION ledger_monthly_frozen_immutable_cols();

COMMIT;