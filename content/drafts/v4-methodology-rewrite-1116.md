# Methodology rewrite draft (2026-11-16 calendar row)

Status: **not for publication** until owner approval under V4 section 6.A.

The live methodology page (`src/app/observatory/methodology/page.tsx`) stays unchanged until approval is recorded. When it is approved, the same commit also updates `tests/covert-wording.test.ts` and `docs/claims.yaml` (V4 section 6.A). Nothing below is linked from a public page.

## Proposed section: delivery hit rate yardstick (S1-2)

The delivery hit rate is read against a yardstick fixed in git before any S1-3 repurchase result is read. The yardstick is `data/v4/delivery-hit-rate-yardstick.json`, served at `/api/v1/v4/delivery-hit-rate-yardstick`. It holds the minimum settled rows per endpoint (`minSample`) and the ledger time split: rows on or before `trainEndUtcDate` train, rows on or after `evalStartUtcDate` evaluate.

If `minSample` or `fixedAt` changes later, the change is appended to `minSampleChangelog` or `fixedAtChangelog` in the same file, with the time it was made. Rows already published are not rewritten.

No hit rate point is published for an endpoint below `minSample`. The first reading is dated 2026-11-18 and uses only this yardstick.

## Proposed section: dated forecast for a named buyer (F4 v1)

The forecast at `/api/v1/v4/named-buyer-delivery-forecast` applies only to a buyer that identifies itself (名乗る買い手の場合). It is trained on the Stellar roots day snapshots in `contracts/stellar-roots/days` dated on or before `snapshotDate`, and the snapshot date is printed next to the forecast. It is a dated forecast, not the live payer decision.
