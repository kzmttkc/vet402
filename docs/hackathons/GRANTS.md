# Grant strategy

> Locked 2026-08-23. Complements the hackathon campaign; does not replace it.
> Narrative: [`STRATEGY.md`](./STRATEGY.md) · Ops calendar: [`2026-autumn-continuity.md`](./2026-autumn-continuity.md)
> Materials already in repo: [`../applications/`](../applications/)

## The bet

Hackathons buy **proof of a new verb** (36 hours / 12 days, Partner prizes).
Grants buy **runway to keep measuring** (purchase capital, RPC, the public record).

Do not sell the same deliverable twice. Do not implement a frozen hackathon verb to decorate a grant. Ask for money against work that is **already live and checkable**, or against ops that are **not** the next Continuity verb.

Expected value, in order:

1. Retro grants for shipped Base work (no new code).
2. Visibility so discovery programs find us (Base, OP Atlas).
3. Prospective grants whose milestones are purchase capital / Solana L1 / infra — not `payOrRefuse`, not ENS-in-the-payment-path, not Validation Registry writes.
4. After each hackathon, **one** grant that cites that weekend’s verb as evidence, not as a promise.

Honest ceiling: we cannot make a grant certain. We can stop asking for invention we already shipped, stop padding budgets, and stop colliding with Continuity boundaries.

---

## 1. What reviewers already have (do not re-pitch as “we will build”)

Live, MIT, independently checkable:

- Observatory L0–L2, real USDC L1 on **Base**, failures published with the same weight
- Public JSON: `https://vet402.com/api/v1/observatory/state`
- Methodology, accuracy ledger, `/impact`
- `@vet402/sdk` / middleware / MCP
- ERC-8004 **reads** + Validation Registry **dry-run** (not writes)
- SpendGuard that **decides** and does not pay (until ETHOnline)

Neutrality (never trade this for a grant):

- We sell nothing on the catalog we measure.
- Measured operators are not customers.
- Sellers cannot pay for a better result.
- No marketing line item aimed at the catalog.

Figures in application drafts are dated **2026-08-23** (except `solana-grant-proposal.md`, whose cost basis is a coherent 2026-08-20 snapshot and is re-quoted whole at submission). Re-`curl` the state API on the submission day. Never invent amounts (`milestones-budget-template.md`).

---

## 2. Two kinds of money

| Kind | Pays for | When to ask | Example |
|---|---|---|---|
| **Retro** | Work already running | Now, and after each ship | Base Builder Grants 1–5 ETH; OP Retro / Atlas |
| **Prospective** | Next 6–12 months of *ops* | After Continuity apply is in; milestones ≠ frozen verbs | Solana L1 purchase capital (~$5,907.75 drafted); ESP if a Wishlist matches |

Do **not** write a prospective milestone that is:

- `payOrRefuse` / `pay_if_trusted` (ETHOnline)
- ENS resolve-then-pay (Tokyo)
- Mainnet Validation Registry **writes** used as the Mumbai demo

Those are hackathon verbs. After they exist on `main` and the event is submitted, they become **retro evidence** for the next grant.

Solana real-purchase (payer exists, default-off, no funds) is **not** a hackathon verb. It may be a grant milestone. It must **not** land on branch `ethonline-2026` / `tokyo-2026` / `mumbai-2026`.

---

## 3. Priority stack (2026 autumn)

### P0 — this week, no new product code

1. **ETHOnline + Tokyo Continuity apply** still wins the calendar. Grants do not jump the queue.
2. ~~**Base Builder Grants (retro, 1–5 ETH).**~~ **SUBMITTED 2026-08-25 10:03 JST** — acknowledgement mail received. What we sent is frozen in [`../applications/base-builder-grant-nomination.md`](../applications/base-builder-grant-nomination.md) (excluded from `--write` so the record is not rewritten). Farcaster was not held for: we said "Not on Farcaster yet — X: @vet_402". No reply is expected ("we will not be responding to all requests").
3. ~~**OP Atlas / Retro Funding.**~~ **Dropped 2026-08-23** (read in-browser): atlas.optimism.io announces *"Atlas will be discontinued on September 18, 2026"*; the Onchain Builders mission is **Closed** (season Jul 31–Dec 24 **2025**); and its first eligibility gate is *"My project has deployed contracts on a supported chain"* — vet402 deploys no contracts, it buys from other people's. It was never eligible. Do not spend owner time on a profile there.

### P1 — after Continuity paperwork, still no frozen verbs

