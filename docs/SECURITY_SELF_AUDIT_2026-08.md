# Vouch — Internal Security Self-Audit (2026-08)

**This is an INTERNAL self-audit, not an external penetration test.** It was
performed by the same engineering effort that hardened these paths, taking a
deliberate attacker's-eye second pass after the fixes landed. It is not a
substitute for a third-party pentest — see "Residuals for external pentest" at
the end. Do **not** represent Vouch as "externally audited" on the basis of
this document.

- Scope: the security layer and user-facing surfaces (key-less public API
  paths, dashboard auth, signup/login, webhooks, CSP, information exposure).
- Method: after implementing the fixes below, re-walk each attack surface as an
  attacker would, from the boundary inward.
- Commit context: the fixes referenced here were committed 2026-08-06 (see the
  `fix(vouch): harden key-less API paths …` commit and the follow-ups).

---

## Fixed in this pass

### 1. Rate-limit visibility on key-less paths (was: invisible / absent)
- **Before:** `GET /api/v1/payees/verify` had no rate limit; `POST` returned a
  bare `429` with no `RateLimit-*`/`Retry-After`; `/api/badge/:address` had no
  limit. A signature proves wallet control but wallets are free to mint, so the
  signature is not a cost barrier — public `/payee` profiles and badges could be
  mass-produced (namespace pollution, DB bloat).
- **Fix:** `consumeIpRateLimit` now returns `{limit, remaining, resetAt}` and a
  new `ipRateLimitHeaders()` emits standard `RateLimit-Limit/Remaining/Reset`
  (plus `Retry-After` on throttle) on **every** response of the key-less paths
  (`payees/verify` GET+POST, `badge`, `demo/score`, `accuracy`). `POST verify`
  additionally enforces a **per-wallet** write throttle, so one wallet cannot
  hot-loop its public profile even across many IPs.

### 2. Signed-message canonicalization (was: line-injection)
- **Before:** the payee registration message is documented as a fixed 4 lines,
  newline-joined. A `name` containing `\n`/`\r`/`\t` forged extra lines — e.g.
  `name = "Acme\nwallet: 0xEVIL"` produced a message with a second `wallet:`
  line that a line-oriented parser mis-attributes. `GET` and `POST` could also
  disagree if only one side sanitized.
- **Fix:** `isCanonicalName()` rejects control characters (U+0000–001F incl.
  newline/CR/tab, DEL, C1), enforces trim and a 64-char cap, and is applied at
  the zod schema layer for POST **and** the GET preview. `payeeMessage()` throws
  on a non-canonical name — defense in depth so no future caller can fold a
  malicious name into the signed bytes. Covered by `tests/payee-verify.test.ts`.

### 3. Payee `name` input validation
- Length cap (64), control-character rejection, and required trim — the same
  `isCanonicalName` gate. `name` is reflected on the public `/payee/:address`
  page (React auto-escapes, so no stored XSS today) and is the natural input for
  future display surfaces; bounding it at the write boundary is the durable fix.

### 4. `/api/health` version/detail suppression
- **Before:** the unauthenticated probe returned `version: "0.1.0"`, `chain`,
  `erc8004` — fingerprinting material, and a `0.1.0` visible to prospects.
- **Fix:** unauthenticated response is now `{status:"ok"}` only. Service
  metadata moved behind the existing admin-gated `?deep=1` path.

---

## Attack surfaces reviewed (no change required)

- **Authorization boundaries.** Dashboard mutations go through
  `authorizeDashboardRequest` (httpOnly session cookie + same-origin check +
  quota). API v1 routes authenticate by API key. Per-resource writes I sampled
  scope by `apiKeyId` (`deleteWebhook`, list/webhook `[id]` routes). No bypass
  found in the sampled routes. (Exhaustive per-`[id]` ownership fuzzing is left
  to the external pentest.)
