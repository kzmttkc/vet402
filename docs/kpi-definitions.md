# KPI definitions (I0)

Internal reference for vet402 monthly KPI ledger. **No metric values appear in this document** (definitions and data locations only). Public pages, APIs, and `llms.txt` must not expose revenue values until C2 is lifted; only the monthly KPI file sha256 may appear in daily anchors.

Spec source: Growth &amp; acquisition spec v3, §6 (metrics), §7 (evidence), §4 I0, constraints C1–C11.

## External caller subject

**Definition:** Distinct subjects that called the API, MCP, or x402 in the period. A subject is one of:

- A distinct API key ID (keyed routes)
- A distinct payment wallet (x402)
- A keyless subject: `(HMAC-SHA256 of IPv4 /24 with a UTC-day salt) + normalized User-Agent label`

**Source data (planned):** `kpi_events` (see `docs/kpi-event-log.md`). Until the log exists, caller-subject KPIs are **not computed** for months before `coverage.externalCallerSubjectSince` (null in I0).

**Exclusions (mechanical):**

- vet402 infrastructure, monitoring, CI clients (`client_usage_daily` labels: `self-monitor`, observatory clients)
- Operator-owned keys and wallets (listed in buyer data pack exclusion files when approved)
- Known bots/crawlers (same rules as `client_usage_daily` weekly external sums)
- D6 maintenance purchases (ledger row; excluded from revenue, counted in exclusions)

## Paid customer

**Definition:** Distinct wallets with ≥1 non-excluded x402 payment in the period, **or** Stripe customers with a successful charge in the period.

**Source data:**

- x402: inbound USDC to vet402 `payTo` on Base (`src/lib/kpi/payto.ts`, openapi `packages/rwa/x402.ts` `PAY_TO`); script `scripts/kpi/x402-revenue.ts`
- Stripe: approved read-only export only (C3); not wired in I0

**Exclusions:** Own wallets (`src/lib/kpi/own-payers.ts`, plus DB-backed L1 payers when reproducing with DB), refunds, testnet.

## Revenue

**Definition:** Sum of x402 receipts on-chain (verified USDC to vet402 payTo) plus Stripe cash collected.

**Source data:**

- x402 Base USDC: USDC `Transfer` logs to vet402 payTo, aggregated in `src/lib/kpi/x402-revenue.ts`. Readers, in order (`src/lib/kpi/x402-revenue-reader.ts`):
  1. Alchemy `alchemy_getAssetTransfers` when a key is configured (`src/lib/chain/alchemy.ts` `fetchAssetTransfersPage`).
  2. Base public RPC `https://base-rpc.publicnode.com`, no key: `eth_getLogs` in chunks of 50,000 blocks (Transfer topic, `to` = payTo). The window's block range is found by reading block timestamps near the target only.
  - The public RPC refuses old blocks ("Archive requests require a personal token"). Measured 2026-11-27: block 51,000,000 (2026-09-07 13:55 UTC) was readable, 50,500,000 was not. A period that starts before the retained range is `unreadable`, never zero. Freeze each month soon after it closes.
- Stripe: balance transactions / payouts export (approval required)

**Exclusions:** Inbound transfers whose `from` is in the own-payer list (C6), D6 maintenance, testnet, self-transfer. Excluded count and amount are kept in the output (`totals.excluded*`). D6 has no wallet yet, so no D6 exclusion is implemented; when D6 ships, its wallet goes into `src/lib/kpi/own-payers.ts`.

**Coverage:** I0 reads Base USDC only. The same payTo also receives USDG on Robinhood Chain (`eip155:4663`, `GET /api/v1/rwa/paid/facts`, `packages/rwa/x402.ts`), which is not read yet. The monthly document lists it in `coverage.x402NetworksNotRead`, and `revenueUsd` stays null until that list is empty.

**Period complete:** the output carries `readThroughUtc` and `periodComplete`. A month is frozen only when `periodComplete` is true.

**Unreadable rule:** If any reader call fails (HTTP error, RPC error, malformed log, retained range exceeded) for any part of the period, `readStatus: unreadable` and all totals are `null` — **not** zero revenue.

## Retention rate

**Definition:** Share of last month’s paid customers who also paid this month.

**Source:** Paid customer sets for month *M−1* and *M* (x402 wallets + Stripe customers).

## ARPU

**Definition:** Revenue ÷ paid customers (same period, same exclusion rules).

## CAC

**Definition:** (Paid acquisition spend + listing maintenance spend) ÷ new paid customers. Target 0.

**Source:** Acquisition spend ledger (mostly $0; D6 capped at 0.12 USDC/year in spec).

## Activation

**Definition:** Share of subjects with another call on a different UTC day within 7 days of their first call ever (first seen after the event log start). Subjects whose first call was in an earlier month are not counted again.

