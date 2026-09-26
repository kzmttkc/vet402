> **ETHGlobal Tokyo 2026:** see [the Tokyo section](#ethglobal-tokyo-2026) at the end of this file. Everything above it is the ETHOnline 2026 record, unchanged.

# AI usage — vet402 (ETHOnline 2026, Continuity)

ETHGlobal asks entrants to document **where and how AI tools were used**, and states that submissions
which *rely entirely on AI without meaningful contributions from team members* may not be eligible.
This file answers both, with numbers anyone can re-derive from the public history.

## The short answer

**I built the foundation and direct the work. AI writes most of the code under that direction.**

The project did not start from an AI prompt. It started on **2026-07-13** with a commit authored by
**Takeshi Kazumoto** — `Initial commit: Vouch agent-trust MVP (M0–M5)`, **130 files, +19,245 lines** —
written before any AI-assisted commit exists in this repository. I handed that codebase over along
with the architecture and the milestones it was to grow into, and have directed the build ever since.

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
| **Foundation** | I wrote and handed over the initial MVP (130 files, 19,245 lines) and specified how it was to be built |
| **Direction** | I set what gets built and what does not. I cut one planned item from the window scope |
| **Judgement** | I overrule the AI. During this window alone I corrected the AI on the ownership of the work, on the framing of this very file, and on when to stop deferring work |
| **Approval** | Every action that spends money or leaves the company. Nothing external is sent without it |
| **Money** | I fund the wallets. I sent the 1.000000 USDC that paid The Graph $0.01 on chain during this window |
| **Voice** | I record the demo narration. AI voiceover is disqualifying, and I do not use one |
| **Submission** | I click submit. I attend live judging if I am shortlisted |

**The AI is fast, and it is wrong often enough that my corrections are load-bearing.**
Three separate decisions in this window exist only because I pushed back.

## What the AI does

Implementation, tests, and audits, under the direction above. Claude (Opus / Fable, via Claude Code)
writes most of the code in this repository. I say that plainly rather than annotate a handful of files.

```bash
git rev-list --count HEAD                                  # 927 commits (2026-09-13)
git log --grep='Co-Authored-By: Claude' --oneline | wc -l  # 785 carry the AI trailer
git rev-list --count --merges HEAD                         # 34 are merge commits
```

**The <!-- n:no_trailer_commits -->142<!-- /n --> without the trailer are not "written by a human".** <!-- n:merge_commits -->34<!-- /n --> are merges; most of the rest are AI
commits from before I adopted the trailer, or ones where it was simply forgotten. **Read the absence of
a trailer as "unknown", not as "human".** The numbers move every day — re-run the commands.

## Window boundary

| | |
|---|---|
| Boundary tag | `pre-ethonline-2026` = `c42daca`, **2026-09-04 00:05:36 UTC** — 15 h 54 min *before* the window opened at 2026-09-04 16:00 UTC (`hacking-begins`). **3 commits in the claimed range predate 16:00 UTC**; they are listed in [`docs/ethonline-2026/DISCLOSURE_2026-09-05.md`](./docs/ethonline-2026/DISCLOSURE_2026-09-05.md) |
| Everything submitted as hackathon work | `git log pre-ethonline-2026..main` |
| Pre-window work since my 2026-08-23 application | **214** commits, 412 files, +28,414 / −1,913 lines — disclosed to ETHGlobal in writing on 2026-09-05 |

## Window work, by area

| Area | Files | AI role |
|---|---|---|
| **Payment gate (the submission's core)** | `packages/sdk/src/pay-or-refuse.ts`, `x402-pay.ts`, `subgraph-evidence.ts`, their tests | Written by AI. The failing tests were written first, before any implementation existed |
| **MCP tool** | `packages/mcp-server/src/pay-if-trusted.ts`, `SKILL.md` | Written by AI |
| **Runtime kill switch** | `src/lib/observatory/kill-switch.ts`, `src/app/api/admin/spending-halt/route.ts` | Written by AI after an AI-run audit found spending could not be stopped without a redeploy |
| **Evidence provenance** | `src/lib/decision/evidence.ts`, `docs/openapi.yaml`, `src/lib/observatory/vocabulary.ts` | Written by AI |
| **Settlement integrity** | `src/lib/settlements/rollup.ts`, `recover-late.ts`, nonce-binding tests | Written by AI |
| **Security audits** | `docs/audits/2026-09-05-*` | Conducted and written by AI agents, cross-checked against production data |
| **Planning artifacts** | `docs/ethonline-2026/**`, including `PROMPTS/` | Compiled by AI from my own messages — the instructions quoted in `PROMPTS/` are mine. `PROMPTS/` carries, by day, an excerpt of the decisions, instructions and approvals I gave, each with the commit it landed in |

**Window totals move daily; derive them rather than trusting this line:**

```bash
git diff --diff-filter=A --name-only pre-ethonline-2026..main | wc -l   # 237 added   (2026-09-13)
git diff --diff-filter=M --name-only pre-ethonline-2026..main | wc -l   # 206 modified
```

**Not all of that is this submission.** `main` is also the production branch and carries work unrelated
to the hackathon in the same days — see the caveat in [`README.md`](./README.md). The table above lists
what I am claiming.

## How to check any of this yourself

```bash
git log --reverse --format='%h %ad %an %s' --date=short | head -1   # who started it, and when
git show --shortstat 6f38202                                       # the human-written foundation
git log pre-ethonline-2026..main --stat                            # everything built during the window
ls docs/ethonline-2026/PROMPTS/                                    # an excerpt of the instructions I gave, by day
```

Commits carry a `Co-Authored-By: Claude` trailer where AI wrote them. Where a commit message says
実測 (measured), the number in it came from production or from chain, not from the model.

---

# ETHGlobal Tokyo 2026

ETHGlobal Tokyo 2026 asks entrants to document where and how AI tools were used, and says that work
relying entirely on AI without meaningful contributions from the team may not be eligible for partner
prizes or finalist consideration. This section answers both for the Tokyo work. All times are JST.
Hacking began on 2026-09-25 at 21:00.

## The short answer

**The AI wrote the code. I decided what it should prove, chose the prizes, created the testnet keys,
pressed `y` on each live send made with the operator commands, and recorded the video's voice myself.**
Two scheduled re-signing runs are the exception: I handed their `y` to the AI, and they are listed below
with the AI's test presses of the public judge button.

The AI is Claude Code running Claude Opus 5.5, including the sub-agents it started as independent
reviewers. Every commit from `pre-tokyo-2026` to `e572257c` carries the trailer
`Co-Authored-By: Claude Opus 5.5`. One outside proposal written by Grok was compared with the plan on
2026-09-25 between 21:20 and 21:29. No code came from it; one idea from it was kept: the submission text
names ENSIP-26 for the `agent-endpoint[x402]` record.

## What I decided and did

The full list, one row per act with its time and a public trace where one exists, is
[`docs/tokyo-2026/human-log.md`](./docs/tokyo-2026/human-log.md). In short:

| | |
|---|---|
| **Boundary** | I tagged `pre-tokyo-2026` on 2026-09-25 at 18:05:43 and pushed it at 18:06, before hacking began |
| **What it proves** | I decided the central sentence on 2026-09-14 at 19:35 and approved the three quality axes before the event. Neither changed during it. Excerpts: [`docs/tokyo-2026/PROMPTS/`](./docs/tokyo-2026/PROMPTS/) |
| **Prizes** | 2026-09-25 21:32: I chose "Top 10 Finalist & Partner Prizes" as the submission type; on 2026-09-26 at 14:34 I changed it to "Partner Prizes Only". The AI proposed ENS and Intercepta as the two partners at 21:30, from the screenshot of the prize screen I sent, and I kept them. Both are entered on the dashboard at submission. |
| **Money-path change** | 2026-09-25 22:43: I approved the four points of the review of the Base Sepolia change to the payment gate (`chain-profile.ts`, `x402-pay.ts`, `pay-or-refuse.ts`) as recommended |
| **Keys** | 2026-09-25 21:41: I created the testnet keys (`keys.ts init`, which prints addresses only) |
| **Live sends** | I pressed `y` on each live send made with the operator commands from 2026-09-25 21:41 to 2026-09-26 09:36: the ENS setup (8 stages, 32 Sepolia and 3 Base Sepolia transactions), the offer alignment, the first purchases and attestations, the scene runs including the irreversible `revokeRootRoles`, the observation log, and scene 2 of the video |
| **Presence** | I was at the terminal for each screen recording of a live run, because each one waited for my `y` |
| **Story** | 2026-09-26 07:44: I told the AI to make the video and the submission text a presentation in four parts (setup, answer, turn, close), not a list of facts |
| **Voice** | 2026-09-26 09:48: I handed over the narration of the video, recorded myself in four recordings. No AI voice is used |
| **Review** | 2026-09-26 10:22: I asked several agents for an objective and adversarial check of everything made so far. At 10:38 I told the AI to go ahead with every fix and recommended move from that check |
| **Submission** | I submit on the ETHGlobal dashboard myself |

## What the AI wrote

Everything below was written by the AI under the direction above. The file list covers every file in
`git diff --name-only pre-tokyo-2026..` as of 2026-09-26 11:00; commits after that follow the same rule.

| Area | Files | AI role |
|---|---|---|
| **ENSIP-29 check in the SDK (the core)** | `packages/sdk/src/{atst-codec,ens-read,ens-reasons,ens-attestation,ens,chain-profile}.ts` (new), `packages/sdk/src/pay-or-refuse.ts` (+669 / -45), `packages/sdk/src/x402-pay.ts` (+29 / -14), `packages/sdk/src/index.ts` | Written by AI. The failing tests (`packages/sdk/test/tokyo/**`, `packages/mcp-server/test/tokyo/**`) were committed first, from 21:08, before the gate code, from 21:26 |
| **Built SDK** | `packages/sdk/dist/**`, `vendor/vet402-sdk-0.7.0.tgz` | Built by AI from the source above and committed, so a clean clone runs the same code |
| **Demo and operator commands** | `examples/tokyo-2026-demo/**` (`run.ts`; `admin.ts`, including the ENSv2 expiry, non-transferable name and `agent-context` (ENSIP-26) commands; `attester.ts`; `observe.ts`; `keys.ts`; `screening.ts` for Intercepta, including the check of unknown payees; `gen-for-reviewers.ts`; tests) | Written by AI. The commands that send are dry-run by default and ask for `y` before a live send |
| **Live page and judge button** | `src/app/tokyo/**`, `src/app/api/tokyo/**`, `src/lib/db/schema.ts` (+32), `scripts/sql/2026-09-26-tokyo-mutations.sql`, `tests/tokyo-*.ts` | Written by AI, then checked by an independent AI reviewer before merge |
| **Docs** | `docs/tokyo-2026/*.md`, `skills/pay-or-refuse/SKILL.md`, `.env.example` | Written by AI |
| **Package and test upkeep** | `package.json`, `package-lock.json`, `packages/sdk/package.json`, `packages/sdk/package-lock.json`, `packages/sdk/test-mutations.mjs`, `packages/sdk/test-mutations-svm.mjs`, `packages/sdk/test/pay-or-refuse.test.mjs`, `tests/openapi-route-parity.test.ts` | Written by AI |
| **This disclosure** | This section, `docs/tokyo-2026/human-log.md`, `docs/tokyo-2026/PROMPTS/`, and one paragraph of `docs/tokyo-2026/prework/README.md` | Compiled by AI from the records of my messages and actions. The decisions quoted are mine |
| **Outside git** | Screen recordings, English subtitles, video assembly, submission text drafts | Done by AI. The voice, the structure of the story and the way to edit (2026-09-26 09:32) are mine |

**Planning artifacts.** The plan and the work orders given to the AI agents were written before the event
and are in [`docs/tokyo-2026/prework/`](./docs/tokyo-2026/prework/), on an allow-list. What was left out, and
why, is stated there and in [`docs/tokyo-2026/PROMPTS/README.md`](./docs/tokyo-2026/PROMPTS/README.md).

## Sends I handed to the AI

| Delegated at | What the AI runs without my `y` | When it runs |
|---|---|---|
| 2026-09-26 06:57 | Re-buy from the four demo sellers (0.01 test USDC each, Base Sepolia) and re-publish their ENSIP-29 attestations (Sepolia), so the proofs stay fresh while judges check them | 2026-09-27 06:30 |
| 2026-09-26 10:38 | The same re-buy and re-publish, as a safety run ahead of the 2026-09-27 run | 2026-09-26 19:00 |

The `y` prompt is skipped only on the JST date of each run (`examples/tokyo-2026-demo/src/lib/env.ts`).
The unattended runs pass `--allow-unknown`: the payee has no history on Base mainnet, so Intercepta rates it unknown, and the attester buys from an unknown payee only when a person has decided so. My delegation is that decision. Every other check before a send still applies.
The AI also pressed the public `/tokyo` judge button on production to test it, on 2026-09-26 between
07:54 and 07:56 and again after 08:20. Each press and each reset sends one Sepolia transaction from the
server's operator key, which is what every judge's press does.

## History note

On 2026-09-26 at 07:31 the working branch was replayed as a flat history so that its merge commits could
go through the push script to `main`. The content did not change: the tree of the tip before the replay
(`39a7e13d`, kept locally as `tokyo-2026-merged-backup`) equals the tree of `687fae79`. That is why many
committer dates fall between 07:31 and 07:32. The same was done once more on 2026-09-26 at 11:05 for the commits made after that, so their committer dates show 11:05. The author date of each commit is when the change was made.

## Rule by rule

| Rule (quoted) | Where it is answered |
|---|---|
| "Clearly document in your submission where and how AI tools were used in the project." | "What the AI wrote" above, and the `Co-Authored-By` trailer on each commit |
| "AI tools should be used to assist your development process, not to create the entire project." | "What I decided and did" above, and [`human-log.md`](./docs/tokyo-2026/human-log.md) |
| "Submissions that rely entirely on AI without meaningful contributions from team members may not be eligible for partner prizes or finalist consideration." | The prize choice, the approvals, the keys, the `y` on each live send, and the voice: [`human-log.md`](./docs/tokyo-2026/human-log.md). The two sends handed to the AI are listed above rather than hidden |
| "If you use one, you must include all spec files, prompts, and planning artifacts in your submission repository." | [`prework/`](./docs/tokyo-2026/prework/) (plan, work orders, agent prompts, written before the event) and [`PROMPTS/`](./docs/tokyo-2026/PROMPTS/) (decisions during the event), each with its list of what was left out and why |
| "you must disclose any pre-existing work in writing to the ETHGlobal team and include full details in your submission" (Code of Conduct) | The boundary tag `pre-tokyo-2026` and [`prework/README.md`](./docs/tokyo-2026/prework/README.md). The written disclosure was sent on 2026-09-18 22:31 UTC (2026-09-19 JST), and ETHGlobal replied on 2026-09-24 that nothing was missing |
| "you must also use version control for your code throughout the course of the event" (Code of Conduct) | 66 commits up to `e572257c`; the largest adds 2,438 lines (`99a09328`, the `/tokyo` page and judge button). See the history note above |

## How to check any of this yourself

```bash
git show pre-tokyo-2026 --no-patch --format='%ci %H'                     # the boundary, 2026-09-25 18:05:10 +0900
git log --format='%h %ad %s' --date=iso pre-tokyo-2026..tokyo-2026-submission   # every claimed commit, with its author date
git log --format='%(trailers:key=Co-Authored-By,valueonly)' pre-tokyo-2026..e572257c | sort | uniq -c
#      66 Claude Opus 5.5 <noreply@anthropic.com>
git diff --stat pre-tokyo-2026..e572257c | tail -1
#  95 files changed, 15397 insertions(+), 165 deletions(-)
```

The author name on these commits is one of my two git identities (`kzmttkc`, `Takeshi`). It records which
machine made the commit, not who wrote the change. Read every commit with the Claude trailer as written by
the AI.
