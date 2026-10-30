-- vet402 2026-10-30 — one auth_nonce-bearing purchase row per seller-request id (seller-initiated retest lane).
--
-- raw_response_meta.sellerRequestId is set only by the seller-request L1 lane (2026-10-30). Production rows
-- before that deploy have no sellerRequestId key, so this partial unique index builds with zero conflicts.
--
-- Apply before or with the code that calls claimSellerRequestAuthSlot / writes sellerRequestId on pay.
-- Safe to re-run (IF NOT EXISTS). Same Neon host as other observatory DDL.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-10-30-seller-retest-request-id-unique.sql
CREATE UNIQUE INDEX IF NOT EXISTS x402_l1_purchases_seller_request_id_auth_unique
  ON x402_l1_purchases ((raw_response_meta->>'sellerRequestId'))
  WHERE raw_response_meta->>'sellerRequestId' IS NOT NULL
    AND auth_nonce IS NOT NULL;
