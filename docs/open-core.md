# Open Core — What Is Open, What Is Not

> Status: statement of the current boundary. This document describes what
> already exists; it proposes nothing. When the code and this document
> disagree, the code wins — and this document should be fixed.

vet402 is open source. The thing that makes vet402 useful is not the code.
This document draws that line precisely, so that contributors, self-hosters,
and reviewers know exactly what they get and what they do not.

## 1. Open (MIT): everything in this repository

All of the following is MIT-licensed and reproducible by anyone:

- **The full service source** — Observatory catalog sync, L0 prober, L1
  purchase runner, L2 conformance diff, scoring engine, SpendGuard verdict,
  accuracy ledger, all API routes and pages.
- **The npm packages** — `@vet402/sdk`, `@vet402/middleware`,
  `@vet402/mcp-server` (published from `packages/`).
- **The self-host path** — `docker compose up` brings up Postgres + the app
  (see `CONTRIBUTING.md`, `docs/deployment.md`). Nothing in the verification
  logic is held back from the self-host build.
- **The methodology** — published at
  <https://vet402.com/observatory/methodology>; the code implementing it is
  in `src/lib/observatory/`.
- **The schema** — Drizzle definitions in `src/lib/db/`, including the
  tables named below. The table *shapes* are open; see §2 for the contents.

There is no "enterprise edition" branch, no proprietary plugin directory,
and no feature flag that hides verification logic from self-hosters. The
one capability that is off by default everywhere — guarantee underwriting
(`GUARANTEE_UNDERWRITING_ENABLED`, see
`docs/guarantee-underwriting-design.md`) — is off for the hosted service
too, pending a business and legal decision; it is not an open/proprietary
split.

## 2. Not open: the accumulated record

What is not in the repository, and is not licensed to anyone, is the
operational record the hosted service has accumulated by running:

- **The L1 purchase ledger** — the contents of `x402_l1_purchases`: as of
  2026-08-20, 845 real purchase attempts across 843 endpoints, 341
  settled, each settlement with its Base tx hash, and the 504 non-settling
  attempts recorded with the same weight. The individual settlement facts
  are independently checkable on-chain; the assembled ledger — which
  endpoint, at what time, at what listed price, with what outcome and what
  L2 conformance result — exists only in the production database.
- **The L0 probe history and lifecycle record** — `x402_l0_probes` and
  `x402_delisting_events` contents: daily catalog snapshots, 2,887 delist
  and 186 relist events, 3 settle-drops (figures from
  `/api/v1/observatory/state`, retrieved 2026-08-20). A fresh install
  starts this history at zero and can only accumulate it at one day per
  day.
- **The accuracy ledger contents** — vet402's own resolved hit/miss record
  (published at <https://vet402.com/accuracy>). The guarantee-underwriting
  math prices exclusively off this record; an empty record means
  `canOffer: false`, by design.
- **Operational credentials** — the funded purchase wallet and its key,
  production API secrets, database credentials, and the cron/monitoring
  configuration that keeps the daily batches honest. These are secrets,
  not licensable assets, but they are part of what a clone does not get.

The structural point, stated plainly: **the code can be copied in a day;
the record can only be re-earned in real time, with real money, one
purchase at a time.** A fork running the same MIT code is a different
observatory with an empty ledger — its verdicts carry whatever weight its
own record earns.

Public aggregates over the record stay free and key-less
(`/api/v1/observatory/state`, the observatory pages, the badge SVGs).
Openness of the *facts* is a neutrality requirement (see
`docs/ARCHITECTURE.md` §7); what is proprietary is the underlying
row-level history and the operations that produce it.

## 3. What a self-hoster gets, and does not get

| | Self-hosted vet402 (MIT) | Hosted vet402.com |
|---|---|---|
| Verification code (L0/L1/L2, scoring, SpendGuard) | Yes — identical | Yes |
| SDK / middleware / MCP server | Yes — same npm packages | Yes |
| Catalog sync against the public x402 catalog | Yes — runs from day one | Yes |
| L0 probe results | Yes — own probes, own history from zero | Yes — history since launch |
| L1 purchase ledger | Own ledger, funded by own wallet, from zero | 845 attempts / 341 settlements as of 2026-08-20, growing daily |
| Lifecycle history (delists / relists / settle-drops) | Accumulates from install date | Since launch |
| Accuracy ledger | Own record, from zero | vet402's published record |
| Guarantee underwriting math | Yes (code) — prices off own accuracy record, so `canOffer: false` until it has one | Same code; also currently off pending business/legal approval |
| Production wallet, secrets, cron history | No | Operator-only |
| The name "vet402" and its published corrections record | No — a fork speaks for itself | Yes |

None of this is a restriction imposed on self-hosters. It is the shape of
the product: vet402 sells nothing on the catalog it measures, so the only
asset the hosted service holds that a fork does not is time — the dated,
signed, independently checkable record of having actually bought things
and published what happened, failures included.

## 4. Boundary rules going forward

1. **Verification logic is never withheld from the open build.** If a new
   check ships to vet402.com, its code ships to this repository.
2. **Public fact surfaces stay key-less and free.** Aggregates with
   denominators, verdict pages, badges, and the methodology are part of
   the neutrality posture, not the revenue line.
3. **The proprietary asset is only ever the record and the operations** —
   row-level history, the funded wallet, and the accumulated accuracy
   ledger. Any future paid product must sell convenience or depth over
   that record, never a different verdict (see
   `docs/economic-capture-design.md`).
