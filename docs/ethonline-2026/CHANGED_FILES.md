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

## 2026-09-08 — SKILL.md live-check (branch `ethonline/skill-live-check`)

The 09-07 audit found SKILL.md curls that production no longer answered as written (`jq '.resources[0].resource_id'` → null);
the document had been written ahead of production and nobody re-ran it. New: `scripts/skill-live-check.mjs`,
`tests/skill-live-check.test.ts`, `.github/workflows/skill-live.yml` (daily 08:00 JST, opens an issue when red).

| File | Why |
|---|---|
| `SKILL.md` | Four production-facing blocks get a first-line `# live: expect <jq>` marker (one sentence at the top of *How a judge can run it* explains it); §4's expected output corrected to what production answers since 2026-09-07 (`invalid_api_key` rides along after `evidence_unavailable`, `caller_policy: null`, `decision_record: null`) — the very drift the gate exists to catch |
| `package.json` | `npm run skill-live` |
| `docs/ethonline-2026/WINDOW_PLAN.md` | §17's 09-10 "walk SKILL.md on a clean clone" replaced by reading the gate's daily run (§17.1); §1.7 arrow note |

## 2026-09-08 — boundary-shape tests (branch `ethonline/boundary-shapes`)

One table of malformed values (`packages/sdk/test/_shapes.mjs`) applied to every external input of
`payOrRefuse`, `pay_if_trusted` and the A/B bridge. Everything else in this branch is new work (test files,
one-line gates in `pay-or-refuse.ts` / `subgraph-evidence.ts` / `pay-if-trusted.ts` / `mcp.mjs`, mutations);
the only pre-existing file touched is:

| File | Why |
|---|---|
| `SKILL.md` | One sentence under `npm run judge-check` saying the boundary-shape suites exist and what they assert (no number written by hand) |

## 2026-09-08 — `l1_inconclusive` (branch `ethonline/l1-inconclusive`)

Production measured on 2026-09-08: api.exa.ai (`521e929e…`) showed `attemptCount 10 / settledCount 10 /
inconclusiveCount 10` on `/purchases` but `n_attempts 0 / n_settled 0 / n_probe_error 10` on `/facts`, and
`/decision` said `l1_not_attempted` — the same ten rows counted under two vocabularies, a seller we paid ten
times published as "never attempted". Fix: settled/4xx rows count in `n_attempts` / `n_settled` (same set as
`/purchases`), a new `n_inconclusive` field, and the rules read `conclusive = n_attempts − n_inconclusive`
so our own 4xx never adds up to a BLOCK; a seller with attempts but no conclusion gets the neutral
`l1_inconclusive` (WARN). Rules version `2026-09-08.1`. New: `tests/l1-inconclusive.test.ts`.

| File | Why |
|---|---|
| `src/lib/decision/seller-facts.ts` | `n_attempts` / `n_settled` include inconclusive rows; `n_inconclusive` from the one `isInconclusive` definition in `delivery.ts`; `n_probe_error` kept as the same value (deprecated) |
| `src/lib/decision/rules.ts` | `conclusiveAttempts()`; BLOCK / `l1_never_delivered` / opt-in read `conclusive`; `l1_inconclusive` when attempts > 0 and conclusive = 0; `DECISION_RULES_VERSION` → `2026-09-08.1` |
| `src/lib/decision/types.ts`, `packages/sdk/src/index.ts` (+ `dist/index.d.ts`) | `SellerFacts.l1.n_inconclusive`; `n_probe_error` marked deprecated |
| `docs/openapi.yaml` | `n_inconclusive` property and required; `n_probe_error` deprecated; `reason_codes` description lists the four L1 words |
| `tests/openapi-schema-parity.test.ts`, `tests/seller-facts.test.ts`, `tests/decision-rules.test.ts`, `tests/decision-build.test.ts`, `tests/acceptance-spec-1-2.test.ts`, `tests/passport-facts-summary.test.ts` | field list and fixtures carry `n_inconclusive`; the old "probe_error is not an attempt" test now asserts the new counting; rules version pinned to `2026-09-08.1` |
| `src/app/observatory/methodology/page.tsx`, `src/app/docs/api/page.tsx` | one paragraph / one sentence defining `l1_inconclusive` as our gap (the vocabulary gate requires the term in prose) |
| `packages/mcp-server/src/index.ts` (+ `dist/index.js`) | `check_resource_decision` description names the four L1 reason codes and whose gap each is |
| `SKILL.md` | the "our gap" sentence now covers both `l1_not_attempted` and `l1_inconclusive` |
| `docs/ethonline-2026/WINDOW_PLAN.md` | §16 F3 measured row updated to the 09-08 words (09-05 values kept beside them); dated notes after the `not_attempted_reason` paragraph and at the end of §16.5 (pre-registration body untouched) |
| `docs/ethonline-2026/fixtures.md` | dated note: 0x.org reads `l1_inconclusive` from 09-08 |
