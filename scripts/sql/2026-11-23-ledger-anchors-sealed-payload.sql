-- vet402 2026-11-23 — keep the bytes each daily root was computed from.
-- The day file used to be rebuilt from the current rows, so a day whose rows changed after sealing
-- (a late settlement confirmation) no longer recomputed to its root. anchorDay now stores the sealed
-- payload; /api/v1/observatory/anchors/day serves it. Days sealed before this change keep NULL unless
-- their current rows still recompute to the sealed root (then the bytes are provably the sealed ones).
-- Apply before deploying code that reads this column:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/sql/2026-11-23-ledger-anchors-sealed-payload.sql

ALTER TABLE ledger_anchors ADD COLUMN IF NOT EXISTS sealed_payload text;
