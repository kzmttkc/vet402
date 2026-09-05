# Why vet402 Should Verify Solana — and What Exists Today

> Audience: Solana Foundation / Superteam grant reviewers.
> This document separates what is measured today from what is planned. The plan is in the "Phase 1" section only; everything above it is live production fact.

## Honest status first

**vet402 now makes real purchases on Solana — and we say so with the same evidence rule we apply to Base.** Since 2026-08-21 our L1 payer has made **38 real purchase attempts on Solana mainnet**, of which **26 settled and all 26 re-read on-chain as finalized** (genesis hash checked, and the transfer's amount, asset and recipient matched the payment challenge). We are precise about which evidence tier that is: none of the 26 carries the signature-nonce binding we added on 2026-09-04, so they sit in the amount-and-recipient tier, not the strongest one. We publish the tier rather than let the word "verified" do work it has not earned; 3,203 of our 3,241 attempts to date are on Base. One caveat we publish rather than hide: the public chain breakdown in `/api/v1/observatory/state` carries no L1 fields yet, so a reviewer can see these purchases on the per-endpoint record pages but cannot yet total them from the aggregate API. Making that visible is part of what this proposal delivers.

What *does* exist today for Solana:

- **L0 liveness verification already covers Solana endpoints.** The public x402 discovery catalog we track contains **218 Solana endpoints (194 active)**, and **39 of them have a published L0 pass** — machine-verified as answering the x402 protocol correctly, no purchase involved.
- Solana is the **second-largest chain in the x402 catalog** (after Base at 22,437), and the largest that our real-purchase methodology cannot yet reach.

## The gap this creates for Solana

An AI agent looking at a Solana x402 endpoint today can know that it is listed and (for 39 endpoints) that it answers correctly. It cannot know whether **payment actually settles and a response actually arrives** — the question that matters before an autonomous agent spends money. On Base, vet402 answers that question with published evidence: settlement tx hashes for successes, and non-settling attempts published with the same weight. Solana sellers who fulfill honestly have no independent way to prove it; Solana buyers have no independent way to check.

As SOL-402-style agent payments grow, this gap grows with them. Payment rails prove that *payment happened*; they do not prove that *the seller delivered*. That proof requires an independent party that actually buys — and publishes failures as readily as successes.

## Phase 1 plan: extend real-purchase verification to Solana

Scope (plan, not an accomplishment):

1. **Solana settlement support in the L1 payer** — pay Solana x402 endpoints with USDC (SPL) through their declared facilitator/scheme, mirroring the Base flow: budget-capped, one payment per attempt, no retries that could double-spend.
2. **Same evidence standard** — every settled Solana purchase published with its transaction signature on the endpoint's public observatory page; every non-settling attempt published with the same weight. Results never move up a level (an L0 probe is never reported as settlement).
3. **Same neutrality standard** — verification is unsolicited and free; measured operators are not customers; corrections logged on the public accuracy ledger.
4. **Chain-split reporting** — the aggregate state API already reports per-chain figures (`byChain`, mainnet-only); Solana L1 figures would appear there from day one, publicly and machine-readably.

What we ask reviewers to evaluate is not a promise of future traction but a **method that is already running in production on another chain**, applied to Solana: the catalog tracking, daily snapshots (latest: 2026-09-04, 16,260 endpoints fetched), lifecycle events (8,013 delists, 1,142 relists recorded), the L0→L1 pipeline, and the publish-everything evidence standard are all live and inspectable now.

## Why this team

- The observatory is in production and public: <https://vet402.com/observatory/state> (human) / <https://vet402.com/api/v1/observatory/state> (JSON).
- The methodology is published: <https://vet402.com/observatory/methodology>.
- We already track Solana at L0 — the extension is settlement, not a cold start.
- Everything is verifiable without trusting us: tx hashes on-chain, catalog snapshots dated, corrections public.

---

*Figures retrieved from /api/v1/observatory/state on 2026-09-05. Regenerate before every submission: `python3 scripts/grant-figures.py --check`.*
