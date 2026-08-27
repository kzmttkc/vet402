# Octant — application content (intake **SUBMITTED 2026-08-27**)

> **2026-08-26, @nicnode (Nico Gallardo, Octant) replied on X: "There's no need for an invitation code
> for Atlas."** The Atlas closed-beta gate we planned around does not apply; the routes are the
> Epoch 13 form and the general intake form, both at <https://octant.build/projects>.
>
> **Epoch 13 — we are not applying.** Its theme is *"advancing privacy on Ethereum and the open
> internet"* (100 ETH pool, opens 2026-10-14). vet402 is measurement, not privacy. Dressing it up as a
> privacy project would burn a relationship we just opened, and it is the exact move our own grant
> canon forbids.
>
> **General intake form submitted 2026-08-27** (octant.fillout.com/t/qU367QpkKPus — email-verified).
> Content below is what was sent, with figures measured that day. Do not refresh them.
>
> **Next**: watch for a round or program whose theme is measurement / agent-payment infrastructure.
> Octant publishes new epochs on X (@OctantApp) and Substack first. Ask asked-and-answered: no invite needed.

## One-sentence pitch

The public record of whether x402 endpoints actually deliver after an agent pays them — bought with real money, published with the receipts, failures included.

## Description (4 paragraphs)

Agents can now pay for things over HTTP. The x402 catalog we track holds 19,442 endpoints, 18,953 of them on Base. Nobody was checking whether paying one gets you anything. Directory listings say what a seller claims to sell; uptime probes say a server answered. Neither tells an agent — or the person who funded that agent's wallet — whether money moves and a real response comes back.

vet402 answers that by buying. We make real USDC purchases on Base mainnet through the x402 `exact` scheme, verify each settlement against the chain rather than the seller's word, and publish every attempt with its evidence: 1,596 purchases to date, 697 settled, each with its transaction hash on its endpoint's public page — and the non-settling attempts on those same pages, with the same weight. A verification layer that only publishes wins is an advertising layer.

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
