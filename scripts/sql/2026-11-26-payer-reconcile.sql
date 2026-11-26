-- vet402 2026-11-26 — 払い手照合（payer-reconcile）の実行記録。
-- 本番手順: この SQL を当ててから payer-reconcile のコードをデプロイする。
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-11-26-payer-reconcile.sql

CREATE TABLE IF NOT EXISTS payer_reconcile_runs (
  id serial PRIMARY KEY,
  ran_at timestamptz NOT NULL,
  ok boolean NOT NULL,
  total_unrecorded integer NOT NULL,
  total_pending integer NOT NULL,
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL,
  chains_json jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS payer_reconcile_runs_ran_at_idx ON payer_reconcile_runs (ran_at DESC);