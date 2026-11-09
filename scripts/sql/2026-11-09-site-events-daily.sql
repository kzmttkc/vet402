-- vet402 2026-11-09 — 公開頁の利用を (UTC 日, イベント名, 頁グループ, 参照元ラベル) ごとの件数だけで数える（src/lib/site-events.ts）。
--
-- なぜ: Plausible の契約は 2026-11-07 で切れ、API は 402 を返す。ブラウザは依然 plausible.io へ送っていたが、
-- 集計用の数がサーバに残らなくなった。第三者にビーコンを送らず、vet402 自身が同じ粒度の日次件数だけを持つ。
--
-- 保存するのは day / event / path / source / count だけ。IP・User-Agent の文字列・生 URL・クエリ・Referer のパス・
-- cookie・ローカル識別子は保存しない。ヘッダは bot を除くか・参照元ラベルを選ぶかの判定だけに読み、捨てる。
--
-- 順序: どちらが先でも壊れない。表が無い間の書き込みは失敗をログへ出して捨てる（応答は変わらない）——
-- その間のイベントが数えられないだけ。
--
-- 追加のみ。Safe to re-run. 本番 DB は同一 Neon ホストの **vouch** database（neondb ではない）。
-- Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-11-09-site-events-daily.sql
CREATE TABLE IF NOT EXISTS site_events_daily (
  day    date   NOT NULL,
  event  text   NOT NULL,
  path   text   NOT NULL,
  source text   NOT NULL,
  count  bigint NOT NULL,
  CONSTRAINT site_events_daily_pk PRIMARY KEY (day, event, path, source)
);
CREATE INDEX IF NOT EXISTS site_events_daily_day_idx ON site_events_daily (day);
