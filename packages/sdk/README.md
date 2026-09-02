# @vet402/sdk

Thin TypeScript client for the [vet402](https://vet402.com) Trust API. Node 20+,
ESM, zero runtime dependencies.

```bash
npm install @vet402/sdk
```

Get a key at [vet402.com/dashboard/keys](https://vet402.com/dashboard/keys),
export it as `VOUCH_API_KEY`, and this runs as-is:

```typescript
import { createVouchClient } from "@vet402/sdk";

// apiUrl defaults to https://vet402.com/api/v1 — pass it only to point at
// another deployment (a local dev server, say).
const vouch = createVouchClient({ apiKey: process.env.VOUCH_API_KEY! });

// Seller side: "should I accept payment from this wallet?"
const score = await vouch.getWalletScore("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
console.log(score.trustScore, score.recommendation); // 0–100 and ALLOW | WARN | BLOCK — live values, they move

// Buyer side: "should my agent pay this wallet?"
const payee = await vouch.getPayeeScore("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045");
console.log(payee.score, payee.recommendation, payee.dataDepth);

// After an x402 payment settles, feed it back (weights future scores).
await vouch.attestX402Payment({
  wallet: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  txHash: "0x" + "11".repeat(32),
  resource: "/api/premium/data",
});
```

Methods: `getAgentScore`, `getWalletScore`, `getPayeeScore`,
`getPayeeVerdictFast`, `batchScore`, `attestX402Payment`, `createSpendGuard`,
and — since 0.5.0 — `getDecision` and `resolve`.

### `getDecision` / `resolve` (0.5.0)

Product spec §7.3 / §9.1: the canonical integration is one call that returns the
L0–L2 **facts** and the `ALLOW` / `WARN` / `BLOCK` **recommendation** in the same
document. `resolve` turns whatever you hold (a URL, a domain, an address, a tx hash,
a `chain:address` payee id) into the resource id that `getDecision` takes.

```typescript
const found = await vouch.resolve("https://api.example.com/v1/quote");
const resourceId = found.resource?.resource_id; // sha256 hex, or undefined when unlisted
if (resourceId) {
  const d = await vouch.getDecision(resourceId, { role: "payer", callerDialect: "v2" });
  // d.recommendation, d.reason_codes, d.facts (SellerFacts), d.freshness, d.evidence
  // Pay only on ALLOW with degraded === false. WARN and BLOCK are both a refusal
  // under the default allow-only policy.
}
```

`getDecision` needs a key (1 rate-limit unit per call; pass `idempotencyKey` to retry
without spending a second one). `resolve` is key-less on the wire but is sent through
the same client. Both are read-only; wiring the decision into `SpendGuard` is a later
release.

### Two fields that outrank `recommendation`

A payee score always carries `degraded` and `signalsUnavailable`, and **both
override the recommendation**:

| Field | Meaning | What you must do |
|---|---|---|
| `degraded: true` | An input could not be read **at all**. The body is a refusal, not a measurement. | Never treat as ALLOW. |
| `signalsUnavailable` non-empty | Some inputs were not measured (`wallet_metrics`, `native_drain`, `usdc_drain`, `outcome_history`) — a real but **partial** view, capped below ALLOW for that reason. | Never treat as ALLOW. |

`SpendGuard` already refuses both (`payee_score_degraded` /
`payee_partial_measurement`). If you read `getPayeeScore` directly, make the
same two checks yourself before moving money.

### Timeouts

Every request is bounded by `AbortSignal.timeout`, default
`DEFAULT_REQUEST_TIMEOUT_MS` (10 s), overridable per client:

```typescript
const vouch = createVouchClient({ apiKey: process.env.VOUCH_API_KEY!, timeoutMs: 3000 });
```

There is no way to disable it. `SpendGuard` is fail-closed, and a fail-closed
judgement that never runs is not a judgement — a timeout surfaces as
`payee_trust_unavailable` (a deny), never as a hang.

### verify-at-settle (`getPayeeVerdictFast`)

For facilitators and payment middleware that need the check **inside** the
settlement flow. This surface never computes: it returns the engine's already
pinned verdict, or an honest `cache_cold`.

```typescript
import { payeeVerdictFastAllows } from "@vet402/sdk";

const verdict = await vouch.getPayeeVerdictFast(payee);
if (!payeeVerdictFastAllows(verdict)) {
  void vouch.getPayeeScore(payee); // fire-and-forget warm, same cache (TTL 5 min)
  return queueForRetry();          // cache_cold is the ABSENCE of a verdict, not an allow
}
```

`SpendGuard` deliberately does not use it: the guard enforces `minPayeeScore`
bands and its own `maxScoreAgeMs` and reports the full `payeeScore`, none of
which the fast body can supply. It is a pre-check, not a replacement for
`getPayeeScore`.

> **On 0.1.0?** Check with `npm ls @vet402/sdk`. That release predates
> three things documented here: the `apiUrl` default (pass
> `apiUrl: "https://vet402.com/api/v1"` explicitly), the `VouchApiError` class
> (errors are plain `Error`s whose `message` is the API's code), and the
> fail-closed `trustPolicy` default (see SpendGuard below). Everything else
> below is the same on both.

## Errors

A non-2xx answer throws a `VouchApiError` carrying the API's machine-readable
code and the HTTP status, so you can tell *your key is wrong* from *we are
having a bad day* without parsing strings:

```typescript
import { VouchApiError } from "@vet402/sdk";

try {
  await vouch.getPayeeScore("0x...");
} catch (err) {
  if (err instanceof VouchApiError && err.status === 401) {
    // err.code === "missing_api_key" | "invalid_api_key" — fix the key.
  }
}
```

## SpendGuard — pre-payment policy for agents

Buyer-side counterpart to the score lookups above: before your agent *pays*
someone, ask the guard. It returns an allow/deny decision plus
machine-readable reasons — and nothing else. SpendGuard is strictly
non-custodial: it never touches keys, funds, signing, or transaction
submission. Execution stays with your wallet stack (Coinbase AgentKit,
Privy, ...).

> **BREAKING (v0.2.0): fail-closed by default.** Money moves only on a clean
> `ALLOW` verdict unless you explicitly opt out. With no `trustPolicy` set,
> every `evaluate()` performs the payee trust lookup and **denies** when:
>
> | Condition | Reason code |
> |---|---|
> | Recommendation is `WARN` or `BLOCK` | `payee_recommendation_not_allow` |
> | The score came from a degraded read | `payee_score_degraded` |
> | Partial measurement (`signalsUnavailable` non-empty) | `payee_partial_measurement` |
> | The lookup was refused for your key (401/403) | `payee_trust_unauthenticated` |
> | The lookup failed on our side (5xx, timeout, rate limit) | `payee_trust_unavailable` |
>
> Opt-outs: `trustPolicy: "block-only"` (WARN passes; BLOCK, degraded and
> failed lookups still deny) or `trustPolicy: "custom"` (pre-0.2.0 behaviour —
> only the rules you set apply, and the lookup only runs when
> `minPayeeScore` / `blockOnRecommendation` is set).
>
> **Which default do you have?** Check with `npm ls @vet402/sdk`. **0.1.0**
> has no `trustPolicy` option: the lookup runs only when you set
> `minPayeeScore` / `blockOnRecommendation`, which is what `"custom"` means
> here. **0.2.0 and later** are fail-closed out of the box.

```typescript
const guard = vouch.createSpendGuard({
  maxPerTxUsd: 10,             // deny any single payment above $10
  dailyBudgetUsd: 50,          // deny once today's allowed total would pass $50
  // trustPolicy: "allow-only" is the default: deny anything but a clean ALLOW
  minPayeeScore: 40,           // optional stricter floor on top of the policy
});

const decision = await guard.evaluate({ payee: "0x...", amountUsd: 5 });
if (decision.allow) {
  // hand off to AgentKit / Privy / your own signer
} else {
  console.error(decision.reasons); // e.g. ["payee_recommendation_not_allow"]
}
```

How it works:

- The local rules (`maxPerTxUsd`, `dailyBudgetUsd`) are optional — set only
  the ones you want. Under the default `trustPolicy: "allow-only"` the payee
  trust lookup (`GET /v1/payees/{address}/score`) always runs, but is skipped
  when a local rule already denied, so no quota is burned on a dead payment.
  Only `trustPolicy: "custom"` makes the lookup conditional on
  `minPayeeScore` / `blockOnRecommendation` being set — with `"custom"` and
  neither set, no API calls happen at all.
- Everything the guard cannot vet **fails closed**: a WARN/BLOCK verdict, a
  degraded read, a partial measurement, or a failed lookup all deny (reason
  codes in the table above). A failed lookup names *whose* problem it is:
  `payee_trust_unauthenticated` means the API key is missing or invalid and
  retrying will not help; `payee_trust_unavailable` means the upstream is
  unhappy and retrying might.
- Budget reservation is optimistic: once the local rules pass, the amount is
  reserved *before* the trust lookup awaits and returned automatically if the
  trust rules deny — so concurrent `evaluate` calls within one process cannot
  race past the daily budget together. If an allowed transfer then fails or
  is skipped, call `guard.release(amountUsd)` to give the reservation back.
- The daily budget counter lives **in this process's memory** (UTC day): it
  resets on process restart and is not shared across replicas. Treat it as a
  runaway-agent brake, not an accounting system — persist your own ledger if
  you need durable budgets.

## Links

Absolute, because relative repo paths do not resolve on the npm package page.

- [API key](https://vet402.com/dashboard/keys) — `VOUCH_API_KEY`
- [API docs](https://vet402.com/docs/api) · [OpenAPI spec](https://github.com/kzmttkc/vet402/blob/main/docs/openapi.yaml)
- [Runnable AgentKit SpendGuard demo](https://github.com/kzmttkc/vet402/tree/main/examples/agentkit-spend-guard)
- [x402 integration guide](https://github.com/kzmttkc/vet402/blob/main/docs/x402-integration.md)
- [`@vet402/middleware`](https://www.npmjs.com/package/@vet402/middleware) — seller side (x402 request gate)
- [`@vet402/mcp-server`](https://www.npmjs.com/package/@vet402/mcp-server) — MCP tool

MIT · [vet402](https://vet402.com)


## What the default actually does today (measured 2026-08-25)

**Under the default `trustPolicy: "allow-only"`, SpendGuard currently denies
every payee that exists.** Know this before you wire it into a payment path.
It is not a lookup failure — it is the engine's banding working as designed:

- an unregistered bare wallet is capped at **62** by the wallet engine;
- a payee with no *independent* receiving record is capped at **69**
  (`PAYEE_THIN_SCORE_CEILING`, the 2026-08-13 score-manipulation ruling);
- the ALLOW line is **70**.

On the operator benchmark at <https://vet402.com/accuracy> the 17 known-good
addresses (Vitalik, the Ethereum Foundation, Coinbase, Kraken, the ENS DAO
treasury, Gitcoin) score **0 ALLOW / 17 WARN / 0 BLOCK**, and a live payee
with 48 delivery-verified L1 receipts and zero failures still scores WARN.

**The default is deliberate and is not changing.** "We could not verify this"
must keep meaning "do not pay". The mistake to avoid is reaching for
`trustPolicy: "custom"` to unblock yourself — `"custom"` *also* disables the
staleness (H-2), degraded and partial-measurement refusals, which is almost
certainly not what you wanted.

### `trustPolicy: "evidence"` — accept a WARN you can justify

```typescript
const guard = vouch.createSpendGuard({
  maxPerTxUsd: 10,
  trustPolicy: "evidence",
  requireEvidence: { minL1Deliveries: 3 },
});
```

> **Pick floors that can actually be met.** Measured on production 2026-08-29:
> every payee's `l1DistinctBuyers` is **1** (the observatory is the only buyer
> on record), so a floor of `minL1DistinctBuyers: 2` denies every payee —
> including one with 62 delivery-verified receipts and zero failures. Floors
> are a statement about the evidence that exists, not a wish list.

A WARN passes **only** when the payee's measured `signals.receiving` record
clears the floors you name. Everything else behaves exactly like
`"allow-only"`:

| Situation | `"evidence"` |
|---|---|
| BLOCK | deny (`payee_recommendation_block`) — evidence never overturns a refusal |
| WARN, floors cleared | **allow** |
| WARN, floors not cleared | deny (`payee_insufficient_evidence`) |
| Evidence field absent from the response | counts as **0** — absence is not a pass |
| Degraded read | deny (`payee_score_degraded`) |
| Stale score | deny (`payee_score_stale`) |
| Partial measurement | deny (`payee_partial_measurement`) |
| Lookup failed | deny (`payee_trust_unavailable` / `..._unauthenticated`) |

Floors available: `minL1Deliveries`, `minL1DistinctBuyers`,
`minX402Payments`, `minDistinctPayers`. At least one must be `>= 1` —
all-zero floors would accept every WARN, which is `"block-only"` and has to
be spelled that way. `requireEvidence` is rejected under any other policy, so
the opt-out is always visible at the call site.

> The Python SDK (`vet402`) does **not** yet have `evidence`; its
> `trust_policy` options remain `allow-only` / `block-only` / `custom`.
