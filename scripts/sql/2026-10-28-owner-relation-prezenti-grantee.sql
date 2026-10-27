-- vet402 2026-10-28 — 鍵の区分に prezenti_grantee（Prezenti の採択者）を足す。
--
-- 本番の vouch DB に、push の直前に流す。Safe to re-run.
-- 本番 DB は同一 Neon ホストの vouch database（neondb ではない）。
-- 先に 2026-10-26-decision-usage-chain.sql が流れていること（3 つの CHECK はそこで作った）。
--
-- 許す値を広げるだけ。既存の値・行・列・主キーは変えない。公開済みの行（decision_usage_monthly_published）は
-- 消さない・書き換えない。CHECK を広げるには付け替えるしかないので、同じ名前で外して付け直す。
-- 新しい定義に prezenti_grantee が既にあるときは何もしない（再実行のたびに表を排他ロックしない）。
--
-- 順番: このファイルを流してから push する。アプリは翌月 3 日以降の最初の読み取りで、5 区分
-- （self / related / external / prezenti_grantee / unclassified）を decision_usage_monthly_published に書く。
-- このファイルより先にアプリが出ると、その INSERT が CHECK で落ちて公開表が 503 になる。
-- 旧コードはこのファイルのあとでもそのまま動く（prezenti_grantee の鍵は旧コードでは unclassified に入る）。
--
-- 3 つの表（api_keys・decision_usage_daily・decision_usage_monthly_published）は小さい。付け直しの検査は一瞬で終わる。
--
-- Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-10-28-owner-relation-prezenti-grantee.sql

BEGIN;
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'api_keys_owner_relation_check'
      AND conrelid = 'api_keys'::regclass
      AND pg_get_constraintdef(oid) LIKE '%prezenti_grantee%'
  ) THEN
    ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_owner_relation_check;
    ALTER TABLE api_keys
      ADD CONSTRAINT api_keys_owner_relation_check
      CHECK (owner_relation IS NULL OR owner_relation IN ('self', 'related', 'external', 'prezenti_grantee'));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'decision_usage_daily_relation_snapshot_check'
      AND conrelid = 'decision_usage_daily'::regclass
      AND pg_get_constraintdef(oid) LIKE '%prezenti_grantee%'
  ) THEN
    ALTER TABLE decision_usage_daily DROP CONSTRAINT IF EXISTS decision_usage_daily_relation_snapshot_check;
    ALTER TABLE decision_usage_daily
      ADD CONSTRAINT decision_usage_daily_relation_snapshot_check
      CHECK (relation_snapshot IS NULL OR relation_snapshot IN ('self', 'related', 'external', 'prezenti_grantee'));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'decision_usage_monthly_published_relation_check'
      AND conrelid = 'decision_usage_monthly_published'::regclass
      AND pg_get_constraintdef(oid) LIKE '%prezenti_grantee%'
  ) THEN
    ALTER TABLE decision_usage_monthly_published DROP CONSTRAINT IF EXISTS decision_usage_monthly_published_relation_check;
    ALTER TABLE decision_usage_monthly_published
      ADD CONSTRAINT decision_usage_monthly_published_relation_check
      CHECK (relation IN ('self', 'related', 'external', 'prezenti_grantee', 'unclassified'));
  END IF;
END
$$;

COMMIT;
