# verify-at-settle — the fast verdict surface

**Endpoint**: `GET /api/v1/payees/{address}/verdict-fast` (API key required, 1 unit)

For facilitators and payment middleware that want a trust check **inside** the
settlement flow, where every millisecond is user-visible.

## The contract (one line)

> This surface **never computes**. It returns the engine's cached, confident
> verdict — or an honest `cache_cold`.

- `{"status":"hit", "recommendation":"ALLOW|WARN|BLOCK", "score":…, "cacheExpiresAt":…}`
- `{"status":"cache_cold", "recommendation":null, "warmVia":"/api/v1/payees/{address}/score"}`

Only verdicts the engine was confident enough to pin are ever cached
(degraded / partially-measured readings are excluded at the engine layer), so
speed here never trades away quality.

## Fail-closed semantics belong to the caller

Treat anything that is not an explicit `ALLOW` — including `cache_cold` — as
"do not pay yet". Warm the cache asynchronously by calling the full `/score`
endpoint (same cache, TTL 5 minutes); retry the fast surface afterwards.

## SDK support

`@vet402/sdk` (0.3.x) exposes this surface as two pieces:

```ts
import { createVouchClient, payeeVerdictFastAllows } from "@vet402/sdk";

const vouch = createVouchClient({ apiKey: process.env.VOUCH_API_KEY! });

const verdict = await vouch.getPayeeVerdictFast(payee);
if (!payeeVerdictFastAllows(verdict)) {
  // cache_cold, WARN, BLOCK, or past its own cacheExpiresAt — do not pay yet.
  void vouch.getPayeeScore(payee); // fire-and-forget warm, same cache
  return queueForRetry();
}
```

`payeeVerdictFastAllows` is the rule above, written once: true only for
`status: "hit"` with an `ALLOW` that has not passed its own `cacheExpiresAt`.
`cache_cold` is false — it is the *absence* of a verdict, not a permissive one.

**`SpendGuard` does not use this surface**, and that is deliberate: it enforces
`minPayeeScore` bands and its own `maxScoreAgeMs`, and reports the full
`payeeScore` in every decision — none of which this body can supply. The fast
surface is a pre-check for a settlement path that already has its own deadline;
`GET /score` remains the gate. The **Python SDK does not expose the fast
surface at all** (2026-08-22): it has `get_payee_score` and `SpendGuard` only.

> Corrected 2026-08-22. This section previously claimed the fail-closed reading
> of `cache_cold` was "exactly what `@vet402/sdk` / the Python SDK do by
> default". Measured at the time: `verdict-fast` appeared **nowhere** under
> `packages/` — both SDKs only ever called `/payees/{address}/score`. The
> document described a code path that did not exist. The TypeScript half now
> does (`getPayeeVerdictFast` + `payeeVerdictFastAllows`, pinned by
> `packages/sdk/test/verdict-fast.test.mjs`); the Python half is still absent
> and is now stated as absent rather than claimed.

## Latency

In-handler work is a single in-memory cache read; the test suite pins the
in-handler p95 under 1 ms over 100 calls (`tests/verdict-fast.test.ts` — the
number is enforced in CI, not quoted from memory). End-to-end latency adds
network + platform overhead on top; deploy-local callers (same region) should
budget single-digit milliseconds.

## Warming pattern for facilitators

1. On payment intent creation: fire-and-forget `GET /score` for the payee.
2. At settle time: `GET /verdict-fast`; require `status=hit` + `ALLOW`.
3. On `cache_cold`: fail closed (queue/delay), not open.
