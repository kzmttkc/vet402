# Why Base Is vet402's Home Chain

> Audience: Base ecosystem grant reviewers (Base Builder Grants and similar).
> Everything in the "Measured" sections is live production data; sources and retrieval date at the bottom.

## What vet402 is, in three sentences

vet402 is an independent verification layer for the x402 agent-payment economy. We buy what x402 endpoints actually sell — real USDC payments on Base mainnet — verify fulfillment against the seller's own declaration, and publish every result with evidence: settlement tx hashes for successes, and the non-settling attempts published with the same weight. We sell nothing on the catalog we measure.

## Base is not a chain we chose. It is where the measurements happen.

### Measured: the x402 catalog lives on Base

Of the 19,881 endpoints vet402 tracks in the public x402 discovery catalog, **19,375 are on Base mainnet** (mainnet-only chain breakdown) — 14,098 of them currently active, and 98.5% of every mainnet endpoint we track. The next-largest chain, Solana, has 272. Base is not one option among many for x402 today; it is the market.

| Chain (mainnet) | Endpoints tracked | Active | L0 published pass |
|---|---|---|---|
| **Base** | **19,375** | **14,098** | **1,437** |
| Solana | 272 | 220 | 42 |
| X Layer | 18 | 13 | 3 |
| All others combined | 6 | 5 | 1 |

### Measured: every real purchase we have made settled on Base

Our L1 verification level makes **real purchases**: 1,855 purchase attempts across 1,068 distinct endpoints, of which 808 settled (43.6%). Every one of those attempts was a USDC payment on Base mainnet (`eip155:8453`), using the x402 `exact` scheme with EIP-3009 transfer authorization. Every settled purchase produces a Base transaction hash, published on the endpoint's public observatory page. The 1,047 attempts that did not settle are published too — same page, same weight.

This is, to our knowledge, the only public dataset of *settle-through* rates for the x402 catalog: not "does the endpoint answer" but "does money actually settle and a response actually arrive."

### Measured: we watch the Base x402 catalog change daily

Daily catalog snapshots (latest: 2026-08-29, 14,470 endpoints fetched) drive a lifecycle event stream: 6,029 delist events, 630 relists, and 11 settle-drops recorded to date. 5,399 endpoints are currently delisted. Agents and builders on Base can see not just what exists, but what disappeared.

## What this does for Base

1. **Buyer confidence in the Base agent economy.** An agent (or its operator) deciding whether to pay a Base x402 endpoint can check independent, evidence-backed data — settle-through history with tx hashes — instead of paying blind.
2. **A quality signal for Base sellers.** Endpoints with verified settlement history can display it (public observatory pages and an embeddable badge API, live at `/api/badge/endpoint/{id}`). Verification is free and unsolicited; sellers cannot pay us for a better result.
3. **Ground truth about the catalog.** "19,881 listed" and "14,482 active with 1,497 machine-verified live" are different numbers. Publishing the denominator makes the Base x402 ecosystem legible to builders, researchers, and reviewers — including the failures.

## Neutrality commitments

- We sell nothing on the catalog we measure; measured operators are not customers.
- Results never move up a level: an L0 probe is never reported as settlement; opinions (L3) are never folded into facts (L0–L2).
- Corrections to our own published data are logged publicly (accuracy ledger at `vet402.com/accuracy`).

## Links

- Live site: <https://vet402.com>
- Live aggregate state (JSON): <https://vet402.com/api/v1/observatory/state>
- Methodology: <https://vet402.com/observatory/methodology>
- Accuracy ledger: <https://vet402.com/accuracy>

---

*Figures retrieved from /api/v1/observatory/state on 2026-08-29. Regenerate before every submission: `python3 scripts/grant-figures.py --check`.*
