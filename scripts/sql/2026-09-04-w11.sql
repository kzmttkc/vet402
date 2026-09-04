-- ============================================================
-- 2026-09-04 金の経路監査（W11）の本番 DDL。全て冪等。
--
-- 適用順は上から下。1 と 2 は独立なので順序は問わないが、**2 を先に
-- 流すと失敗する可能性がある**（既存の重複行があるとき）ので、
-- 3 の確認クエリで 0 件を見てから 2 を流すこと。
-- 2026-09-04 時点の本番実測は重複 0 件。
--
-- 適用対象: Neon の database "vouch"（neondb ではない）。
-- ============================================================

-- ------------------------------------------------------------
-- 1. auth_nonce — 我々が署名したときの一回性の値。
--    EVM: EIP-3009 authorization の nonce（0x + 64 hex）
--    Solana: 我々が生成した memo 文字列
--    これが無いと、照合は「payer→payTo へ期待額が動いた tx がある」までしか
--    言えず、同じ payTo × 同じ価格の endpoint（本番実測 253 グループ）へ
--    1 本の tx を使い回せる。既存行は NULL のままでよい（従来判定に落ちる）。
-- ------------------------------------------------------------
ALTER TABLE x402_l1_purchases ADD COLUMN IF NOT EXISTS auth_nonce text;

-- ------------------------------------------------------------
-- 3.（先に実行）重複の実在確認。0 でなければ 2 は流さず、まず調査する。
-- ------------------------------------------------------------
-- SELECT network, lower(tx_hash) AS h, count(*)
-- FROM x402_l1_purchases
-- WHERE tx_hash IS NOT NULL
-- GROUP BY 1, 2 HAVING count(*) > 1;

-- ------------------------------------------------------------
-- 2. 1 本の決済 tx は 1 つの購入にしか属せない。
--    CONCURRENTLY は使わない（Neon の HTTP セッションではトランザクション
--    境界が読みにくく、この表は数千行規模なので通常の CREATE INDEX で足りる）。
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS x402_l1_purchases_tx_unique
  ON x402_l1_purchases (network, lower(tx_hash))
  WHERE tx_hash IS NOT NULL;

-- ------------------------------------------------------------
-- 4. 適用後の確認。
-- ------------------------------------------------------------
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'x402_l1_purchases' AND column_name = 'auth_nonce';
-- SELECT indexdef FROM pg_indexes
--  WHERE tablename = 'x402_l1_purchases' AND indexname = 'x402_l1_purchases_tx_unique';
