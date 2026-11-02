-- 2026-11-02: L1 の共有の日次枠（資金経路の監査 H-1 と独立レビュー）。枠ごと・UTC 日ごとに 1 行。
--   unproven   実績のない売り手全体の支出
--   over_dime  $0.10 を超える購入全体の支出
--
-- reserveSpend の 1 文の中で ON CONFLICT DO UPDATE ... WHERE する。行ロックのあとで最新の値を読み直すので、
-- 同時の予約でも日次の上限（budget.ts）を超えない。
--
-- 追加だけ。既存の表は変えない。何度流しても同じ。
-- **デプロイより先に本番へ流す。** 表が無いと L1 は買わない（cron の応答の disabledReason が spend_pool_table_missing）。
-- 戻すときは先にコードを戻し、表はそのあとで消してよい。
-- 適用: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-11-02-l1-spend-pool-daily.sql

CREATE TABLE IF NOT EXISTS x402_l1_spend_pool_daily (
  day date NOT NULL,
  pool text NOT NULL,
  spent_units numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, pool)
);

-- 確認:
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
--  WHERE table_name = 'x402_l1_spend_pool_daily' ORDER BY ordinal_position;
