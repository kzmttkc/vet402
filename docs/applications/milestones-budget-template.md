# Milestones & Budget — Application Template

> Internal template. Copy into a specific application and fill the `[ ]` placeholders.
> Rules: (1) amounts are **never** invented — leave `[AMOUNT]` until the actual cost basis is computed from real quotes/usage; (2) the "Already delivered" section may contain **measured facts only** — anything not yet true goes under "Proposed milestones"; (3) each milestone needs a verifiable acceptance check a reviewer can run without trusting us.

## Applicant

- Project: vet402 — independent verification of the x402 agent-payment economy
- Site / live data: <https://vet402.com> · <https://vet402.com/api/v1/observatory/state>
- Entity: [LEGAL ENTITY / INDIVIDUAL]
- Contact: [EMAIL]
- Requested amount: [TOTAL AMOUNT + CURRENCY]
- Program: [PROGRAM NAME]

## Already delivered (pre-grant, measured — no grant funds involved)

*Update these numbers from the live API on the day of submission and restate the retrieval date.*

- Public x402 catalog tracking: 18,372 endpoints (15,113 active); daily snapshots (latest 2026-08-22, 15,100 fetched)
- L0 machine verification: 1,038 published pass
- L1 real purchases: 1,133 attempts / 496 settled, every settlement published with its Base tx hash; non-settles published with the same weight
- Lifecycle event stream: 3,534 delists, 275 relists, 3 settle-drops
- Open-source (MIT): `@vet402/sdk`, `@vet402/middleware`, `@vet402/mcp-server` on npm

## Proposed milestones

| # | Milestone | Deliverable | Acceptance check (reviewer-verifiable) | Duration | Amount |
|---|---|---|---|---|---|
| M1 | [NAME] | [WHAT SHIPS] | [URL / command / on-chain evidence a reviewer can check] | [WEEKS] | [AMOUNT] |
| M2 | [NAME] | [WHAT SHIPS] | [CHECK] | [WEEKS] | [AMOUNT] |
| M3 | [NAME] | [WHAT SHIPS] | [CHECK] | [WEEKS] | [AMOUNT] |

Example acceptance checks (style to imitate): "`curl -sL https://vet402.com/api/v1/observatory/state` returns a non-zero `settled` count under a `Solana` byChain entry" · "endpoint page X displays a settlement tx signature resolvable on [EXPLORER]".

## Budget breakdown

| Category | Basis of estimate (quote / measured usage — cite it) | Amount |
|---|---|---|
| L1 purchase budget (real payments made during verification) | [MEASURED AVG COST PER ATTEMPT × PLANNED ATTEMPTS] | [AMOUNT] |
| Infrastructure (RPC, DB, hosting) | [CURRENT MONTHLY MEASURED COST × MONTHS] | [AMOUNT] |
| Development | [BASIS] | [AMOUNT] |
| Audit / security review | [QUOTE] | [AMOUNT] |
| Contingency | [%] | [AMOUNT] |
| **Total** | | **[AMOUNT]** |

Notes:
- The L1 purchase budget line is spent on-chain and is therefore fully auditable after the fact; we can report actual spend vs. budget with tx-level granularity.
- No funds are requested for marketing spend on the catalog we measure (neutrality: measured operators are not customers).

## Reporting

- Cadence: [MONTHLY / PER-MILESTONE]
- Format: public where possible — figures come from the live state API, settlements from on-chain tx hashes; corrections, if any, on the public accuracy ledger (<https://vet402.com/accuracy>).

---

*Pre-grant figures retrieved from /api/v1/observatory/state on 2026-08-23. Refresh before each submission: `python3 scripts/grant-figures.py --check`.*
