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

## Snapshot — 2026-09-07 08:5x JST (derived; regenerate with the command below)

```bash
git diff --diff-filter=M --name-only pre-ethonline-2026..main \
 | awk -F/ '{ if ($1=="src" && $2!="") a=$1"/"$2; else if ($1=="packages" && $2!="") a=$1"/"$2; else if (NF==1) a="repo root"; else a=$1; c[a]++ } END { for (k in c) printf "%d\t%s\n", c[k], k }' | sort -rn
```

**<!-- n:window_modified_files -->183<!-- /n --> pre-existing files modified, by area** (the counts are the command's output; the "why" column is prose):

| Area | Files | Why we were in there |
|---|---|---|
| `src/app/` | 48 | Admin route for the runtime spending halt; observatory/state surfaces with the two-tier `settled` split; `/decision` key-less read and `caller_policy`; SEO/AEO; site consistency (header month derived at build time instead of a hand-written "August 2026", the `/observatory` note on what `active` counts, the SKILL.md link in `/docs/api`, the 404 title for a malformed `/agent/<id>`) |
| `src/lib/` | 36 | Kill switch; settlement rollup and late-settlement recovery; nonce binding; census coverage; cached reads; `caller-policy.ts`; repo hygiene 09-07: gate2 report no longer defaults to a hard-coded operator e-mail; `sol402-payer.ts` builds its two SPL Token calls from `spl-token-lite.ts` so production carries no `bigint-buffer`; 09-07 money-gate fixes: `public-route.ts` returns the consumed `bucketKey` (A7) |
| `tests/` | 32 | Tests for all of the above, the Postgres test guard, key-less read, caller-policy parity, refresh-numbers |
| `docs/` | 26 | The window's own planning artifacts, three security audits, the incident runbook, OpenAPI; `docs/hackathons/2026-autumn-continuity.md` (A/B vocabulary figure corrected 2026-09-07); repo hygiene 09-07: personal e-mail addresses in ROADMAP/continuity replaced by a reference to the disclosure |
| `packages/mcp-server` | 17 | `pay_if_trusted`, evidence policy, the uncatalogued path, key-less `/decision`, typed refuse reasons; repo hygiene 09-07: lockfile bumps for the fast-uri / hono / ip-address / qs advisories (supersedes Dependabot #8–#11) |
| repo root | 8 | `README.md`, `AI_USAGE.md`, `SKILL.md`, `.env.example`, `.gitignore`, `package.json`, config. 2026-09-07: `README.md` and `SKILL.md` corrected after the judge-doc audit (production `/decision` body, timings, dates, wording); repo hygiene 09-07: `.gitignore` wallet/keystore patterns, package name `vet402`, `@solana/spl-token` moved out of production deps |
| `packages/sdk` | 7 | `payOrRefuse`, the x402 payment path, the subgraph evidence source, optional `apiKey`, typed refuse reasons |
| `scripts/` | 5 | Schema drift, settlements rollup, judge-check; repo hygiene 09-07: dev-setup / provision-neon print DATABASE_URL with credentials masked |
| `src/components` | 2 | Proxy/CSP |
| `public/` | 1 | `llms.txt` (key-less `/decision`) |
| `.github/` | 1 | Pinning actions to SHAs; the gate jobs |

The per-area sum must equal the total above; if it does not, the table is stale — rerun the command.

## What counts as new work

Files created during the window are new work and are listed by the second command above, not here.
Who wrote which parts — human or AI — is in [`../../AI_USAGE.md`](../../AI_USAGE.md).

## 2026-09-07 — money-gate fixes (branch `ethonline/fix-money-gates`, third-party audit A1–A7)

Pre-existing files touched by these commits (the first three were already in the window's modified set
above; `public-route.ts` is new to the set — rerun the command for the counts; this note only says *why*):

| File | Why |
|---|---|
| `packages/mcp-server/src/index.ts` | `pay_if_trusted` description: the new SDK word `price_above_declared` (A3); "runs the whole gate" replaced by what actually runs without a payer (D4) |
| `SKILL.md` | `pay_if_trusted` refuse-reason list gains `price_above_declared` (A3); the *Actually paying* paragraph now describes the real no-payer / no-resource behaviour (D4) |
| `src/app/api/v1/resources/[resourceId]/decision/route.ts` | Every early return (400 / 404 / 503) goes through `fail()` → `finish()` so the key-less `RateLimit-*` headers and the keyed `X-RateLimit-*` headers are on those responses too; key-less early returns refund the IP window like keyed ones refund the monthly unit (A7) |
| `src/lib/api/public-route.ts` | `publicRateLimit` also returns the `bucketKey` it consumed, so a route can refund it on an early return (A7) |
