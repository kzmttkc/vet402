# Pre-event planning artifacts (ETHGlobal Tokyo 2026)

Everything in this folder was written **before** ETHGlobal Tokyo 2026 started (hacking began 2026-09-25 21:00 JST). It is **pre-existing work and is not claimed** as hackathon work. The claim covers only `pre-tokyo-2026..tokyo-2026-submission` on the paths listed in the submission, and this folder is excluded from that range.

It is here because the event rules ask for the spec files, prompts and planning artifacts behind AI-assisted work. Most files are in Japanese, the working language of the plan.

| Path | What it is |
|---|---|
| `PLAN_PUBLIC.md` | The implementation plan: external facts (§2), what gets built (§3), the Sepolia transaction list (§4), tests (§5), fixed values (§10) |
| `CHANGES*.md` | How the plan changed between versions, and why |
| `ORDERS.md`, `AGENT_PROMPTS.md`, `COMMANDS.md` | The work orders and prompts prepared for AI agents, and the commands to run |
| `v3.3/PLAN_DIFF.md`, `depth/DESIGN.md` | Earlier design notes |
| `e15/`, `a3/`, `hw/src/` | Read-only measurements taken before the event (eth_call, eth_simulateV1): scripts and raw results |
| `monitor/`, `rehearsal/` | The checks run every morning before the event, and the rehearsal suite that replays the planned transactions in simulation |

**Not included, on purpose** (each one exists, and the reason is given rather than left out silently):
- The strategy sections of the full plan (how the submission is pitched, time plan, what to drop under time pressure, risk branches), and notes on other projects: competitive, not technical.
- The design notes for the judge-button guards: the guards themselves ship as tests in the claimed code (`tests/tokyo-mutate*.ts`); the notes add an attacker's checklist and nothing a reviewer needs.
- Findings reported privately to a sponsor: kept private until the sponsor has confirmed them, as I told them I would.
- Internal to-do lists.

Nothing here contains keys, seeds or secrets. All addresses and transaction hashes are public Sepolia or Base data.
