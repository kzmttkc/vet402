-- Record subscriptions (2026-09-02) — stage 2 "take the name".
--
-- One row per (endpoint, email, kind). kind=notify: one email when the public
-- verdict of the endpoint record changes (cron /api/cron/notify-subscribers).
-- kind=dispute: a reader's objection to the record, forwarded to support.
-- ip_hash is sha256(ip)[0:32]; the raw address is never stored.
-- Idempotent. Safe to re-run:
--   psql "$DATABASE_URL" -f scripts/sql/2026-09-02-record-subscriptions.sql
CREATE TABLE IF NOT EXISTS record_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id uuid NOT NULL,
  email text NOT NULL,
  kind text NOT NULL,
  reason text,
  last_verdict text NOT NULL,
  created_at timestamptz DEFAULT now(),
  notified_at timestamptz,
  ip_hash text
);

-- Upsert target: the same person asking the same thing about the same record is one row.
CREATE UNIQUE INDEX IF NOT EXISTS record_subscriptions_endpoint_email_kind_unique
  ON record_subscriptions (endpoint_id, email, kind);

-- The cron reads "all notify rows"; support reads "all dispute rows".
CREATE INDEX IF NOT EXISTS record_subscriptions_kind_idx
  ON record_subscriptions (kind);
