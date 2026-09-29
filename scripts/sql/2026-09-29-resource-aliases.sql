-- vet402 2026-09-29 — resource_id の別名の表（監査 7 周目・高: URL の書き方しだいで BLOCK を素通りする）。
--
-- 穴の形: SDK の payOrRefuse（凍結中）は resource_id を生の URL から sha256("<METHOD> <url>") で作り、
-- サーバの正規化（src/lib/ids/canonical.ts）を通さない。末尾スラッシュ・ホストの大文字・:443・クエリの並びが
-- 違うと /decision が 404 になり、SDK は「カタログ外」として受取人スコアで決める——BLOCK の資源にも署名まで進みうる。
-- 例: `POST https://api.exa.ai/search/` は 404、/resolve は正規の baad6a17… を返す。
--
-- この表は「別名 → 正規の resource_id」。別名は canonical.ts resourceIdAliases が作る（正規形が完全に同じになる
-- 生の書き方だけ）。/decision は完全一致が外れたときだけこの表を引く（src/lib/resolve/lookup.ts getResource）。
-- 書き手: src/lib/resolve/aliases.ts（catalog-sync が毎回 3,000 出品まで・全件は scripts/backfill-resource-aliases.ts）。
--
-- 順序: どちらが先でも壊れない。表の無い DB では引く側は「別名なし」（従来の 404）、書く側は何もしない。
-- 効かせるには: この CREATE → デプロイ → backfill（--apply）。
--
-- 追加のみ。Safe to re-run. 本番 DB は同一 Neon ホストの **vouch** database（neondb ではない）。
-- Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-09-29-resource-aliases.sql
CREATE TABLE IF NOT EXISTS x402_resource_aliases (
  alias_id    text PRIMARY KEY,
  resource_id text NOT NULL,
  created_at  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS x402_resource_aliases_resource_id_idx ON x402_resource_aliases (resource_id);