4. **Solana Foundation / Superteam** — proposal already drafted (`solana-grant-proposal.md`). Ask is cost-basis, labor $0, purchase capital + list-price infra. Submit when the human can own the legal entity / contact fields. Implementation only on a **non-hackathon** branch, after ETHOnline submit if it would steal September focus.
5. ~~**x402 / CDP / Coinbase-adjacent grants**~~ **no public window as of 2026-08-26** (read coinbase.com/developer-platform/discover/launches in-browser: the newest grant post is *Summer 2025 Builder Grant Recipients*, $30,000 across 13 projects — the round is closed and no 2026 round is announced). Do not draft against it. **Re-check 2026-10-01**; the relationship route (the August @murrlincoln contact) is the only live path meanwhile. Original note kept: if a public form appears — Pitch: we are the independent settle-through dataset for the catalog they host. Retro first (1,133 attempts, 496 settled). Prospective only for purchase budget, not for a new protocol.

### P2 — timed to events (evidence, then ask)

| After | Grant input | Ask |
|---|---|---|
| ETHOnline submit | `payOrRefuse` + public tx + `source: agent-demo` | Base / x402 retro addendum: agents can now refuse before sign |
| TOKEN2049 week | Meetings, not Origins | Same one-pager as Devcon; no new grant milestone invented on the floor |
| Tokyo submit | ENS resolve-then-pay | ENS DAO / ENS grants — **only then** |
| Devcon 11/3–5 | ESP Office Hours, EF / 8004 people | Match a **live Wishlist/RFP**. ESP is not an open inbox ([esp.ethereum.foundation](https://esp.ethereum.foundation/)). **2026-08-26 実測: the Wishlist page says "No Wishlist Available — There are currently no active wishlists available for application." Nothing to match yet; re-check 2026-10-20, before Devcon.** Bring dry-run numbers. Do not promise the Mumbai write as a grant deliverable before 11/6 |
| Mumbai submit | Actual registry writes | EF / 8004 / identity retro: the empty registry is no longer empty |

### P3 — opportunistic

- **Octant — the closest category match we have found (2026-08-26 実測).** Epoch 12 (FINALIZED, 200 ETH matching pool, 25 projects) funded **L2BEAT** ("impartial watchdog … open-source research and analytics") and **growthepie** ("open analytics … free to access and transparent"). That is the same species as vet402: independent public measurement, sells nothing to the measured. Neutrality is an asset here, not a cost.
  **Entry is gated**: Octant v2 applications run through Atlas ([apply.octant.app](https://apply.octant.app), SIWE sign-in) and *"During beta testing, Atlas is available only to selected partners. You will need an invitation code from the Octant team."* No public contact for invites is published. **Next action: ask the Octant team for an invitation code** (owner-approved outbound). The application itself is short — one-sentence pitch, 2–4 paragraphs, category, funding goal in USD, use-of-funds plan, links — all of which already exist in `../applications/`.
- **XRPL Grants / XRPL Accelerator — parked, with one decisive test (checked 2026-08-27).** Unlike Base and Octant this is a *build* program (up to $200K, one unified form, [xrplgrants.org](https://xrplgrants.org/)), so proposing new work is in-scope there rather than a violation.
  What changed our picture: **x402 is live on XRPL and large.** Our catalog shows 0 XRPL endpoints only because our source is the CDP Bazaar. t54.ai runs an XRPL facilitator (`XRPL_NETWORK=xrpl:0`, scheme `exact`, presigned Payment blobs), and [xrpl.fi/x402](https://xrpl.fi/x402) measures **≈7,450 payments/hour** straight from validated ledgers (SourceTag 804681468 + memo) — bigger than the settle volume we see on Base.
  Where we would add something: xrpl.fi counts **payments**; nobody there checks whether the resource was **delivered** after payment. Settle-through is exactly our thing.
  **Blocker — we cannot enumerate the objects to measure.** There is no public directory of XRPL x402 endpoints (t54 publishes merchant/client integration guides and a facilitator, no discovery surface). On-chain we can recover destination *accounts*, not *URLs*, and our sweep needs URLs. Promising a measurement we cannot enumerate is the one thing this project must never do.
  **Decisive test, after the ETHOnline submit (2026-09-13):** can XRPL x402 endpoints be enumerated at all — ask t54 directly, and check whether the Bazaar accepts `xrpl:0` registrations. Enumerable → write the proposal. Not enumerable → drop it and say why.
- Gitcoin: GG24 (Oct 2025) is the last major round; Grants Stack / Grants Lab were wound down 2025-05-31. No open round found 2026-08-26. Re-check when a round is announced, not on a schedule.
- Base Batches / Ecosystem Fund: only if we want equity-shaped capital. Default is **no** — neutrality and public-good posture first.
  **Decided 2026-08-23 (CEO): we are not applying to Base Batches 004** (deadline "Applications close September 9", **$100K investment** from the Base Ecosystem Fund, Demo Day New York November 2026 — [base.org/batches](https://www.base.org/batches), primary check 2026-08-23). Accepting the investment is a condition of the program. Three reasons, in order: (1) the fund belongs to the ecosystem whose catalog we grade — a shareholder relationship is the one attack on our dataset we cannot answer with evidence; (2) we have nothing to sell to the measured catalog, so an investor-track pitch would have to invent a revenue story that neutrality forbids; (3) Demo Day lands on Devcon / ETHMumbai week. The 2026-08-20 GO decision and the owner-approved essay are superseded. Reversible until 09-09 on one line from the owner. The recording effort that this needed goes to the Base Builder Grants 1-minute demo instead — non-dilutive, retroactive, no conflict.
- Guarantee underwriting (`guarantee-underwriting-design.md`): dormant. Do not put it in a grant until legal says so.

---

## 4. How to write every application

Reuse, do not rewrite the thesis:

- One-pager: `impact-one-pager.md`
- Ethereum public-good: `why-ethereum-agent-economy.md`
- Base: `why-base.md`
- Solana: `solana-grant-proposal.md` + `why-solana.md`
- Budget shape: `milestones-budget-template.md`
- AI: `ai-usage-disclosure.md` (do not soften)

Rules:

1. **Already delivered** = measured facts only. Retrieval date + `curl` for `/api/v1/observatory/state`.
2. **Amounts** = quotes or measured cost basis. No rounding for show.
3. **Acceptance checks** a reviewer can run without trusting us (explorer tx, public JSON field).
4. Labor $0 is allowed where true; the human owner / entity is still the legal applicant.
5. One program, one ask. Do not send the Solana budget to Base, or the ENS story to Solana.

---

## 5. Collision with the hackathon freeze

| Frozen until | Grant implication |
|---|---|
| 2026-09-04 | No `payOrRefuse` code for a grant demo. Retro applications OK. |
| 2026-09-25 | No ENS-in-payment-path for an ENS grant demo. Name registration OK. |
| 2026-11-06 | No Mumbai-demo registry **writes**. Dry-run citations OK. Testnet rehearsal that is not the demo write: see campaign calendar. |
| ETHOnline / Tokyo / Mumbai branches | Grant features do not merge into those branches. |

Between events, product ops (probes, Base L1, bugfixes) may continue and must be disclosed as pre-existing at the next hackathon.

---

## 6. Roles

| Human | Agent |
|---|---|
| Entity, tax, wallet for grant receipt, submit click | Drafts, figure refresh, milestone tables |
| Base / EF / Solana conversations | Re-curl state API on submission day |
| Nomination posts (Farcaster/X) in the owner’s voice | Checklists, link packs |
| “This number is true today” | Never claim a grant milestone that has not shipped |

---

## 7. This month (grants only)

1. Finish ETHOnline Continuity apply first.
2. ~~Refresh figures~~ **done 2026-08-23** (`scripts/grant-figures.py`; all application docs now agree with live state and `--check` fails loudly when they do not) → nominate / apply **Base Builder Grants**. Blocked on three owner-side gaps listed in the nomination pack: 1-minute demo, Farcaster handle, receiving wallet.
3. ~~Create or update an OP Atlas profile.~~ Dropped — Atlas is being discontinued 2026-09-18 and vet402 was never eligible (no deployed contracts). See P0-3.
4. Fill legal entity + email on the Solana draft; **do not start Solana L1 implementation** until ETHOnline is submitted (or a clearly separate branch after 09-16).
5. Book Devcon ESP / EF conversations as Mumbai prize work that can also unlock a Wishlist match.

---

## 8. What we will not do

- Ask a grant to fund a frozen Continuity verb.
- Pad labor or marketing against the catalog we measure.
- Submit stale numbers as if they were today (`python3 scripts/grant-figures.py --check` before every send).
- Treat Devfolio ETHMumbai / Origins prize pages as grant programs.
- Soften the AI-operated disclosure to look like a conventional startup team.
