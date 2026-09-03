-- 2026-09-03: registry_writes に失敗理由を残す。
-- 8/21 以来 14 件が全部 failed だったのに、理由が DB にもログにも無く、
-- 原因（ERC-8004 の仕様で validator は request を自己開始できない）を突き止めるのに
-- オンチェーンの eth_call シミュレーションまで戻る必要があった。二度やらないための列。
-- 冪等。再実行して安全: psql "$DATABASE_URL" -f scripts/sql/2026-09-03-registry-error.sql
ALTER TABLE registry_writes ADD COLUMN IF NOT EXISTS error text;
