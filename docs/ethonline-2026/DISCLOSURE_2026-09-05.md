# Written disclosure to ETHGlobal — sent 2026-09-05 08:49 JST

A copy of the message we sent to ETHGlobal before judging, so the disclosure that `README.md` and
`AI_USAGE.md` refer to is in the repository and not only in a mailbox.

| | |
|---|---|
| Sent | **2026-09-04 23:49 UTC** = 2026-09-05 08:49 JST (Gmail, label `SENT`) |
| From | Takeshi Kazumoto (`kazumototakeshi@gmail.com`) |
| To | `hello@ethglobal.com` |
| Subject | `Continuity disclosure — vet402 (ETHOnline 2026)` |

## The message, verbatim

```
Hi ETHGlobal team,

vet402 applied to the ETHOnline 2026 Continuity track on 2026-08-23. Ahead of judging we want to state, in writing, exactly how much work predates the window.

Between our application and the window opening we continued normal product work on main: 207 commits, 412 files, +28,414 / -1,913 lines. The largest single day was 2026-09-02 (99 commits), when we shipped our product spec v1.0; 2026-09-03 added 11 more.

We tagged the boundary in the public repo as pre-ethonline-2026 (commit c42daca, 2026-09-04 00:05:36 UTC — five minutes after the window opened). Everything we submit as hackathon work is exactly `git log pre-ethonline-2026..main`, and the tag is pushed so you can verify it yourselves: https://github.com/kzmttkc/vet402

Please tell us if you would like this in a different form, or anything else on the record.

Takeshi Kazumoto — vet402
```

## Why the numbers above differ from `README.md` today

The message says **207 commits**; `README.md` and `AI_USAGE.md` now say **214**. Both describe the
same range — the file figures are identical and come from the same two commits
(`git diff --shortstat 26a7c66..pre-ethonline-2026` → `412 files changed, 28414 insertions(+), 1913 deletions(-)`).
The commit count in the message was written to match its day-by-day sentence, which stops at
2026-09-03 ("2026-09-03 added 11 more"), so it excludes the **7 commits dated 2026-09-04 in JST**
that landed between midnight JST and the tag at 09:05 JST (00:05 UTC):
`git rev-list --count --until=2026-09-03T23:59:59+09:00 26a7c66..pre-ethonline-2026` → 207.
On 2026-09-06 (commit `f844ae6`, after an independent audit found that the number in `README.md` did
not reproduce) we attached the command the count is derived from and counted the whole range up to
the tag: `git rev-list --count 26a7c66..pre-ethonline-2026` → 214. Per-day figures that anyone can
re-derive: `git log --format=%ad --date=short 26a7c66..pre-ethonline-2026 | sort | uniq -c`
(2026-09-02: 99, 2026-09-03: 11, 2026-09-04: 7). The same commit also corrected the message's last
claim — `main` is this product's production branch, so `git log pre-ethonline-2026..main` contains
work we are **not** submitting; the range we do claim is in `README.md`.

## Why the window start in the message is wrong — corrected 2026-09-08

The message says the tag was cut **five minutes after the window opened**. That is wrong. We had taken
2026-09-04 00:00 UTC as the start. ETHGlobal's own published schedule for ETHOnline 2026 puts
`hacking-begins` — and `ethonline-2026-kickoff` — at **2026-09-04 16:00:00 UTC**:

```bash
curl -sL https://ethglobal.com/events/ethonline2026 | grep -o 'hacking-begins[^]]\{0,120\}'
# ..."name":"Hacking Begins!" ... "startTime":"2026-09-04T16:00:00.000Z" ... "status":"confirmed"
```

Measured against 16:00 UTC:

| | |
|---|---|
| Boundary commit `c42daca` (what the tag points at) | 2026-09-04 00:05:36 UTC — **15 h 54 min before** hacking began |
| The annotated tag object itself | 2026-09-04 02:45:06 UTC — 13 h 15 min before hacking began |
| Commits in the range we claim that were made **before** 16:00 UTC | **3** |

We are not moving the tag. It was pushed on 2026-09-04, and this disclosure and the submission link to
it; re-cutting it would invalidate those links. The consequence is stated rather than hidden: the range
we claim — `pre-ethonline-2026..main` under the path filter in `README.md` — contains three commits made
before the window opened. Anyone can list them:

```bash
TZ=UTC git log --until='2026-09-04T16:00:00+00:00' --format='%h %cd %s' --date=iso-local \
  pre-ethonline-2026..main -- packages/sdk packages/mcp-server \
  examples/ethonline-2026-demo examples/ethonline-2026-ab SKILL.md AI_USAGE.md docs/ethonline-2026
```

- `37c56db` — 2026-09-04 07:47:22 UTC — `docs/ethonline-2026/WINDOW_PLAN.md` only (+23 / −5)
- `e668957` — 2026-09-04 08:00:42 UTC — `docs/ethonline-2026/WINDOW_PLAN.md` only (+55 / −2)
- `ac6ec2e` — 2026-09-04 10:29:07 UTC — `feat(settlements)`: **+6 lines** in `packages/sdk/src/index.ts`,
  plus `docs/openapi.yaml`, `scripts/settlements-rollup.ts`, `scripts/sql/2026-09-04-w15.sql` and the
  production code and tests behind them

The wording "five minutes after the window opened" also stood in `README.md`, `AI_USAGE.md`,
`SUBMISSION_DRAFT.md`, `README_CONTINUITY_SECTION.md`, `CHANGED_FILES.md`, `VIDEO_SCRIPT.md` and
`LIVE_JUDGING.md`. It was corrected in all of them on 2026-09-08. The message above is left verbatim,
as sent.
