# AI usage — vet402 (ETHOnline 2026, Continuity)

ETHGlobal asks entrants to specify **which parts of the code and which specific files were generated
or assisted by AI**. This file answers that for the hackathon window and for the project as a whole.
It is updated in the same commit that adds a new file, the same way `docs/ethonline-2026/CHANGED_FILES.md` is.

## The short answer

**Effectively all of the code in this repository is written by AI agents.** vet402 is built by an
AI-operated company: a human owner (Takeshi Kazumoto) sets direction, approves anything that spends
money or goes outside the company, and clicks what an agent cannot click. Claude (Opus / Fable, via
Claude Code) does the design, the implementation, the tests, and the audits.

We are stating this plainly rather than annotating a handful of files, because the honest answer is
"all of it", and a per-file table that implied otherwise would be misleading.

## Window boundary

| | |
|---|---|
| Boundary tag | `pre-ethonline-2026` = `c42daca`, **2026-09-04 00:05:36 UTC** (5 minutes after the window opened) |
| Everything submitted as hackathon work | `git log pre-ethonline-2026..main` |
| Pre-window work since our 2026-08-23 application | 207 commits, 412 files, +28,414 / −1,913 lines (disclosed to ETHGlobal in writing on 2026-09-05) |

## What AI did, by area (window work)

| Area | Files | AI role |
|---|---|---|
| **Payment gate (the submission's core)** | `packages/sdk/src/pay-or-refuse.ts`, `packages/sdk/test/pay-or-refuse.test.mjs`, `packages/mcp-server/**` | Written by AI. The failing tests were written first, by AI, before any implementation existed |
| **Runtime kill switch** | `src/lib/observatory/kill-switch.ts`, `src/app/api/admin/spending-halt/route.ts`, `tests/l1-kill-switch*.ts`, `scripts/sql/2026-09-05-runtime-flags.sql` | Written by AI after an AI-run audit found that spending could not be stopped without a redeploy |
| **Settlement integrity** | `src/lib/settlements/rollup.ts`, `recover-late.ts`, `tests/settlement-*.ts`, `tests/sol402-nonce-binding.test.ts` | Written by AI |
| **Ledger durability & monitoring** | `scripts/vet402_ledger_snapshot.py`, `scripts/vet402_cert_watch.py` (management repo), `docs/INCIDENT_RUNBOOK.md` | Written by AI |
| **SEO / AEO / vocabulary** | `src/lib/observatory/vocabulary.ts`, `src/lib/seo.ts`, `src/lib/observatory/cached-reads.ts`, `tests/dataset-json-ld.test.ts`, `tests/faq-answers-directly.test.ts` | Written by AI |
| **Security audits** | `docs/audits/2026-09-05-blockchain-security-audit.md`, `-cia-availability-audit.md`, `-red-team-attack-tree.md` | Conducted and written by AI agents (multiple independent Opus sessions), cross-checked against production data |
| **Planning artifacts** | `docs/ethonline-2026/**`, `docs/ethonline-2026/PROMPTS/**` | Written by AI. `PROMPTS/` carries the verbatim human instructions and the AI's own self-instructions, by day |

64 files were added and 108 modified during the window (measured at 2026-09-05).

## What the human did

Not code. Specifically:

- Submitted the ETHOnline Continuity application (2026-08-23) and will click submit
- Approved every action that moves money or leaves the company, including the on-chain demo funding
- Funded the demo wallet `0xDB62BD202914609830fA656F87996b91be3Aa673` with 1.000000 USDC on Base
- Records the voice-over for the demo video (AI-generated narration is disqualifying)
- Set the standing constraint that a past relationship with a sponsor is not to be used for advantage
  (`docs/ethonline-2026/WINDOW_PLAN.md` §1.5)
- Corrected the AI when it was wrong. Several decisions in this window exist because he pushed back

## How to check any of this yourself

```bash
git log pre-ethonline-2026..main --stat        # everything built during the window
git log --format='%an <%ae>%n%b' | grep -c 'Co-Authored-By: Claude'   # AI co-authorship trailers
ls docs/ethonline-2026/PROMPTS/                # the instructions, by day
```

Commits carry a `Co-Authored-By: Claude` trailer. Where a commit message says "実測" (measured), the
number in it came from production or from chain, not from the model.
