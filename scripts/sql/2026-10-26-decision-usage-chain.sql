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
-- owner_snapshot は、鍵を消したあとも持ち主を 1 人として数えるための列。アカウントを消すと、そのアカウントの行は
-- 1 つの新しいランダムな uuid にそろう（アカウントへのつながりは残らない）。
-- api_keys.owner_relation は運用者が手で付ける（self / related / external / NULL）。
--
-- decision_usage_monthly_published は、締まった月の公開値を一度だけ固定する表。
-- 列は month, chain, relation, owners, calls, published_at。
-- アプリが、翌月 3 日 00:00 UTC 以降の最初の読み取りで INSERT … ON CONFLICT DO NOTHING する。
-- このファイルは表を作るだけ。集計の書き込みはアプリが行う。
--
-- CHECK は、同名の制約が既にあるときは足さない。再実行のたびに api_keys を排他ロックしない。
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
  owner_snapshot uuid,
  CONSTRAINT decision_usage_daily_pk PRIMARY KEY (day, api_key_id, chain),
  CONSTRAINT decision_usage_daily_relation_snapshot_check
    CHECK (relation_snapshot IS NULL OR relation_snapshot IN ('self', 'related', 'external'))
);

-- 先に表だけ作った再実行でも、列を揃える。CHECK は無いときだけ足す。
ALTER TABLE decision_usage_daily
  ADD COLUMN IF NOT EXISTS relation_snapshot text;
ALTER TABLE decision_usage_daily
  ADD COLUMN IF NOT EXISTS owner_snapshot uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'decision_usage_daily_relation_snapshot_check'
      AND conrelid = 'decision_usage_daily'::regclass
  ) THEN
    ALTER TABLE decision_usage_daily
      ADD CONSTRAINT decision_usage_daily_relation_snapshot_check
      CHECK (relation_snapshot IS NULL OR relation_snapshot IN ('self', 'related', 'external'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS decision_usage_daily_chain_day_idx
  ON decision_usage_daily (chain, day);

CREATE TABLE IF NOT EXISTS decision_usage_monthly_published (
  month date NOT NULL,
  chain text NOT NULL,
  relation text NOT NULL,
  owners integer NOT NULL,
  calls bigint NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT decision_usage_monthly_published_pk PRIMARY KEY (month, chain, relation),
  CONSTRAINT decision_usage_monthly_published_relation_check
    CHECK (relation IN ('self', 'related', 'external', 'unclassified'))
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'decision_usage_monthly_published_relation_check'
      AND conrelid = 'decision_usage_monthly_published'::regclass
  ) THEN
    ALTER TABLE decision_usage_monthly_published
      ADD CONSTRAINT decision_usage_monthly_published_relation_check
      CHECK (relation IN ('self', 'related', 'external', 'unclassified'));
  END IF;
END
$$;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS owner_relation text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_keys_owner_relation_check'
      AND conrelid = 'api_keys'::regclass
  ) THEN
    ALTER TABLE api_keys
      ADD CONSTRAINT api_keys_owner_relation_check
      CHECK (owner_relation IS NULL OR owner_relation IN ('self', 'related', 'external'));
  END IF;
END
$$;

COMMIT;
