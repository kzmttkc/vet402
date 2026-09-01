# @vet402/middleware

Drop-in **x402 transaction gate**. Score the payment counterparty and
**ALLOW / WARN / BLOCK** before the payment settles — from Express, Next.js,
or Hono, in about three lines. Fail-closed by default, in both senses: a
score you cannot fetch blocks the payment, and only a clean `ALLOW` verdict
passes — the default policy blocks `WARN` too.

> **BREAKING (v0.2.0): fail-closed by default — money moves only on ALLOW
> unless you explicitly opt out.** The default `policy: "allow-only"` blocks
> any verdict that is not `ALLOW` (a blocked WARN carries reason
> `recommendation_not_allow`). The pre-0.2.0 behaviour (WARN allowed
> downstream) is now the explicit opt-out `policy: "block-only"`; custom
> `blockOn`/`warnOn` banding requires `policy: "custom"`.

This is the productized form of the `facilitator-gate` and `x402-trust-gate`
reference adapters. The x402 payment gate stays your beacon; this middleware
reads Vouch before it settles.

```bash
npm install @vet402/middleware
```

> **Which default do you have?** Check with `npm ls @vet402/middleware`.
> **0.1.0** ships the old lenient default (a `WARN` passes downstream) and has
> no `policy` option — set `blockOn: ["BLOCK", "WARN"]` to get the fail-closed
> posture today. **0.2.0 and later** are fail-closed out of the box, and the
> `policy` option documented below exists there.

## Express — three lines

```typescript
import { createExpressGate } from "@vet402/middleware/express";

// Mount AFTER x402 verification so `req.payer` is set.
app.use("/api/paid", createExpressGate({
  apiUrl: process.env.VOUCH_API_URL!,   // https://vet402.com/api/v1
  apiKey: process.env.VOUCH_API_KEY!,
  getAddress: (req) => req.payer,       // the counterparty to vet
}));
```

Anything but `ALLOW` returns `403 { error: "trust_blocked", ... }` before
your handler runs (default `policy: "allow-only"`). `ALLOW` continues with
the full decision on `req.vouchTrust`; under the `"block-only"` /`"custom"`
opt-outs a `WARN` also continues and fires `onWarn`.

## Next.js (App Router)

```typescript
import { withVouchGate } from "@vet402/middleware/next";

export const POST = withVouchGate(
  {
    apiUrl: process.env.VOUCH_API_URL!,
    apiKey: process.env.VOUCH_API_KEY!,
    getAddress: (req) => new URL(req.url).searchParams.get("payer") ?? undefined,
  },
  async (req, trust) => Response.json({ ok: true, trust }),
);
```

Or inline with `createNextGate(...).check(address)` → `{ decision, response }`,
returning `response` when it is non-null.

## Hono

```typescript
import { createHonoGate } from "@vet402/middleware/hono";

app.use("/api/paid/*", createHonoGate({
  apiUrl: process.env.VOUCH_API_URL!,
  apiKey: process.env.VOUCH_API_KEY!,
  getAddress: (c) => c.get("payer"),
}));
```

## Configuration

| Option | Default | Meaning |
|---|---|---|
| `scoreSource` | `"wallet"` | `"wallet"` (the x402 beacon) or `"payee"` (buyer-side receiving history). |
| `decisionSource` | `"score"` | Product spec §9.3 seller mode. `"decision"` consults `GET /resources/{resourceId}/decision?role=payee&payer=…` — facts and recommendation arrive in one document; a response without `facts` is blocked. The role is fixed to `payee` (post-settlement payer check). The buyer-side "stop before signing" wiring is not part of this package yet. |
| `resourceId` | — | Required with `decisionSource: "decision"`: the §5 `resource_id` (sha256 hex) of the resource being served. Get it from `GET /resolve?q=<url>`. |
| `idempotencyKey` | — | `(address) => string`. Sent as `Idempotency-Key`; the API does not charge a second rate-limit unit for the same (resource, payer, key) within 10 minutes. |
| `policy` | `"allow-only"` | `"allow-only"` blocks anything that is not ALLOW (fail-closed). `"block-only"` lets WARN through (pre-0.2.0 behaviour). `"evidence"` lets a WARN through only when it clears `requireEvidence` (keeps every data-quality refusal). `"custom"` bands with your own `blockOn`/`warnOn` **and switches the staleness/degraded gates off**. |
| `requireEvidence` | — | Evidence floors for `policy: "evidence"`: `minL1Deliveries`, `minL1DistinctBuyers`, `minX402Payments`, `minDistinctPayers`. Required by that policy, rejected under any other, and needs `scoreSource: "payee"`. |
| `blockOn` | `["BLOCK"]` | Recommendations that block. Requires `policy: "custom"` (rejected otherwise, never silently ignored). |
| `warnOn` | `["WARN"]` | Recommendations that warn (still allowed). Requires `policy: "custom"`. |
| `minScore` | — | Stricter numeric floor (0–100): block below it even on ALLOW. |
| `failMode` | `"closed"` | `"closed"` blocks on a lookup failure; `"open"` allows it (flagged `degraded`). |
| `timeoutMs` | `5000` | Score-lookup timeout — a hung Vouch never hangs the payment path. |
| `blockStatus` | `403` | HTTP status returned on a block. |