**Limit:** keyless subjects use a salt that changes every UTC day (C7), so the same keyless subject cannot be followed to another day. Activation is computed for API-key and wallet subjects only, and the document says so.

**Source:** `kpi_events` first-seen per subject (after log start).

## Discovery

**Definition:** Bazaar fixed-query ranks (10 queries), pay.sh listing presence, AI crawler UA fetches, search referrals, external badge fetches.

**Source (existing):**

- Badge fetches: `/api/v1/stats/badge-fetches`
- Referrals: `/api/v1/stats/referrals`
- Bazaar ranks: not started in I0 (I1)
- `client_usage_daily` for keyless UA/client labels (not a full discovery picture)

## Gross margin (A1)

**Definition:** Per product line: revenue − variable cost. Variable cost includes CDP fee (settlements over 1,000 per month × $0.001), Stripe fees (actual or 4.73% placeholder), verify-now seller payouts, compute placeholder ($0.0001/call until owner billing), Seller Watch add-on purchase cost (0 in current design).

**Source:** x402 inbound (above), Stripe, CDP billing (owner), verify-now on-chain outflows (future I8), config constants in repo.

**Exclusions from revenue:** D6 maintenance, first-listing self-purchase (I1, approved).

**Margin rate:** gross margin ÷ revenue. verify-now is reported on both a gross basis and a net basis (revenue minus seller payouts).

**Alert:** notify when the 7-day rolling gross margin is negative (A2). Minimum sample: 20 settlements.

## Plan metrics (P1–P8)

Includes free→paid conversion (by the feature that drove it), 402 overage counts, conversion to subscription, keyless daily-cap hits, annual plan mix, grandfathered subscriber count, Seller Watch claim→subscribe and churn.

**Source:** Stripe subscriptions (approval), future x402 overage counters (I2), `kpi_events` / usage tables. Many are **pending** until features ship.

## Competitor pricing (A3)

**Definition:** Monthly snapshot of min/median USDC price for 12 fixed Bazaar queries (seller-trust style).

**Source:** CDP discovery search API (report-only; no auto price changes).

---

## Data locations summary

| KPI area | Primary source in repo / chain |
|----------|--------------------------------|
| x402 revenue (Base USDC) | `scripts/kpi/x402-revenue.ts`, `src/lib/kpi/x402-revenue.ts` |
| Monthly KPI JSON + hash | `src/lib/kpi/monthly-document.ts` |
| Keyless usage (partial) | `client_usage_daily`, `client_usage_daily_network` |
| Keyed decision usage | `decision_usage_*` tables |
| L1 measurement (not revenue) | `x402_l1_purchases`, observatory export |
| Settlements index (market, not vet402 revenue) | `settlements`, `src/lib/settlements/` |
| Stripe | External export (C3) |
| Event log (future) | `docs/kpi-event-log.md` schema |

## PayTo addresses (Base USDC)

Canonical list: `vet402BaseUsdcPayToAddresses()` in `src/lib/kpi/payto.ts` (from `packages/rwa/x402.ts` / openapi). Additional receive addresses must be added there when openapi adds them.

## Own-payer exclusion list

Static and env-driven list: `vet402OwnPayerAddressesBase()` in `src/lib/kpi/own-payers.ts`. The static list holds the anchor/operator wallet (= payTo) and vet402's own Robinhood L1 payer `0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51` (same address on Base). DB-complete L1 payer list: `src/lib/settlements/own-wallets.ts` (`loadOwnWalletContext`) when DATABASE_URL is available for buyer replay.

---

## Monthly freeze and daily anchor (design — implementation next)

Aligned with `src/lib/observatory/monthly-freeze.ts` and `src/lib/observatory/anchors.ts`:

1. At month close, build `KpiMonthlyDocument` (JCS JSON) via `buildKpiMonthlyDocument` / `hashKpiMonthlyDocument`.
2. Store frozen row (table TBD; requires approved migration).
3. Daily anchor payload (`anchorPayloadForDay`) gains lines only **on or after** the KPI freeze `frozenAt` UTC date, and only for months whose publication time has passed (same pattern as `MONTHLY_FREEZE_ANCHOR_FROM_DAY` / `monthlyFreezeAnchorLine`).
4. Anchor line format: `kpi-freeze:v1:YYYY-MM:<sha256>` (`kpiMonthlyAnchorLine`).
5. **Past anchor roots are never rewritten**; missing freeze days stay gaps (`chainContinuity`).

Public surfaces may expose **only** the sha256 (C2), not field values.

## November 2026 partial month

If the event log is absent for November, caller-subject and activation metrics are omitted (`coverage.externalCallerSubjectSince`). November KPI files may include **on-chain x402 inbound and Stripe-derived fields only**, with explicit coverage notes—no backfilled caller subjects.