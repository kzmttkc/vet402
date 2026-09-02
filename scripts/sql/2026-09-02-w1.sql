-- 2026-09-02 敵対的監査 C1: Solana 決済索引の再開カーソル。
--
-- getSignaturesForAddress は「最新 N 件」しか返さないので、前回どこまで読んだかを
-- slot だけで持つと 26 件目以降が落ちる。最新の署名を until に渡して差分だけ読む
-- ために、チェックポイントへ署名を並べて持つ。既存行（slot のみ）はそのまま動く
-- （last_cursor が NULL なら slot 以下を捨てる旧規則で走る）。EVM の scope は使わない。
ALTER TABLE indexer_checkpoints ADD COLUMN IF NOT EXISTS last_cursor text;
