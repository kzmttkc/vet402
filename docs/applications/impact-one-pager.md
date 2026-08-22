# vet402 — One-Page Summary

**Independent verification of the x402 agent-payment economy.**
*We buy. We settle. We publish the measurements.*

<https://vet402.com> · JSON: <https://vet402.com/api/v1/observatory/state> · Methodology: <https://vet402.com/observatory/methodology>

## What it does

vet402 buys what x402 endpoints actually sell — real USDC purchases on Base mainnet — verifies fulfillment against the seller's own declaration, and publishes every result with evidence: settlement tx hashes for successes, non-settling attempts published with the same weight. Four strictly separated levels:

| Level | Question | How |
|---|---|---|
| L0 | Does the endpoint answer correctly? | Probe, no purchase |
| L1 | Does payment settle and a response arrive? | **Real purchase** |
| L2 | Does the response match the seller's own declaration? | Purchase + machine diff |
| L3 | Is the content any good? | Published rubric — opinion, never mixed with L0–L2 |

A result never moves up a level: a probe is never reported as settlement; an opinion is never folded into a fact.

## Who it is for

- **AI agents and their operators** deciding whether to pay an endpoint — before paying, not after.
- **Honest x402 sellers** who want independent, evidence-backed proof of delivery (public observatory page + embeddable badge).
- **Ecosystem builders and researchers** who need denominators about the x402 catalog, not vendor claims.

## Measured, in production (live figures)

| Metric | Value |
|---|---|
| Endpoints tracked in the public x402 catalog | 18,372 (15,113 active, 3,259 delisted) |
| L0 machine-verified pass | 1,038 published (17,334 not machine-checkable — "unverified", not dead) |
| **L1 real purchases** | **1,133 attempts across 865 endpoints — 496 settled**; every settlement published with its Base tx hash; the 637 non-settles published with the same weight |
| Lifecycle events recorded | 3,534 delists · 275 relists · 3 settle-drops |
| Daily catalog snapshot | Latest 2026-08-22 — 15,100 endpoints fetched |
| Chain coverage | Base 17,941 · Solana 218 · X Layer 18 · others 6 (mainnet-only breakdown; real purchases are Base-only today) |

## What is different

1. **Ground truth by purchase.** The only way to know if an endpoint delivers is to buy from it. We do, with real money, and publish the receipt.
2. **Failures carry equal weight.** Non-settling attempts are published on the same public pages as successes. Verification that hides failures is advertising.
3. **Structural neutrality.** We sell nothing on the catalog we measure. Verification is unsolicited and free; measured operators are not customers; sellers cannot pay for a better result. Our own corrections are public (<https://vet402.com/accuracy>).
4. **Everything is independently checkable.** Tx hashes on-chain, snapshots dated, aggregate state as public JSON, methodology published, SDK/middleware/MCP server open-source (MIT, `@vouchscore/*` on npm).

## Stack

Next.js (App Router) + TypeScript · viem (Base mainnet) · ERC-8004 identity & reputation reads · Drizzle + PostgreSQL · x402 `exact` scheme, EIP-3009 USDC payer.

---

*Figures retrieved from /api/v1/observatory/state on 2026-08-23. Regenerate before every submission: `python3 scripts/grant-figures.py --check`.*
