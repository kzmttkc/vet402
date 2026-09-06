# AI usage — vet402 (ETHOnline 2026, Continuity)

ETHGlobal asks entrants to document **where and how AI tools were used**, and states that submissions
which *rely entirely on AI without meaningful contributions from team members* may not be eligible.
This file answers both, with numbers anyone can re-derive from the public history.

## The short answer

**A human built the foundation and directs the work. AI writes most of the code under that direction.**

The project did not start from an AI prompt. It started on **2026-07-13** with a commit authored by
**Takeshi Kazumoto** — `Initial commit: Vouch agent-trust MVP (M0–M5)`, **130 files, +19,245 lines** —
written before any AI-assisted commit exists in this repository. He handed that codebase over along
with the architecture and the milestones it was to grow into, and has directed the build ever since.

```bash
git log --reverse --format='%h %ad %an %s' --date=short | head -1
# 6f38202 2026-07-13 Takeshi  Initial commit: Vouch agent-trust MVP (M0–M5).
git show --shortstat 6f38202 | tail -1
# 130 files changed, 19245 insertions(+)
```

## What the human does — this is not a formality

Every item below is a decision or an action that the AI cannot take, and each one changed the product.

| | |
|---|---|
| **Foundation** | Wrote and handed over the initial MVP (130 files, 19,245 lines) and specified how it was to be built |
| **Direction** | Sets what gets built and what does not. The window scope is five items because he cut a sixth |
| **Judgement** | Overrules the AI. During this window alone he corrected the AI on the ownership of the work, on the framing of this very file, and on when to stop deferring work |
| **Approval** | Every action that spends money or leaves the company. Nothing external is sent without it |
| **Money** | Funds the wallets. He sent the 1.000000 USDC that paid The Graph $0.01 on chain during this window |
| **Constraints** | Set the standing rule that a past relationship with a sponsor is not to be used for advantage (`docs/ethonline-2026/WINDOW_PLAN.md` §1.5) |
| **Voice** | Records the demo narration. AI voiceover is disqualifying, and we do not use one |
| **Submission** | Clicks submit. Attends live judging if we are shortlisted |

**The AI is fast, and it is wrong often enough that the human's corrections are load-bearing.**
Three separate decisions in this window exist only because he pushed back.

## What the AI does

Implementation, tests, and audits, under the direction above. Claude (Opus / Fable, via Claude Code)
writes most of the code in this repository. We say that plainly rather than annotate a handful of files.

```bash
git rev-list --count HEAD                                  # 697 commits (2026-09-06)
git log --grep='Co-Authored-By: Claude' --oneline | wc -l  # 578 carry the AI trailer
git rev-list --count --merges HEAD                         # 34 are merge commits
```

**The 119 without the trailer are not "written by a human".** 34 are merges; most of the rest are AI
commits from before we adopted the trailer, or ones where it was simply forgotten. **Read the absence of
a trailer as "unknown", not as "human".** The numbers move every day — re-run the commands.

## Window boundary

| | |
|---|---|
| Boundary tag | `pre-ethonline-2026` = `c42daca`, **2026-09-04 00:05:36 UTC** (5 minutes after the window opened) |
| Everything submitted as hackathon work | `git log pre-ethonline-2026..main` |
| Pre-window work since our 2026-08-23 application | **214** commits, 412 files, +28,414 / −1,913 lines — disclosed to ETHGlobal in writing on 2026-09-05 |

## Window work, by area

| Area | Files | AI role |
|---|---|---|
| **Payment gate (the submission's core)** | `packages/sdk/src/pay-or-refuse.ts`, `x402-pay.ts`, `subgraph-evidence.ts`, their tests | Written by AI. The failing tests were written first, before any implementation existed |
| **MCP tool** | `packages/mcp-server/src/pay-if-trusted.ts`, `SKILL.md` | Written by AI |
| **Runtime kill switch** | `src/lib/observatory/kill-switch.ts`, `src/app/api/admin/spending-halt/route.ts` | Written by AI after an AI-run audit found spending could not be stopped without a redeploy |
| **Evidence provenance** | `src/lib/decision/evidence.ts`, `docs/openapi.yaml`, `src/lib/observatory/vocabulary.ts` | Written by AI |
| **Settlement integrity** | `src/lib/settlements/rollup.ts`, `recover-late.ts`, nonce-binding tests | Written by AI |
| **Security audits** | `docs/audits/2026-09-05-*` | Conducted and written by AI agents, cross-checked against production data |
| **Planning artifacts** | `docs/ethonline-2026/**`, including `PROMPTS/` | Written by AI. `PROMPTS/` carries the human's verbatim instructions, by day |

**Window totals move daily; derive them rather than trusting this line:**

```bash
git diff --diff-filter=A --name-only pre-ethonline-2026..main | wc -l   # 146 added   (2026-09-06)
git diff --diff-filter=M --name-only pre-ethonline-2026..main | wc -l   # 162 modified
```

**Not all of that is this submission.** `main` is also the production branch and carries work unrelated
to the hackathon in the same days — see the caveat in [`README.md`](./README.md). The table above lists
what we are claiming.

## How to check any of this yourself

```bash
git log --reverse --format='%h %ad %an %s' --date=short | head -1   # who started it, and when
git show --shortstat 6f38202                                       # the human-written foundation
git log pre-ethonline-2026..main --stat                            # everything built during the window
ls docs/ethonline-2026/PROMPTS/                                    # the instructions, by day
```

Commits carry a `Co-Authored-By: Claude` trailer where AI wrote them. Where a commit message says
実測 (measured), the number in it came from production or from chain, not from the model.
