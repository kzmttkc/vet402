-- 2026-08-23 監査 C-4: settled の定義を「売り手が主張した」から
-- 「我々がチェーンで確認した」へ置き換えるための列。
--
-- 背景: 決済の真偽値も tx ハッシュも、売り手が返す PAYMENT-RESPONSE ヘッダの
-- 中身だった。売り手は決済せずに success:true と架空のハッシュを返すだけで
-- 「決済成功」の行を作れ、それが公開台帳・公開バッジ・CSV になり、
-- 2026-08-22 以降はスコアの最上位軸にも流れた。
--
-- 新しい流れ:
--   購入直後      → status='settle_claimed'（売り手が主張・形式は正しい）
--   日次の照合cron → 'settled'（オンチェーン確認済み）
--                  または 'settle_claim_refuted'（見に行って一致しなかった）
--
-- 既存の 'settled' 行は照合前の意味で書かれているので、backfill で
-- 実際に照合してから現在の意味へ揃える。
ALTER TABLE x402_l1_purchases
  ADD COLUMN IF NOT EXISTS settlement_verified boolean,
  ADD COLUMN IF NOT EXISTS settlement_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS settlement_verify_reason text,
  ADD COLUMN IF NOT EXISTS settlement_block_number bigint;

-- 照合cron が「まだ見ていない行」を引くための索引。
CREATE INDEX IF NOT EXISTS x402_l1_purchases_pending_verify_idx
  ON x402_l1_purchases (attempted_at)
  WHERE settlement_verified IS NULL AND tx_hash IS NOT NULL;
