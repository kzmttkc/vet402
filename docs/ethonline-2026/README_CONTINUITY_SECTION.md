# README section — to be pasted into README.md at submission time (2026-09-13)

> Prepared 2026-08-22. The "Built during the window" list is the committed scope;
> wording is finalized when the work actually exists. Do NOT paste into README before
> the items are real (the README must never claim work that has not happened).

## ETHOnline 2026 Continuity Work

vet402 is submitted to the **ETHOnline 2026 Continuity Track**. This section states
exactly what existed before the hackathon window (2026-09-04 00:00 UTC) and what was
built during it, so judges can verify the boundary from git history alone.

### Existed before the window (not part of the submission)
- The x402 Observatory: daily L0 probes over the public catalog, L1 real-purchase
  pipeline with an atomic daily budget, L2 conformance check, public receipt pages,
  hash-chained ledger (`/api/v1/observatory/anchors`), decisions feed, CSV export.
- Scoring engine and verdict bands (ALLOW ≥70 / WARN 40–69 / BLOCK <40, fail-closed
  SpendGuard in `@vet402/sdk`), MCP server `vouch-trust` with `check_*` /
  `explain_trust_score` / `attest_x402_payment` tools, Python SDK, framework adapters
  under `examples/`.
- Everything on `main` at tag `pre-ethonline-2026` (created 2026-09-03).

### Built during the window (the submission)
1. **`payOrRefuse` — a pay-or-refuse primitive in the SDK**: one call that evaluates
   the payee through SpendGuard, and if — and only if — the verdict is ALLOW, performs
   the x402 `exact` payment and attests the settlement back to vet402. Any non-ALLOW
   verdict refuses before signing and returns machine-readable reasons.
2. **MCP tool `pay_if_trusted`** exposing the same primitive to MCP-native agents; the
   payment path is structurally unreachable on BLOCK/WARN.
3. **Agent-originated decision feed**: demo agent decisions (refusals and payments)
   stream into the existing public `/decisions` register with `source: agent-demo`.
4. **Live demo agent + scenarios** (`examples/ethonline-2026-agent/`): two scenarios —
   low-trust endpoint → BLOCK → no payment; high-trust endpoint → ALLOW → real x402
   payment with on-chain receipt.

### Boundary definition
**Anything reachable on `main` before tag `pre-ethonline-2026` is pre-existing.**
All hackathon work lives on branch `ethonline-2026` (merged to `main` at submission),
every commit is dated inside the window and prefixed `ethonline:`. No pre-existing
file is counted as new work; edits to pre-existing files during the window are listed
in `docs/ethonline-2026/CHANGED_FILES.md`.
