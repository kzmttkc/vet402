-- 2026-09-04 W15: settlements の日次集約表と、生行 7 日保持に合わせた索引の整理。
--
-- 背景（実測 2026-09-04 19:27 JST）: settlements は 311,344 行・309 MB、DB 全体
-- 473 MB。同日 18:40 の時点では 287,633 行・452 MB だったので、**47 分で 21 MB
-- 増えている**。Neon 無料枠 512 MB に対し 2026-09-02 20:43 UTC から INSERT が
-- `53100 project size limit` で全部落ちていた。決済索引は 1 日 3 万行積む。
--
-- 対策: 生行は直近 7 日だけ残し、それより古い UTC 日を settlement_daily へ畳む。
-- 集約は payer_id / payee_id / endpoint_id を鍵に持つので、センサスの
-- count(DISTINCT ...) は集約からも正確に出る（丸めない）。
--
-- このファイルは冪等。何度流してもよい。DDL だけで、行は 1 つも触らない。
--
-- 流す順序（初回。2 と 3 の間に必ず dry-run の出力を見ること）:
--
--   1) このファイル                                    -- 空の集約表を作るだけ
--   2) npm run settlements:rollup                      -- dry-run・何も書かない
--   3) SETTLEMENTS_RAW_RETENTION_DAYS=2 \
--        npm run settlements:rollup -- --apply         -- ★初回だけ 2 日
--   4) VACUUM (FULL, ANALYZE) settlements;             -- ここで初めて容量が返る
--   5) ANALYZE settlement_daily;
--
-- ★ なぜ初回だけ 2 日なのか（7 日ではなく）。
-- VACUUM FULL は「生きている行のぶんだけ」新しいファイルを書くので、書いて
-- いる間は旧ファイルと新ファイルが両方要る。7 日保持だと生き残るのが
-- 244,952 行・約 243 MB なので、473 MB + 243 MB = 716 MB となり 512 MB の枠を
-- その場で超えて VACUUM 自体が落ちる。2 日保持なら生き残るのは 8,615 行・
-- 約 9 MB で、追加で要る空きは 10 MB 程度に収まる。
-- なお枠に余裕が無いときは 1 日（SETTLEMENTS_RAW_RETENTION_DAYS=1）でもよい。
-- 2 日に縮めても失うのは「個票の受領証」だけで、センサスの数字は畳んだ集約
-- から正確に出る（それがこの変更の要点）。生行の窓は翌日から自然に 7 日へ
-- 戻り、以後は日次 cron が維持する。
--
-- 期待値（2026-09-04 19:27 実測から算出）:
--   settlements       309 MB → 約 9 MB   （311,344 行 → 8,615 行）
--   settlement_daily    0 MB → 約 14 MB  （約 2 万行・索引込み約 690 B/行）
--   DB 全体           473 MB → 約 190 MB
--   7 日窓が戻った定常状態（1 日 2 万行なら）  DB 約 320 MB
-- 数字は実行時点の行数で変わる。**必ず 2) の dry-run 出力を先に見ること。**
--
-- ------------------------------------------------------------
-- 1. 日次集約表
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settlement_daily (
  day         date    NOT NULL,
  chain       text    NOT NULL,
  payee_id    text,
  payer_id    text,
  wash_flag   text    NOT NULL,
  source      text    NOT NULL,
  attribution text    NOT NULL,
  endpoint_id uuid,
  resource_id text,
  n           integer NOT NULL DEFAULT 0,
  amount_sum  numeric NOT NULL DEFAULT '0'
);

-- NULLS NOT DISTINCT が要る: payee_id / endpoint_id / resource_id は NULL を
-- 取りうる。既定の「NULL は互いに相異」だと同じ鍵が重複行になり、
-- 遅れて届いた行の畳み直しが冪等でなくなる（PostgreSQL 15+）。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'settlement_daily_key') THEN
    ALTER TABLE settlement_daily
      ADD CONSTRAINT settlement_daily_key UNIQUE NULLS NOT DISTINCT
      (day, chain, payee_id, payer_id, wash_flag, source, attribution, endpoint_id, resource_id);
  END IF;
