# AI Usage Disclosure — Template

> Internal template. Most grant programs and hackathons now ask how AI was used. Our answer is unusual and should be stated plainly rather than minimized: **this project is developed and operated by AI agents, with a human owner who holds final approval over spending and external commitments.**
> Copy the section matching the program's question format and fill the `[ ]` placeholders. Never soften the disclosure to improve odds; misrepresenting authorship risks disqualification and contradicts the project's own premise (independent, verifiable claims).

## Short form (one paragraph — for a single disclosure field)

> vet402 is built and operated by AI agents (Anthropic Claude-based), working under a human owner who approves all spending, external submissions, and legal commitments. The AI agents write and review the code, run the verification operation (real on-chain purchases included), and author documentation such as this application. Every operational claim we make is independently verifiable without trusting the authors — settlement tx hashes on-chain, live state as public JSON at <https://vet402.com/api/v1/observatory/state>, methodology published, corrections on a public ledger. We consider an AI-operated verification service appropriate to its subject: the x402 agent-payment economy it measures is itself made of transacting AI agents.

## Long form (for programs with itemized AI questions)

**1. Was AI used to write code?**
Yes — substantially all of it. Code is written by AI agents ([MODEL / TOOLING, e.g. "Claude-family models via Claude Code"]), with automated tests and review passes also performed by AI agents. The human owner does not write code.

**2. Was AI used to write this application?**
Yes. This application was drafted by the AI agents that operate the project. Figures in it are pulled from the live production API at submission time, not from memory; each figures-bearing document states its retrieval date.

**3. Who operates the service?**
AI agents run day-to-day operation: catalog snapshots, L0 probes, L1 real-purchase runs (budget-capped), publication of results, and correction handling. The human owner ([NAME / HANDLE]) holds final approval over: paid subscriptions and new contracts, movements of funds beyond pre-approved verification budgets, brand publication, and irreversible/destructive changes.

**4. Who is legally responsible?**
[LEGAL ENTITY / INDIVIDUAL OWNER NAME] — the human owner / entity. The AI agents are tooling; accountability, IP ownership, and any agreements rest with the owner.

**5. How can reviewers verify claims independently of the (AI) authors?**
- Settlements: on-chain tx hashes published per endpoint (Base mainnet).
- Aggregates: public JSON at <https://vet402.com/api/v1/observatory/state>; methodology at <https://vet402.com/observatory/methodology>.
- Mistakes: public accuracy ledger at <https://vet402.com/accuracy>.
- Code: MIT-licensed packages (`@vet402/*` on npm) [+ REPO LINK IF THE PROGRAM REQUIRES SOURCE ACCESS].

**6. Original-work statement (hackathon variant)**
All hackathon-period work is new and authored during the event window by the team described above. [IF APPLICABLE: "It consumes our pre-existing public HTTP API (vet402.com) as an external, disclosed dependency; no pre-existing source code is included in the submission, and the core flow works without it."] AI assistance is disclosed above; no other party's non-public code or content is included.

## Per-program notes (fill before each submission)

| Program | Their stated AI policy (quote + URL) | Sections used | Adjustments |
|---|---|---|---|
| [PROGRAM] | [QUOTE + LINK — read the current rules; do not rely on last cycle's] | [Short / Long / Q-numbers] | [e.g. word limits] |

---

*Template maintained in-repo so disclosures stay consistent across applications. Update live-figure references from /api/v1/observatory/state on the day of each submission.*
