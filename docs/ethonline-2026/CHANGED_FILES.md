# Pre-existing files touched during the ETHOnline 2026 window

**Do not hand-maintain a list here. Generate it.** A hand-written table went stale within a day
(2026-09-05: this file said "none yet" while 148 pre-existing files had already been modified).
The same failure appeared three times in this window whenever a number was written by hand,
so the rule is the same as `WINDOW_PLAN.md` §4: **keep the identifiers, derive the counts.**

## The command (this is the disclosure)

```bash
git diff --diff-filter=M --name-only pre-ethonline-2026..main    # pre-existing files we edited
git diff --diff-filter=A --name-only pre-ethonline-2026..main    # files we created
git log --oneline pre-ethonline-2026..main                        # every commit in the window
```

The boundary tag `pre-ethonline-2026` is commit `c42daca`, cut **2026-09-04 00:05:36 UTC**, five
minutes after the window opened, and it is pushed. Anyone can run the three commands above.

## Snapshot — 2026-09-05 10:45 JST

**148 pre-existing files modified, by area:**

| Area | Files | Why we were in there |
|---|---|---|
| `src/app/` | 42 | New admin route for the runtime spending halt; the observatory/state surfaces gaining the two-tier `settled` split; SEO/AEO work on the public pages |
| `src/lib/` | 30 | The kill switch; settlement rollup and late-settlement recovery; nonce binding; census coverage; cached reads |
| `tests/` | 27 | Tests for all of the above, plus the Postgres test guard |
| `docs/` | 20 | The window's own planning artifacts, three security audits, the incident runbook, OpenAPI |
| repo root | 9 | `README.md`, `AI_USAGE.md`, `SKILL.md`, `.env.example`, `.gitignore`, config |
| `packages/mcp-server` | 9 | `pay_if_trusted` and its docs |
| `packages/sdk` | 5 | `payOrRefuse`, the x402 payment path, the subgraph evidence source |
| `scripts/` | 3 | Schema drift, settlements rollup |
| `src/` (other) | 2 | Proxy/CSP |
| `.github/` | 1 | Pinning actions to SHAs |

**Regenerate this snapshot before submission.** The numbers move every day; the command does not.

## What counts as new work

Files created during the window are new work and are listed by the second command above, not here.
Who wrote which parts — human or AI — is in [`../../AI_USAGE.md`](../../AI_USAGE.md).
