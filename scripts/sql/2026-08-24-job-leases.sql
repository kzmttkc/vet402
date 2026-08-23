-- 2026-08-24 監査: cron のバッチ排他。
--
-- l1-purchase は実資金を動かすが、バッチ全体の排他が無かった。予約 SQL
-- (reserveSpend) は単一文で原子的なので**日次上限は破れない**が、二重起動すると
-- 孤児 in_flight の増減・summary の混乱・同じエンドポイントへの重複購入が起きる。
-- Vercel cron の重複発火は実在し得るし、手動トリガと定時が重なることもある。
--
-- advisory lock は使えない: neon-http はステートレスなHTTPで、セッションレベルの
-- ロックが文をまたいで保たれない（reserveSpend を単一文にしたのと同じ制約）。
-- そこで「期限付きリース」を1文の upsert で取る。読んでから書かないので
-- TOCTOU が無い。
CREATE TABLE IF NOT EXISTS job_leases (
  name text PRIMARY KEY,
  holder uuid NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
