-- vet402 PMF funnel — external people only (2026-09-28).
--
-- One row. Read-only (SELECT only). Counts are cumulative unless the column name ends in _7d.
--
-- Who is "external": every row in `accounts` whose email is NOT in the self list. The self list
-- (the operator's own and test signups) is passed at run time, never written in this repo — the
-- same rule as SELF_ACCOUNT_EMAILS in src/lib/gate2/report.ts (2026-09-07 repo hygiene).
--
-- Run (psql variable; pass an empty string to exclude nobody):
--   psql "$DATABASE_URL" -v self_emails="$SELF_ACCOUNT_EMAILS" -f docs/metrics/pmf-funnel.sql
--
-- Definitions:
--   external_accounts         accounts not in the self list
--   external_keys             api_keys whose user_id is an external account (revoked ones included:
--                             a key that was issued and later revoked still counts as issued)
--   external_keys_used        external keys with first_used_at set (an authenticated API call
--                             happened at least once; column from scripts/sql/2026-09-28-api-keys-first-used.sql)
--   external_keys_week2       external keys used again at least 7 days after their first use
--                             (last_used_at >= first_used_at + 7 days) — "came back in week 2"
--   paid_accounts             external accounts on a paid plan (pro / scale)
--   keys without an account (user_id NULL, or user_id pointing at a key id) are operator-issued
--   and are not counted as external.
WITH self AS (
  SELECT lower(trim(e)) AS email
    FROM unnest(string_to_array(:'self_emails', ',')) AS e
   WHERE trim(e) <> ''
),
ext_accounts AS (
  SELECT a.id, a.plan, a.created_at
    FROM accounts a
   WHERE lower(a.email) NOT IN (SELECT email FROM self)
),
ext_keys AS (
  SELECT k.id, k.created_at, k.first_used_at, k.last_used_at
    FROM api_keys k
    JOIN ext_accounts a ON a.id = k.user_id
)
SELECT
  (SELECT count(*) FROM ext_accounts)                                                       AS external_accounts,
  (SELECT count(*) FROM ext_accounts WHERE created_at >= now() - interval '7 days')         AS external_accounts_7d,
  (SELECT count(*) FROM ext_keys)                                                           AS external_keys,
  (SELECT count(*) FROM ext_keys WHERE created_at >= now() - interval '7 days')             AS external_keys_7d,
  (SELECT count(*) FROM ext_keys WHERE first_used_at IS NOT NULL)                           AS external_keys_used,
  (SELECT count(*) FROM ext_keys WHERE first_used_at >= now() - interval '7 days')          AS external_keys_first_used_7d,
  (SELECT count(*) FROM ext_keys
    WHERE first_used_at IS NOT NULL
      AND last_used_at >= first_used_at + interval '7 days')                                AS external_keys_week2,
  (SELECT count(*) FROM ext_accounts WHERE plan IN ('pro', 'scale'))                        AS paid_accounts,
  (SELECT count(*) FROM self)                                                               AS self_emails_excluded;
