-- vet402 2026-11-27 — 月次の購入台帳凍結（F5）。
--
-- Safe to re-run. Only creates the table and immutability triggers.
--
-- Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-11-27-ledger-monthly-frozen.sql

SET lock_timeout = '3s';

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
  IF OLD.frozen_at IS DISTINCT FROM NEW.frozen_at
     OR OLD.content_csv IS DISTINCT FROM NEW.content_csv
     OR OLD.content_sha256 IS DISTINCT FROM NEW.content_sha256
     OR OLD.row_count IS DISTINCT FROM NEW.row_count
  THEN
    RAISE EXCEPTION 'ledger_monthly_frozen immutable columns (% refused)', TG_OP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_monthly_frozen_set_frozen_at ON ledger_monthly_frozen;
CREATE TRIGGER ledger_monthly_frozen_set_frozen_at
  BEFORE INSERT ON ledger_monthly_frozen
  FOR EACH ROW EXECUTE FUNCTION ledger_monthly_frozen_set_frozen_at();

DROP TRIGGER IF EXISTS ledger_monthly_frozen_immutable_cols ON ledger_monthly_frozen;
CREATE TRIGGER ledger_monthly_frozen_immutable_cols
  BEFORE UPDATE ON ledger_monthly_frozen
  FOR EACH ROW EXECUTE FUNCTION ledger_monthly_frozen_immutable_cols();