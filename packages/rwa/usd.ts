// USD mark of a canonical Stock Token balance (SPEC §2).
//
//   usd_cents = raw * feed_answer * 100 / 1e8 / 1e18
//
// The equity feed already includes the split multiplier. Do not multiply
// uiMultiplier into the price: Fixture A fails if you do.

const FEED_SCALE = 10n ** 8n;
const RAW_SCALE = 10n ** 18n;

export function markUsdCents(raw: bigint, feedAnswer: bigint): bigint {
  if (raw < 0n) throw new RangeError("raw balance must not be negative");
  if (feedAnswer <= 0n) throw new RangeError("feed answer must be positive");
  return (raw * feedAnswer * 100n) / FEED_SCALE / RAW_SCALE;
}