- **Webhook SSRF.** `isSafeWebhookUrl` enforces https-only, rejects
  credentials-in-URL, IPv6 literals, and IPv4 private/reserved/CGNAT/link-local
  ranges and internal suffixes; delivery uses `redirect: "error"`, a hard
  timeout, and **re-validates the URL at delivery time**. Signature is
  Stripe-style HMAC-SHA256 over `${t}.${body}`, verified with `timingSafeEqual`
  and a replay tolerance. Solid against the string-level vectors. (DNS
  rebinding residual noted below.)
- **Signature verification.** Payee proof via viem `verifyMessage` (EIP-191/6492)
  over the now-canonical message; admin via `secureCompare`; webhook via
  constant-time HMAC. No timing or canonicalization gaps found post-fix.
- **CSP.** Per-request nonce + `strict-dynamic`, `frame-ancestors 'none'`,
  `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`. The new Server
  Actions post same-origin, consistent with `form-action 'self'`.
- **Information exposure.** Error responses are fixed generic codes; server
  errors go through `logServerError`, not the response. `/api/health` minimized
  (above).

---

## 2026-08-15 — two independent passes, same day

**Still an INTERNAL self-audit, not an external penetration test.** Two
sessions worked this repo in parallel today without coordinating in advance
and each found real, overlapping issues; this section reconciles both into
one record so neither is silently lost or duplicated.

**Session A** (commit `89f247c`, 4-track parallel audit: SQL injection,
auth/session/secrets, payment cryptography, web/OWASP baseline) fixed, with
reproduced real-world impact:
- **L1 budget TOCTOU** — the observatory's daily $25 spend cap was bypassed by
  concurrent batch runs; $49 actual spend reproduced. Fixed with a
  single-statement DB reservation (`reserveSpend()`) before signing, and the
  allowed overshoot window shrunk to ≤$1 (one item).
- **Observatory SSRF** — L0 probes and L1 purchases fetched third-party
  catalog-supplied URLs unvalidated (link-local/private IPs reachable). Fixed
  with a shared `safeFetch`/`isPublicUnicastIp` extracted from the existing
  `src/lib/webhooks.ts` IP-classification logic. (2026-09-02 audit P2-1: the
  gate resolved once and fetch resolved again to connect, leaving a
  DNS-rebinding window; closed by pinning the socket to the gate-verified
  addresses via an undici connector `lookup` — `src/lib/net/pinned-fetch.ts`,
  tests in `tests/safe-fetch-pinning.test.ts`.)
- **fail-closed spend accounting** — a crash between signing and ledger write
  could drop real spend from the budget calculation; the reservation row is
  now committed before signing, removing the fallback path that could miss it.
- `/api/health` — key-less, chain-reading, and unrated; added per-IP 60/min.
- `billing/checkout` — returned raw `error.message`; fixed to a constant code
  (independently found and fixed the same day by Session B below — same fix,
  landed once).
- `dashboard login` — a control-character API key string could force an
  unauthenticated 500; now fails closed to 401.

**Session B** (this document's prior maintainer, full-`src/` pass — six
parallel reviewers covering auth, billing/quota, payee+agent signatures,
public API v1 + DB, admin/cron/chain, and availability/integrity) found and
fixed:
- **Agent passport / verified payee: `url` was not part of the signed
  message (High).** `GET /api/v1/agents/{agentId}/passport` publishes
  `{message, signature}` key-less by design (third-party verifiability is the
  point). Because `url` was accepted and stored but never signed, a published
  proof could be replayed with a different `url` and re-verify true, letting
  anyone repoint a "verified" badge's link. **Independently found and fixed
  the same day, differently, by whichever session landed `0ad77f9`
  (`feat(ux): UXを業界最高水準へ`) first** — that fix binds `url` into the
  signed message via an optional 4th/5th line
  (`isSafeBoundUrl`/`payeeMessage(wallet, name, url?)`) with no schema change,
  verified by re-reading `src/lib/verify-message.ts` and the two verify
  routes after the fact. Both fixes closed the same hole via different
  mechanisms; the version that landed first is what's live, and this
  document does not re-litigate which approach was "better" — it works.
  **Resolved 2026-08-18:** signatures used to be replayable indefinitely (no
  nonce/timestamp/expiry) — an old still-valid signature could "refresh"
  `verifiedAt` on a stale claim, or roll back a corrected `name`/`url` to an
  earlier signed value. Fixed by binding an `issued` line into the signed
  message (verify-message.ts), a ±10-minute freshness window checked in the
  POST routes, and a single-statement monotonic DB write
  (`onConflictDoUpdate ... setWhere issued_at IS NULL OR issued_at < $new`) on
  both `verified_payees` and `agent_passports` — replaying an older signature
  now returns `409 stale_signature`, never a rollback. Pre-migration rows
  (`issued_at NULL`) stay third-party-verifiable: the passport read-path
  reconstructs candidate message shapes newest-first and returns whichever the
  stored signature verifies against. Migration
  `scripts/sql/2026-08-18-signature-freshness.sql` (adds `issued_at` to both
  tables; **apply to the `vouch` production database before/at deploy**).
  Covered by `tests/verify-issued-monotonic.test.ts`.
