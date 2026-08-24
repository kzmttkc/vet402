# x402 Foundation / ecosystem (optional track)

Vouch’s default GTM is **parallel channels**: direct API, MCP, dashboard, and the x402 trust-gate sample.  
Participation in x402 Foundation RFCs/PRs (for example Dominions / gate hooks) is **one optional distribution channel**, not a product dependency.

## What to pitch (if engaging)

1. **Problem:** x402 proves *payment*; it does not prove *payer trust* (sybil, burner wallets, thin ERC-8004 history).
2. **Fit:** After payment verification, call Vouch `GET /v1/wallets/{payer}/score` before serving the paid route; optionally `POST /v1/payments/x402` so settlement history strengthens future scores.
3. **Artifacts:** [x402-integration.md](./x402-integration.md), [openapi.yaml](./openapi.yaml), `examples/x402-trust-gate`, `@vet402/sdk`.

## What not to do

- Do not gate the product roadmap on a single Foundation PR merging.
- Do not open anonymous free scoring to chase Foundation visibility.
- Do not overstate Dominion / on-chain safety gateway features that are Phase 2.

## Status

Optional outbound only. Prefer shipping integrator UX (SDK / MCP / dashboard) first; open a Foundation comment or PR when there is a concrete hook and real settlement volume.