END $$;

-- day 単体の索引は置かない: settlement_daily_key の先頭列が day なので、
-- センサスの期間走査も保持期間の削除もその索引で足りる。payer_id の索引も
-- 置かない（絞り込む問い合わせが無い）。集約表は 1 日 2 千行積むので、
-- 使わない索引 1 本が数十 MB になる。
CREATE INDEX IF NOT EXISTS settlement_daily_endpoint_day_idx ON settlement_daily (endpoint_id, day);
CREATE INDEX IF NOT EXISTS settlement_daily_payee_day_idx    ON settlement_daily (payee_id, day);

-- ------------------------------------------------------------
-- 2. settlements の索引: 7 日保持で要るもの・要らないもの
-- ------------------------------------------------------------
-- 実測（pg_stat_user_indexes, 2026-09-04）:
--   settlements_purchase_id_unique  38 MB  scans 633,754  → 残す。upsert の重複排除の本体。
--   settlements_tx_hash_idx         34 MB  scans   3,569  → 残す。/resolve の tx 逆引き
--                                                            （src/lib/resolve/lookup.ts:164）と
--                                                            l0-accuracy の JOIN が使う。
--                                                            7 日保持なら数 MB に縮む。
--   settlements_payer_block_idx     25 MB  scans   1,851  → 残す。buyer_facts の payer_id + 期間。
--   settlements_pkey                11 MB  scans       0  → 残す（drizzle が primaryKey を宣言して
--                                                            いるので落とすとスキーマが乖離する）。
--                                                            0 回は要検討として別途起票。
--   settlements_endpoint_idx       2.3 MB  scans     866  → 残す。coverage の EXISTS。
--   settlements_wash_idx           1.8 MB  scans       4  → **落とすべきだが、ここでは落とさない。**
--                                                            wash_flag は 4 値しかなく 'none' が 99%。
--                                                            選択率が無いのでプランナが使わず、
--                                                            INSERT の書き込み負荷だけが残っている。
--                                                            ただし schema.ts が index("settlements_wash_idx")
--                                                            を宣言しているので、ここで DROP すると
--                                                            次の db:push が黙って作り直す。
--                                                            schema.ts の 1 行を消す変更と同じコミットで
--                                                            落とすこと（本 WO の範囲外・別途起票）:
--                                                              DROP INDEX IF EXISTS settlements_wash_idx;

-- ------------------------------------------------------------
-- 3. 畳んだ後（rollup --apply の後）に、手で流す
-- ------------------------------------------------------------
-- DELETE は行を dead tuple として残すだけで、Neon の project size は下がらない。
-- 容量が返るのは VACUUM FULL だけ。トランザクションの中では動かないので、
-- 1 文ずつ流すこと。ACCESS EXCLUSIVE ロックを取るので、決済索引の cron
--（13:00 UTC）と重ならない時間に。
--
--   VACUUM (FULL, ANALYZE) settlements;
--   ANALYZE settlement_daily;
--
-- 確認:
--   SELECT pg_size_pretty(pg_total_relation_size('settlements'))      AS settlements,
--          pg_size_pretty(pg_total_relation_size('settlement_daily')) AS daily,
--          pg_size_pretty(pg_database_size(current_database()))       AS db;
--
--   -- センサスが畳む前と一致していること（30 日窓）
--   SELECT * FROM (SELECT 1) x;  -- ↓ アプリ側で:
--   -- curl -s https://vet402.com/api/v1/census/summary?window=30d
--
-- 集約表が想定より速く育っていないかは、1 か月後にこれで見る:
--   SELECT day, count(*) FROM settlement_daily GROUP BY day ORDER BY day DESC LIMIT 30;
--   -- 1 日 2,000 行を大きく超えるようなら SETTLEMENTS_DAILY_RETENTION_DAYS を縮める。
