# The Agent-Payment Economy Needs an Independent Verification Layer

> Audience: Ethereum-ecosystem grant and hackathon reviewers (ETHGlobal tracks, public-goods programs).
> Thesis document. Claims about vet402's own operation are backed by live production data; sources and retrieval date at the bottom.

## The structural problem: agents pay before they know

x402 revived HTTP 402 as a payment handshake: an agent hits an endpoint, receives a payment challenge, pays (USDC today, on Base mainnet primarily), and gets the response. This made machine-to-machine commerce fast — and blind:

- **Payment proof is not fulfillment proof.** The rail proves the money moved. It proves nothing about whether the seller delivered what it declared.
- **The buyer is software.** An autonomous agent cannot "feel" that a service looks scammy, and after paying a non-delivering endpoint there is no chargeback.
- **The catalog is churning.** In the public x402 discovery catalog we track, 19,023 endpoints have appeared; 3,772 are currently delisted; our lifecycle stream has recorded 4,135 delist events and 363 relists. What an agent found yesterday may be gone — or replaced — today.
- **Most of the catalog is not machine-checkable.** Of the tracked endpoints, only 1,246 currently have a machine-verified L0 pass; 17,777 are "unverified" — which means *not machine-checkable*, not dead. Nobody knew this denominator before someone measured it.

Reputation systems that rely on self-reported reviews or stake do not close this gap, because the only ground truth for "does this endpoint deliver?" is **actually buying from it**.

## What an independent verification layer must look like

From operating one in production, we argue it needs four properties:

1. **It buys.** Real settlement with real money, not synthetic probes alone. vet402's L1 level has made 1,596 real purchase attempts across 1,005 endpoints; 653 settled. Each settled purchase is published with its on-chain tx hash.
2. **It publishes failures with the same weight.** The 943 attempts that did not settle are on the same public pages as the successes. A verification layer that only publishes wins is an advertising layer.
3. **It is structurally neutral.** vet402 sells nothing on the catalog it measures; measured operators are not customers; verification is unsolicited and free; sellers cannot pay for a better result. Our own published mistakes are corrected on a public accuracy ledger.
4. **It separates fact from opinion, permanently.** Four levels — L0 liveness (probe), L1 settle-through (real purchase), L2 conformance (machine diff against the seller's own declaration), L3 quality (published rubric) — and a result never moves up a level. An opinion is never laundered into a fact.

## Why this is Ethereum-ecosystem infrastructure

- **The agent economy being built on Ethereum rails needs a trust primitive that composes.** ERC-8004 gives agents on-chain identity and reputation registries; x402 gives them payments. vet402 supplies the missing input — evidence-backed fulfillment data — consumable by any gate, firewall, or router as a plain HTTP API, and displayable by sellers via an embeddable badge. (vet402 reads ERC-8004 identity/reputation registries on Base in its scoring engine today.)
- **It is a public good in the strict sense.** The observatory's aggregate state is public JSON (`/api/v1/observatory/state`), the methodology is published, daily catalog snapshots are dated (latest: 2026-08-25, 15,239 endpoints fetched), and every settlement claim is independently checkable on-chain. Nobody needs to trust us: they can verify.
- **It makes the ecosystem legible.** Researchers, builders, and reviewers get denominators — active vs. listed, settled vs. attempted, delisted vs. live — instead of vendor claims.

## What we are *not* claiming

- We do not claim the trust score is ground truth — scores are estimates and are labeled as such, banded and never mixed into L0–L2 facts.
- We do not claim ecosystem adoption we don't have. What exists is a running, public, evidence-publishing measurement operation; adoption is the work ahead.

## Links

- Live: <https://vet402.com> · JSON state: <https://vet402.com/api/v1/observatory/state>
- Methodology: <https://vet402.com/observatory/methodology> · Accuracy ledger: <https://vet402.com/accuracy>
- Open-source (MIT): SDK / x402 middleware / MCP server published as `@vet402/*` on npm

---

*Figures retrieved from /api/v1/observatory/state on 2026-08-26. Regenerate before every submission: `python3 scripts/grant-figures.py --check`.*
