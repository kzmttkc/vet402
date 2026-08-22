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
- `@vouchscore/sdk` / middleware / MCP
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
2. **Base Builder Grants (retro, typically 1–5 ETH).** Submission pack, field by field: [`../applications/base-builder-grant-nomination.md`](../applications/base-builder-grant-nomination.md).
   Base is **not** an ETHOnline 2026 partner ([`../ethonline-2026/PRIZES.md`](../ethonline-2026/PRIZES.md), measured 2026-08-23), so prizes cannot route Base money to us this autumn. Grants are the only Base path, and this one is retroactive. Shipped, Base-native, public good. Discovery is the team + nominations ([docs](https://docs.base.org/get-started/get-funded), [call](https://paragraph.com/@grants.base.eth/calling-based-builders)).  
   Human: nominate / apply with `why-base.md` + `impact-one-pager.md` + live state JSON. Same-day figures. Farcaster/X pointer to `/observatory` and `/impact`.  
   Do not promise `payOrRefuse`.
3. **OP Atlas / Retro Funding.** Register the project as a Superchain public good. Track usage. This is a profile, not a weekend build.

### P1 — after Continuity paperwork, still no frozen verbs

4. **Solana Foundation / Superteam** — proposal already drafted (`solana-grant-proposal.md`). Ask is cost-basis, labor $0, purchase capital + list-price infra. Submit when the human can own the legal entity / contact fields. Implementation only on a **non-hackathon** branch, after ETHOnline submit if it would steal September focus.
5. **x402 / CDP / Coinbase-adjacent grants** if a public form exists. Pitch: we are the independent settle-through dataset for the catalog they host. Retro first (1,133 attempts, 496 settled). Prospective only for purchase budget, not for a new protocol.

### P2 — timed to events (evidence, then ask)

| After | Grant input | Ask |
|---|---|---|
| ETHOnline submit | `payOrRefuse` + public tx + `source: agent-demo` | Base / x402 retro addendum: agents can now refuse before sign |
| TOKEN2049 week | Meetings, not Origins | Same one-pager as Devcon; no new grant milestone invented on the floor |
| Tokyo submit | ENS resolve-then-pay | ENS DAO / ENS grants — **only then** |
| Devcon 11/3–5 | ESP Office Hours, EF / 8004 people | Match a **live Wishlist/RFP**. ESP is not an open inbox ([esp.ethereum.foundation](https://esp.ethereum.foundation/)). Bring dry-run numbers. Do not promise the Mumbai write as a grant deliverable before 11/6 |
| Mumbai submit | Actual registry writes | EF / 8004 / identity retro: the empty registry is no longer empty |

### P3 — opportunistic

- Gitcoin / Octant / similar QF rounds: enter when a round matches “independent measurement / agent payments.” Use live JSON, not a new feature.
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
3. Create or update an OP Atlas profile.
4. Fill legal entity + email on the Solana draft; **do not start Solana L1 implementation** until ETHOnline is submitted (or a clearly separate branch after 09-16).
5. Book Devcon ESP / EF conversations as Mumbai prize work that can also unlock a Wishlist match.

---

## 8. What we will not do

- Ask a grant to fund a frozen Continuity verb.
- Pad labor or marketing against the catalog we measure.
- Submit stale numbers as if they were today (`python3 scripts/grant-figures.py --check` before every send).
- Treat Devfolio ETHMumbai / Origins prize pages as grant programs.
- Soften the AI-operated disclosure to look like a conventional startup team.
