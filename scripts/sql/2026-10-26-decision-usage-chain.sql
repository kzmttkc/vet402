-- vet402 2026-10-26 — 鍵ありの判定 API の件数を、日・鍵・チェーンで数える。
--
-- 本番の vouch DB に、push の直前に流す。Safe to re-run.
-- 本番 DB は同一 Neon ホストの vouch database（neondb ではない）。
--
-- 足すだけ。既存の表の主キーや列は変えない。client_usage_daily には触らない。
-- 鍵なしの呼び出しはチェーンを持たない。調べた URL やクエリは保存しない、という今の約束のまま。
-- 数えるチェーンは鍵ありの判定だけ。
--
-- decision_usage_daily は鍵ありの判定 200 を日・鍵・チェーンで数える。api_usage とは別。
-- relation_snapshot は、鍵を消すときにその時点の区分を残す列（docs/operations/account-deletion.md）。
-- api_keys.owner_relation は運用者が手で付ける（self / related / external / NULL）。
--
-- 旧コードはこの表を読まない。owner_relation は NULL を許すので、列を書かない INSERT はそのまま動く。
-- client_usage_daily の ON CONFLICT (day, client, route) も、このファイルのあとでそのまま動く。
--
-- 索引は新しい空の表の上に、このトランザクションの中で作る。
--
-- Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-10-26-decision-usage-chain.sql

BEGIN;
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS decision_usage_daily (
  day date NOT NULL,
  api_key_id uuid NOT NULL,
  chain text NOT NULL,
  count bigint NOT NULL,
  relation_snapshot text,
  CONSTRAINT decision_usage_daily_pk PRIMARY KEY (day, api_key_id, chain),
  CONSTRAINT decision_usage_daily_relation_snapshot_check
    CHECK (relation_snapshot IS NULL OR relation_snapshot IN ('self', 'related', 'external'))
);

-- 先に表だけ作った再実行でも、列と CHECK を揃える。
ALTER TABLE decision_usage_daily
  ADD COLUMN IF NOT EXISTS relation_snapshot text;

ALTER TABLE decision_usage_daily DROP CONSTRAINT IF EXISTS decision_usage_daily_relation_snapshot_check;
ALTER TABLE decision_usage_daily ADD CONSTRAINT decision_usage_daily_relation_snapshot_check
  CHECK (relation_snapshot IS NULL OR relation_snapshot IN ('self', 'related', 'external'));

CREATE INDEX IF NOT EXISTS decision_usage_daily_chain_day_idx
  ON decision_usage_daily (chain, day);

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS owner_relation text;

ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_owner_relation_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_owner_relation_check
  CHECK (owner_relation IS NULL OR owner_relation IN ('self', 'related', 'external'));

COMMIT;
