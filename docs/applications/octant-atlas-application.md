# Octant (Atlas) — application content, ready to paste

> Status 2026-08-26: **blocked on an invitation code.** Atlas is a closed beta —
> *"During beta testing, Atlas is available only to selected partners. You will need an invitation
> code from the Octant team."* ([docs](https://docs.octant.app/docs/projects/apply-for-funding/)).
> Asked publicly from @vet_402 on 2026-08-25 22:29 UTC (<https://x.com/vet_402/status/2092378959124242606>).
> Second channel — the Octant Discord — is an owner task (`TAKESHI_TODO`), because this account cannot sign in there.
>
> **Why this program**: Octant Epoch 12 (200 ETH pool, 25 projects) funded **L2BEAT** — *"impartial
> watchdog … open-source research and analytics"* — and **growthepie** — *"open analytics … free to
> access and transparent"*. That is our species exactly: independent public measurement that sells
> nothing to what it measures. Elsewhere our neutrality costs us revenue; here it is the qualification.
>
> Refresh every figure on submission day: `python3 scripts/grant-figures.py`.

## One-sentence pitch

The public record of whether x402 endpoints actually deliver after an agent pays them — bought with real money, published with the receipts, failures included.

## Description (4 paragraphs)

Agents can now pay for things over HTTP. The x402 catalog we track holds 19,023 endpoints, 18,363 of them on Base. Nobody was checking whether paying one gets you anything. Directory listings say what a seller claims to sell; uptime probes say a server answered. Neither tells an agent — or the person who funded that agent's wallet — whether money moves and a real response comes back.

vet402 answers that by buying. We make real USDC purchases on Base mainnet through the x402 `exact` scheme, verify each settlement against the chain rather than the seller's word, and publish every attempt with its evidence: 1,596 purchases to date, 653 settled, each with its transaction hash on its endpoint's public page — and the non-settling attempts on those same pages, with the same weight. A verification layer that only publishes wins is an advertising layer.

Everything is checkable without trusting us. The aggregate state is public JSON with no key (`/api/v1/observatory/state`), the methodology is published, daily catalog snapshots are dated, our own corrections live on a public accuracy ledger, and the SDK, middleware and MCP server are MIT-licensed on npm. Four measurement levels stay strictly separated, and a result never moves up a level: a probe is never reported as a settlement, an opinion is never folded into a fact.

The structure is deliberately unsellable to the thing it measures. We sell nothing on the catalog; measured operators are not customers; no seller can pay for a better result or for removal. That makes the dataset a public good rather than a product, and it is why the running cost — the purchases themselves — has to come from somewhere other than the market we observe.

## Category / stage

Category: public goods — data & analytics / infrastructure for agent payments.
Stage: live in production since 2026-08, measuring daily, MIT-licensed, used by no gatekeeper.

## Funding goal (USD)

**$3,367.13** — twelve months of L1 purchase capital at a widened sweep.

Cost basis, measured 2026-08-26 from our own ledger (`x402_l1_purchases`): 1,632 real purchases, $60.23 spent, **$0.0369 per attempt**. Target volume 250 attempts/day × 365 days × $0.0369 = $3,367.13. We run about 100/day today; the gap is coverage — our 7-day L0 coverage of active endpoints is 18.1%, and only 957 endpoints have ever been bought from.

Labor is $0: the operation is run by AI agents under a human owner, disclosed in full (`ai-usage-disclosure.md`). Infrastructure runs on free tiers today and is not in this ask. Every dollar lands on-chain from a published verifier wallet, so actual-versus-budget is auditable to the transaction after the fact (`/api/v1/observatory/export.csv`). Unspent purchase capital is reported and returnable.

## How the funding is used

1. **Widen the sweep** from ~100 to 250 purchases/day, prioritising endpoints never bought from — the denominator nobody has published.
2. **Keep failures visible.** Every non-settling attempt costs the same money as a settling one and gets the same page. This is the part no vendor will fund.
3. **Publish the chain breakdown** so builders can see settle-through per chain, not one blended number.

Acceptance is checkable by a reviewer, without us: `curl https://vet402.com/api/v1/observatory/state` shows `l1.attempts` rising with `endpointsAttempted`; any settled row resolves on Basescan.

## Links

- Site: <https://vet402.com> · 60-second demo: <https://vet402.com/demo>
- Observatory: <https://vet402.com/observatory> · Public JSON: <https://vet402.com/api/v1/observatory/state>
- Methodology: <https://vet402.com/observatory/methodology> · Accuracy ledger: <https://vet402.com/accuracy>
- Code (MIT): `@vet402/sdk`, `@vet402/middleware`, `@vet402/mcp-server` on npm
