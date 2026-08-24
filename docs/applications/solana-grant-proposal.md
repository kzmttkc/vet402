# Grant Proposal — Extending Real-Purchase Verification of the x402 Economy to Solana

> Program: Solana Foundation Grants (or Superteam grant track — final program to be set at submission)
> Applicant: vet402 — independent verification of the x402 agent-payment economy
> Site / live data: <https://vet402.com> · JSON: <https://vet402.com/api/v1/observatory/state>
> Entity: [LEGAL ENTITY / INDIVIDUAL — fill at submission]
> Contact: [EMAIL — fill at submission]
> **Requested amount: USD 5,907.75** (cost-basis itemized below; no rounding, no padding)
>
> *All figures in this document were measured on 2026-08-20. Reproduction commands are included so reviewers can re-measure everything without trusting us.*

## 1. Summary

vet402 buys what x402 endpoints actually sell — real USDC purchases — verifies that payment settles and a response arrives, and publishes every result with evidence: settlement transaction hashes for successes, non-settling attempts published with the same weight. This methodology is live in production on Base mainnet today: **845 real purchase attempts, 341 settled, every one published** ([/observatory/state](https://vet402.com/observatory/state)).

This grant extends the same real-purchase verification to **Solana mainnet**, where the x402 catalog already lists the second-largest endpoint population (218 tracked, 194 active) and where no independent party today can tell an agent whether a Solana x402 endpoint actually delivers after payment.

Two things make this request unusual:

1. **The requested amount is an itemized cost basis, not a rounded ask.** Every line below is computed from a live measurement or a published price list, with the retrieval date and a reproduction command. Total: **$5,907.75** for 12 months.
2. **Zero dollars are requested for labor.** vet402 is operated by an AI-run organization; there are no salaries in this budget. The request is purchase capital (spent on-chain, auditable transaction-by-transaction after the fact) plus infrastructure at list price.

## 2. What exists today (measured, pre-grant, no grant funds involved)

Retrieved 2026-08-20 from `https://vet402.com/api/v1/observatory/state` (key-less; reviewers can run the same `curl`):

| Metric | Value |
|---|---|
| Endpoints tracked in the public x402 catalog | 17,722 (15,021 active, 2,701 delisted) |
| L0 machine-verified pass (probe, no purchase) | 988 published |
| L1 real purchases | 845 attempts across 843 endpoints — 341 settled, all on Base mainnet, each with its tx hash; the non-settles published with the same weight |
| Lifecycle events recorded | 2,887 delists · 186 relists · 3 settle-drops |
| Daily catalog snapshot | latest 2026-08-20, 15,011 endpoints fetched |
| **Solana in the catalog** | **218 endpoints tracked (194 active) — second-largest chain after Base (17,313)** |
| **Solana L0 (probe-level) verification** | **40 published pass — already running, chain-agnostic, $0** |

Also live: per-chain aggregates (`byChain` in the state API), daily per-chain history (`/api/v1/observatory/history`), per-endpoint purchase evidence pages, a public accuracy/corrections ledger (<https://vet402.com/accuracy>), and MIT-licensed tooling (`@vet402/sdk`, `@vet402/middleware`, `@vet402/mcp-server` on npm).

**Honest status: vet402 does not settle real purchases on Solana today.** All 845 L1 attempts to date used the x402 `exact` scheme with EIP-3009 USDC on Base. A Solana payer implementing the official SVM exact scheme (`scheme_exact_svm.md`: partially-signed versioned transaction, facilitator fee-payer, TransferChecked + Memo) has been written and unit-verified against the spec's MUSTs, but it is **not deployed and holds no funds** — it ships behind a default-off flag, pending exactly the funding this proposal requests.

### 2.1 A measurement nuance we want reviewers to see before we fix it

The public history API attributes purchases to the chain the catalog row *declares*, not the chain the payment *settled on*. Some Solana-declared endpoints also offer a Base payment option, which our Base payer used — so `/api/v1/observatory/history` already shows small `l1Settled` counts under `solana:…` days **even though every settlement was on Base rails**. We are disclosing this ourselves because our whole product is not letting measurements say more than they mean. Milestone 1 includes fixing the public attribution to settlement-chain, so that "Solana settled" in our data can only ever mean *settled on Solana*.

## 3. Why Solana, why us

An AI agent looking at a Solana x402 endpoint today can know it is listed, and (for 40 endpoints) that it answers the protocol correctly. It cannot know whether **money sent actually settles and a response actually arrives** — the only question that matters before an autonomous agent spends. Payment rails prove payment happened; they do not prove the seller delivered. That proof requires an independent party that actually buys — and publishes failures as readily as successes.

We are not proposing to build this methodology; it is running in production on another chain. The catalog tracking, daily snapshots, L0→L1 pipeline, budget-guarded payer, evidence pages, and the publish-everything standard all exist and are publicly inspectable. The grant funds the *purchase capital and infrastructure* to run it on Solana — not its invention.

Neutrality standard (unchanged on Solana): verification is unsolicited and free; measured operators are not customers; sellers cannot pay for a better result; corrections are logged publicly.

## 4. The cost basis (every number measured, with reproduction path)

### 4.1 Solana purchase budget — from the actual price distribution

On 2026-08-20 we fetched the complete public x402 discovery catalog (CDP Bazaar, `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources`, 15,034 of 15,035 rows fetched, paged at limit=100 — public, key-less; any reviewer can repeat this). Solana mainnet rows (`network = solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`): **192**, of which 191 price in USDC (mint `EPjFW…Dt1v`, 6 decimals) and 1 in USDT.

Measured USDC price distribution across the 191 priced Solana endpoints:

| min | p10 | p25 | median | p75 | p90 | max |
|---|---|---|---|---|---|---|
| $0.001 | $0.002 | $0.005 | $0.010 | $0.030 | $0.150 | $20.60 |

106 of 191 endpoints price at or below $0.01; 171 of 191 at or below $0.10. Our production payer enforces a **$1.00 per-purchase cap** (default `MAX_PER_PURCHASE_UNITS` = 1,000,000 USDC base units) and a **$25/day budget** reserved atomically in the ledger before signing — both already enforced in code on Base, applied unchanged to Solana. Under the $1 cap, **186 of the 191 endpoints are purchasable**, and one full sweep of all 186 costs:

> **Σ(prices ≤ $1.00) = $7.247 per full catalog sweep** (5 endpoints above cap excluded: $2.00, $2.50, $5.00, $10.00, $20.60)

Proposed cadence: one purchase per active endpoint per day (the per-endpoint daily dedup already enforced by the runner), i.e. a daily full sweep:

> **$7.247/day × 365 days = $2,645.16 / year** — the baseline purchase budget.

For comparison: our measured Base spend over the last 7 days (public history API, 2026-08-14 → 2026-08-20) was 804 attempts, $29.71, i.e. **$0.0370 per attempt actual** — consistent with the Solana in-cap mean of $0.039.

**Growth allowance (conditional):** the Solana x402 catalog will not stay at 192 rows if agent payments on Solana grow — which is the premise of this grant. We request an equal second tranche, **$2,645.16**, that is only spent if and as the Solana catalog grows beyond today's size at the same cadence. Every cent of both tranches lands on-chain from a published verifier wallet: actual-vs-budget is auditable to the transaction after the fact (CSV export: `/api/v1/observatory/export.csv`), and unspent purchase budget is reported and returnable at the program's preference.

### 4.2 RPC — Helius, at public list price

Source: <https://www.helius.dev/pricing>, retrieved 2026-08-20.

- Free: $0/mo — 1M credits, 10 RPC req/s, **1 sendTransaction/s**, no staked connections.
- **Developer: $49/mo — 10M credits, 50 RPC req/s, 5 sendTransaction/s.**

At baseline volume (≈186 purchases/day plus confirmation polling) the free tier's credit allowance would arithmetically suffice, but 1 sendTransaction/s and no staked connections is not a defensible floor for a service whose published claims ("this endpoint's payment did not settle") must never be an artifact of our own transaction not landing. We budget the cheapest paid tier:

> **$49/mo × 12 = $588.00 / year.**

### 4.3 Network fees — mostly sponsored; self-paid path costed anyway

The SVM exact scheme places the fee payer with the **facilitator** (`extra.feePayer`), so in the standard flow vet402 pays no SOL. Our v0 payer fails closed: challenges without a sponsoring fee payer are skipped and recorded, not paid. For the follow-on path where we self-pay fees to reach non-sponsored endpoints:

> 186 tx/day × 365 = 67,890 transactions × 5,000 lamports base fee = **0.33945 SOL ≈ $29.43** (SOL at $86.70, CoinGecko 2026-08-20). Priority fee at our payer's ceiling (5 microlamports/CU, ≈30k CU) adds < 0.0001 SOL/year — negligible.

### 4.4 What we are NOT asking for

- **Development / salaries: $0.** The organization that built and operates the Base verification pipeline is AI-run; no human labor is billed. This is the structural reason a full verification-chain extension can be requested for under $6k.
- **Hosting / database: $0.** Current production runs within existing infrastructure whose measured incremental cost for Solana volume is zero; we absorb it.
- **Marketing: $0** — by policy. We sell nothing on the catalog we measure (neutrality).

### 4.5 Budget table

| Category | Basis of estimate (measured / quoted, with date) | Amount |
|---|---|---|
| L1 purchase budget — baseline | Live catalog fetch 2026-08-20: 186 in-cap Solana endpoints, Σ = $7.247/sweep × 365 daily sweeps | $2,645.16 |
| L1 purchase budget — growth allowance | Same cadence applied to catalog growth; spent only as growth materializes; on-chain auditable; unspent returnable | $2,645.16 |
| RPC | Helius Developer, public list price 2026-08-20, $49/mo × 12 | $588.00 |
| Network fees (self-paid path; standard flow is facilitator-sponsored) | 67,890 tx × 5,000 lamports = 0.33945 SOL @ $86.70 (2026-08-20) | $29.43 |
| Hosting / DB / development / marketing | measured $0 · absorbed / not billed / excluded by policy | $0.00 |
| **Total (12 months)** | | **$5,907.75** |

## 5. Milestones — every acceptance check runnable by the reviewer

| # | Milestone | Deliverable | Acceptance check (no trust required) | Duration | Amount |
|---|---|---|---|---|---|
| M1 | Solana settlement live | SVM exact-scheme payer enabled in production; first real Solana settlements published; history/state attribution fixed to settlement-chain (§2.1) | `curl -sL https://vet402.com/api/v1/observatory/state` shows a Solana `byChain` entry with L1 fields and `settled > 0`; a published purchase page shows a **base58 transaction signature** (not a 0x hash) resolvable on Solscan/Solana Explorer | 2 weeks | $63.49 |
| M2 | Full-catalog Solana coverage | Every active in-cap Solana endpoint attempted at least once; per-endpoint evidence pages live; non-settles published with equal weight | Solana `byChain` attempted-endpoints count ≥ active in-cap count on the day of review; `/api/v1/observatory/endpoints/{id}/purchases` returns rows incl. `settle_failed` for Solana endpoints | 4 weeks | $251.92 |
| M3 | 12-month sustained operation | Daily sweep cadence; Solana settle-drop lifecycle detection; monthly public actual-vs-budget report with tx-level CSV | `/api/v1/observatory/history` shows sustained Solana `l1Attempts` day over day; `/api/v1/observatory/export.csv` contains the full Solana purchase ledger; monthly reports link every figure to the live API | months 2–12 | $5,592.34 |

Amounts allocate the budget table to milestone periods (M1: first RPC month + 2 sweeps; M2: second RPC month + 28 sweeps; M3: remainder incl. growth allowance and fee float). Reporting cadence: monthly, public-first — figures come from the live API, settlements from on-chain signatures, corrections (if any) on <https://vet402.com/accuracy>.

## 6. Reproduction appendix

```bash
# Aggregate state (all headline figures above)
curl -sL https://vet402.com/api/v1/observatory/state

# Daily per-chain history incl. the §2.1 attribution nuance
curl -sL "https://vet402.com/api/v1/observatory/history?days=60"

# Solana price distribution: page the public catalog and filter
# accepts[0].network == "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
curl -sL "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=100&offset=0"
# … offset += 100 until pagination.total (15,035 on 2026-08-20)

# Helius pricing
open https://www.helius.dev/pricing
```

---

*Prepared 2026-08-20. Every figure herein is either a same-day live measurement (retrieval noted inline) or a public list price (URL noted inline). Refresh all figures on the day of submission per house rule.*
