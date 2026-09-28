-- Record subscriptions: double opt-in + unsubscribe (2026-09-28 audit).
--
-- Columns only; nothing is dropped or rewritten. A row is "pending" until
-- confirmed_at is set, so every pre-existing row (0 in production on
-- 2026-09-28) is pending by construction and receives no notification until
-- its owner confirms through a fresh submission.
--   confirm_token_hash  sha256(hex) of the one-time confirmation token; the
--                       raw token exists only in the confirmation email
--   confirm_sent_at     when that email actually went out (the 72h window
--                       starts here; NULL = never sent = cannot be confirmed)
--   confirmed_at        set by POST /api/v1/observatory/subscriptions/confirm
--   unsubscribed_at     set by POST /api/v1/observatory/subscriptions/unsubscribe
-- Idempotent. Safe to re-run:
--   psql "$DATABASE_URL" -f scripts/sql/2026-09-28-record-subscription-optin.sql
--
-- Rollback (only after the code that reads these columns is rolled back):
--   DROP INDEX IF EXISTS record_subscriptions_confirm_token_hash_idx;
--   ALTER TABLE record_subscriptions
--     DROP COLUMN IF EXISTS confirm_token_hash,
--     DROP COLUMN IF EXISTS confirm_sent_at,
--     DROP COLUMN IF EXISTS confirmed_at,
--     DROP COLUMN IF EXISTS unsubscribed_at;
ALTER TABLE record_subscriptions ADD COLUMN IF NOT EXISTS confirm_token_hash text;
ALTER TABLE record_subscriptions ADD COLUMN IF NOT EXISTS confirm_sent_at timestamptz;
ALTER TABLE record_subscriptions ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE record_subscriptions ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz;

-- The confirm POST looks a row up by the token hash.
CREATE INDEX IF NOT EXISTS record_subscriptions_confirm_token_hash_idx
  ON record_subscriptions (confirm_token_hash);