- **Quota consumed even when the request itself failed (High).**
  `applyRateLimit()`/`authorizeApiRequest()` reserves a unit before
  `scoreAgentById`/`scoreWallet`/`scorePayeeWallet` runs; an upstream failure
  (RPC/Blockscout/DB outage → 503) never credited it back, so a failed,
  answerless request still counted against the customer's monthly quota — and
  retrying during an outage burned quota faster. Fixed with
  `refundRateLimit()` (`src/lib/api/rate-limit.ts`), called from the `catch`
  branch of all four scoring routes after the original failure is already
  being reported.
- **Stripe subscription webhooks trusted the event's own snapshot
  (Medium).** `customer.subscription.updated`/`.deleted` applied
  `event.data.object` directly. Stripe does not guarantee delivery order; a
  retried, older delivery arriving after a newer one already applied could
  pin an account to a stale plan. `checkout.session.completed` and (as of
  Session A/B's parallel `invoice.payment_failed` additions)
  `invoice.payment_failed` already re-fetched from Stripe — the
  `updated`/`deleted` branch now matches, calling
  `stripe.subscriptions.retrieve()` before applying.
- **`dashboard/lookup` authorized after parsing the request body
  (Low).** Reordered to match every other dashboard route (parser-shape
  oracle only; no data or side effect was reachable either way).
- **`STRIPE_WEBHOOK_SECRET` / price IDs were not required in production env
  validation (Low — availability/revenue, not a security hole; the webhook
  route already fails closed with 503 when the secret is missing).**
  `collectProductionEnvIssues()` now requires `STRIPE_WEBHOOK_SECRET` (min 32)
  and both `STRIPE_PRICE_*` vars whenever `STRIPE_SECRET_KEY` is set.
- **`updateAccountPlan` writes `accounts.plan` and `apiKeys.plan` as two
  non-transactional statements (Low).** Reordered to write `apiKeys` (what
  quota enforcement reads) first, so a failure between the two leaves a
  paying customer's entitlement already correct with only the display briefly
  stale. Not wrapped in `db.transaction()`: the Neon HTTP driver's
  transaction support was judged more risk to introduce untested than the
  narrow window it closes here.
- Drive-by: `src/app/dashboard/lookup/page.tsx` was using a bare `<a>` for an
  internal link (`@next/next/no-html-link-for-pages` lint error, pre-existing
  on `main`, unrelated to either audit) — fixed to `next/link` while touching
  the adjacent file.

### Reviewed — no change needed (evidence, not just a claim)

- **`/api/health` is not a placebo** — probes the real seller-side and
  buyer-side scoring paths concurrently; confirmed by reading `./liveness.ts`
  and the two probes, not by trusting the endpoint name.
- **Owner quota reservation is a single atomic SQL statement**
  (`onConflictDoUpdate ... setWhere`) — confirmed by rendering the actual SQL
  Drizzle 0.45.2 emits. No TOCTOU on the reservation itself (the bug fixed
  above was about *when* the reservation happens relative to the work, not a
  race on the reservation).
- **Webhook (outbound) SSRF**: DNS-resolves at delivery time, validates every
  resolved address is public unicast, and pins the socket to the validated IP
  — the DNS-rebinding gap flagged as residual item 1 below (2026-08-06) is
  closed.
- **SQL injection, path traversal, command injection**: none found anywhere
  in `src/` by either pass.
- **cron/admin auth**: fail-closed, `secureCompare`, 32-char minimum enforced
  at boot; all 8 cron routes match `vercel.json`'s 8 cron definitions.

### New residuals (Takeshi手番 / follow-up)

- ~~**Signature replay / freshness**~~ **Resolved 2026-08-18** — signed
  `issued` line + freshness window + single-statement monotonic write on both
  passport tables. See the 2026-08-18 entry above. (Implemented with a
  dedicated `issued_at` column rather than reusing `verifiedAt`, because
  `verifiedAt` is set to `now()` on every write and so cannot double as the
  monotonic comparison key.)
- **`stripe_events` de-duplication table** — the `retrieve()` fix above closes
  the ordering bug; a dedicated idempotency table would additionally stop
  redundant reprocessing of retried deliveries. Not urgent (reprocessing is
  itself idempotent).
- **Two coexisting dashboard design languages**: marketing/RFC pages use
  `.sheet`/`.doc-head` tokens; the dashboard uses a separate `dash-*`
  component system (`0ad77f9`) that still carries `zinc-*` utility colors
  rather than the approved brand palette. Intentional per that commit's own
  message, not a bug — flagged for whoever next touches dashboard visuals so
  it isn't "fixed" back and forth between the two conventions.
- **Webhook/watchlist registration limits (5 / 50 per key) are
  check-then-act**, not atomic. Low impact (egress/scan surface, not money).
- **`x402_payments` idempotency relies on a unique-constraint exception**,
  not `ON CONFLICT DO NOTHING` — a genuine duplicate delivery gets a 503
  instead of a clean idempotent 200. Low; data never double-records.
- **Feedback indexer checkpoint pair is not atomic** — a crash between
  pruning and the second checkpoint write can leave coverage stale, producing
  a silent undercount on the next read.

---

## Residuals for external penetration test (Takeshi手番)

An external, contracted pentest remains a paid engagement and is Takeshi's call.
The following are the highest-value items for it, honestly flagged:

1. ~~**Webhook DNS rebinding (SSRF, string-guard limit).**~~ **Resolved** —
   delivery now resolves DNS, validates every resolved address is public
   unicast, and pins the socket to the validated IP. See 2026-08-15 above.
2. **Exhaustive per-resource authorization fuzzing** across every `/api/v1/**/[id]`
   route (watchlist, webhooks, events/outcome) for horizontal privilege
   escalation between API keys / owners. Re-confirmed by code reading on
   2026-08-15; a fuzzer running real requests against real tokens is still
   the stronger form of this check and remains an external-test item.
3. **Rate-limit correctness under multi-instance serverless.** The in-memory
   fallback is per-instance; production fails closed without a DB, but the
   DB-backed limiter's behavior under high concurrency (the atomic upsert path)
   deserves load-level verification (confirmed correct by construction on
   2026-08-15; a concurrency *test* is still the external-test-worthy item).
4. **`style-src 'unsafe-inline'`** remains (Tailwind/inline styles). Low risk,
   but a CSP-focused reviewer should confirm no inline-style injection sink.
5. **Session/cookie lifecycle**: fixation, rotation on privilege change, and
   logout completeness across the `dashboard_sessions` table. (2026-08-15:
   tokens are `randomBytes(32)`, hashed at rest, rotated on login,
   `httpOnly`+`sameSite=strict`+`secure`; only open note is the missing
   `__Host-` cookie prefix, low priority while hosted on `vercel.app`.)
6. **Signature replay/freshness for verified payees and agent passports** —
   see the 2026-08-15 residuals above.

---

_Last updated 2026-08-15. Internal self-audit only — see the dated sections above for what each pass covered._