Every decision carries `{ action, recommendation, score, reason, degraded }`.
`degraded: true` marks a verdict that came from `failMode`, not a real
score — log or alert on those so trust-blind settlements are visible.

## Settlement attestation (optional)

Feed successful settlements back so future scores weight them (10% of the
score). Provide `getAttestation` on any adapter; it is fire-and-forget — a
failed attestation never fails the paid request.

```typescript
createExpressGate({
  /* ...as above... */
  getAttestation: (req) => req.paymentTxHash
    ? { wallet: req.payer, txHash: req.paymentTxHash, resource: req.path }
    : undefined,
});
```

## Non-custodial

The gate reads a score and returns a verdict. It never touches keys, funds,
signing, or transaction submission — settlement stays with your x402 stack.

## Links

- [API key](https://vet402.com/dashboard/keys) — `VOUCH_API_KEY`
- [API docs](https://vet402.com/docs/api) · [OpenAPI spec](https://github.com/kzmttkc/vet402/blob/main/docs/openapi.yaml)
- [x402 integration guide](https://github.com/kzmttkc/vet402/blob/main/docs/x402-integration.md)
- [`@vet402/sdk`](https://www.npmjs.com/package/@vet402/sdk) — buyer side (SpendGuard)
- [`@vet402/mcp-server`](https://www.npmjs.com/package/@vet402/mcp-server) — MCP tool

MIT · [vet402](https://vet402.com)


## What the default actually does today (measured 2026-08-25)

**Under `policy: "allow-only"` this gate currently blocks every counterparty
that exists.** That is not a bug in the gate — it is what the engine's own
banding says, and you should know it before you wire the default into a
payment path:

- an unregistered bare wallet is capped at **62** by the wallet engine
  (identity 30, reputation 30, wallet 100, x402 50 → weighted 62);
- a payee with no *independent* receiving record is capped at **69**
  (`PAYEE_THIN_SCORE_CEILING`, the 2026-08-13 score-manipulation ruling);
- the ALLOW line is **70**.

So on the operator benchmark published at <https://vet402.com/accuracy>, the
17 known-good addresses (Vitalik, the Ethereum Foundation, Coinbase, Kraken,
the ENS DAO treasury, Gitcoin) come back **0 ALLOW / 17 WARN / 0 BLOCK**, and
a live payee with 48 delivery-verified L1 receipts and zero failures still
scores WARN.

**The default is deliberate and is not changing**: "we could not verify this"
has to keep meaning "do not pay". But do not reach for `"custom"` to get
moving — `"custom"` also turns off the staleness (H-2) and degraded/partial
gates, which is almost never what you meant. Use `"evidence"`:

```ts
const gate = createTrustGate({
  apiUrl, apiKey,
  scoreSource: "payee",
  policy: "evidence",
  requireEvidence: { minL1Deliveries: 3, minL1DistinctBuyers: 2 },
});
```

A WARN now passes **only** when the payee's measured receiving record clears
those floors. BLOCK still blocks, a degraded/stale/partial read still blocks,
and a missing evidence field counts as zero — absence is never a pass.
