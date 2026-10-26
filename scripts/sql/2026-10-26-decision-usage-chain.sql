-- vet402 2026-10-26 — 判定 API の件数にチェーンを足す。
--
-- client_usage_daily に chain（CAIP-2。不明と resolve は空文字）を足し、主キーを
-- (day, client, route, chain) にする。呼び手の粒度は変えない。
-- decision_usage_daily は鍵ありの判定 200 を日・鍵・チェーンで数える。api_usage とは別。
-- api_keys.owner_relation は運用者が手で付ける（self / related / external / NULL）。
--
-- 追加と主キーの付け替え。Safe to re-run.
-- 本番 DB は同一 Neon ホストの vouch database（neondb ではない）。このファイルは本番には流さない。
-- Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-10-26-decision-usage-chain.sql

ALTER TABLE client_usage_daily ADD COLUMN IF NOT EXISTS chain text;
UPDATE client_usage_daily SET chain = '' WHERE chain IS NULL;
ALTER TABLE client_usage_daily ALTER COLUMN chain SET DEFAULT '';
ALTER TABLE client_usage_daily ALTER COLUMN chain SET NOT NULL;

DO $$
DECLARE
  cons name;
BEGIN
  FOR cons IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'client_usage_daily'
      AND con.contype = 'p'
  LOOP
    EXECUTE format('ALTER TABLE client_usage_daily DROP CONSTRAINT %I', cons);
  END LOOP;
  ALTER TABLE client_usage_daily
    ADD CONSTRAINT client_usage_daily_day_client_route_chain_pk
    PRIMARY KEY (day, client, route, chain);
END $$;

CREATE TABLE IF NOT EXISTS decision_usage_daily (
  day date NOT NULL,
  api_key_id uuid NOT NULL,
  chain text NOT NULL,
  count bigint NOT NULL,
  CONSTRAINT decision_usage_daily_pk PRIMARY KEY (day, api_key_id, chain)
);

CREATE INDEX IF NOT EXISTS decision_usage_daily_chain_day_idx ON decision_usage_daily (chain, day);

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS owner_relation text;
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_owner_relation_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_owner_relation_check
  CHECK (owner_relation IS NULL OR owner_relation IN ('self', 'related', 'external'));
