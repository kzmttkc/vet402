-- vet402 2026-11-26 — 鍵なし公開 API の呼び出しを (UTC 日, client, ルート, network) ごとの件数で足す（src/lib/api/client-usage.ts）。
--
-- client_usage_daily は従来どおり。network が endpoint の行から分かる呼び出しだけ、この表にも 1 足す。
-- 保存するのは day / client / route / network / count だけ。IP・URL・クエリ・鍵・resource_id は保存しない。
--
-- 順序: どちらが先でも壊れない。表が無い間の書き込みは失敗をログへ出して捨てる（応答は変わらない）。
--
-- 追加のみ。Safe to re-run. 本番 DB は同一 Neon ホストの **vouch** database（neondb ではない）。
-- Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-11-26-client-usage-daily-network.sql
CREATE TABLE IF NOT EXISTS client_usage_daily_network (
  day     date   NOT NULL,
  client  text   NOT NULL,
  route   text   NOT NULL,
  network text   NOT NULL,
  count   bigint NOT NULL,
  CONSTRAINT client_usage_daily_network_pk PRIMARY KEY (day, client, route, network)
);