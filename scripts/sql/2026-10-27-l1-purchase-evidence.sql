-- 2026-10-27: L1 の購入ごとの証拠（内部専用）。
--
-- 1 回の購入（予約行）ごとに 2 つを残す。売り手ごとに「受け取った 402 challenge・こちらが出した
-- 署名済みの支払いペイロード・結果」を示すため（結果は tx_hash / raw_settlement / raw_response_meta にある）。
--   challenge_402    予約行の INSERT で書く。402 の HTTP status・x402Version・accepts の全体・選んだ accept・
--                    PAYMENT-REQUIRED ヘッダーで来たときはデコード後の JSON（Tempo は MPP の challenge）。
--   payment_payload  auth_nonce と同じ UPDATE で書く（有料の要求の前）。X-PAYMENT / PAYMENT-SIGNATURE /
--                    MPP の credential の値をデコードした JSON。
--
-- **公開しない。** 署名済みのペイロードは期限内なら誰でも決済に出せる。export.csv・API・demo/verify・
-- 公開ページは列を名指しで読んでおり、この 2 列を読まない（tests/l1-purchase-evidence.pg.test.ts）。
-- 各列 32KB まで（アプリ側で切り詰め、truncated の印を付ける）。
--
-- 追加だけ（NULL 可・既定なし）。既存の行は NULL のまま——書き換えない。何度流しても同じ。
-- 適用: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-10-27-l1-purchase-evidence.sql

ALTER TABLE x402_l1_purchases ADD COLUMN IF NOT EXISTS challenge_402 jsonb;
ALTER TABLE x402_l1_purchases ADD COLUMN IF NOT EXISTS payment_payload jsonb;

-- 確認:
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
--  WHERE table_name = 'x402_l1_purchases' AND column_name IN ('challenge_402', 'payment_payload');
