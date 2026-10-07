-- vet402 2026-10-07 — 既知の公開クライアント（今は User-Agent が `vet402-hermes/` のものだけ）の呼び出しを
-- (UTC 日, クライアント名/版, ルート名) ごとの件数だけで数える（src/lib/api/client-usage.ts）。
--
-- なぜ: Hermes プラグイン（github.com/kzmttkc/vet402-hermes・NousResearch のカタログに 10/3 掲載）は鍵なしで
-- /api/v1/resolve と /api/v1/resources/{id}/decision を呼ぶ。鍵なしの呼び出しは api_usage に残らず、
-- Vercel のログにも User-Agent が出ないので、使われているかを数える場所が無かった。
--
-- 保存するのは day / client / route / count だけ。IP・URL・クエリ・鍵・resource_id は保存しない。
--
-- 順序: どちらが先でも壊れない。表が無い間の書き込みは失敗をログへ出して捨てる（応答は変わらない）——
-- その間の呼び出しが数えられないだけ。
--
-- 追加のみ。Safe to re-run. 本番 DB は同一 Neon ホストの **vouch** database（neondb ではない）。
-- Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-10-07-client-usage-daily.sql
CREATE TABLE IF NOT EXISTS client_usage_daily (
  day    date   NOT NULL,
  client text   NOT NULL,
  route  text   NOT NULL,
  count  bigint NOT NULL,
  CONSTRAINT client_usage_daily_day_client_route_pk PRIMARY KEY (day, client, route)
);
