-- vet402 2026-09-28 — api_keys に first_used_at（認証が初めて通った時刻）を足す。
--
-- 目的: PMF の週次判定で「外部の人が発行したキーが、実際に使われ始めたか」を数える。
-- last_used_at は上書きされるので「いつ初めて使ったか」「2 週目も使ったか」が
-- 行から読めない。first_used_at は一度入ったら変えない。
--
-- 書き手: src/lib/db/api-keys.ts の touchApiKeyUsage（verifyApiKey が認証成功時に呼ぶ）。
-- last_used_at と同じ 1 本の UPDATE で `first_used_at = COALESCE(first_used_at, now)`。
--
-- **順序: この ALTER を本番に適用してから、first_used_at を含むコードをデプロイする。**
-- drizzle の insert は schema.ts の全列を列挙する（値は default）ので、列の無い DB へ
-- 新しいコードが載ると createApiKey（サインアップ・キー発行）が undefined_column で落ちる。
-- 逆順（ALTER が先・旧コードのまま）は無害: 旧コードは first_used_at を知らないだけ。
--
-- 列は NULL 可・追加のみ。既存列は消さない・型を変えない。
-- 既存行は last_used_at があればその値で埋める。本当の初回の時刻は残っていないので、
-- 埋めた値は「初回はこの時刻以前」という上限。「使われたか」の真偽は正しいが、
-- 既存キーの「初回からの週数」は短めに出る。
--
-- Safe to re-run. 本番 DB は同一 Neon ホストの **vouch** database（neondb ではない）。
-- Apply with:
--   psql "$DATABASE_URL" -f scripts/sql/2026-09-28-api-keys-first-used.sql
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS first_used_at timestamptz;

UPDATE api_keys
   SET first_used_at = last_used_at
 WHERE first_used_at IS NULL
   AND last_used_at IS NOT NULL;
