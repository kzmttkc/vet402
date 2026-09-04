---
title: "x402 proves payment. It doesn’t prove delivery — so we built vet402"
published: false
description: "Independent verification of the x402 agent-payment economy on Base. We buy, we settle, we publish. ALLOW / WARN / BLOCK for agents that still have to decide."
tags: web3, ai, typescript, api, blockchain
---

# x402 proves payment. It doesn’t prove delivery — so we built vet402

**Payment answers “did the money move?”**  
**Delivery answers “did the seller actually serve what was sold?”**

Those are different facts. x402 is good at the first. The second is what an agent needs before it signs the next payment, and what a stranger needs when they ask whether an endpoint has ever fulfilled.

**vet402** is an independent observatory for that economy. We buy what listed endpoints sell (real USDC on Base), publish successes and failures with the same weight, and expose a 0–100 score plus `ALLOW` / `WARN` / `BLOCK` for integrators who still have to make a gate decision. The observatory is not a score of itself. The public record and the keyed API are the same measurements.

This post is a build-in-public snapshot. Site: [vet402.com](https://vet402.com). Repo: [github.com/kzmttkc/vet402](https://github.com/kzmttkc/vet402).

## Two surfaces (do not mix them)

**Facts, key-less.** Aggregates anyone can `curl`:

```
GET https://vet402.com/api/v1/observatory/state
```

Counts with denominators. No composite score. `unverified` means not machine-checkable, not dead. Per-payee HTML at `/payee/{address}` is the same engine a human already reads.

**Decisions, keyed.** Seller-side and buyer-side scores:

```
GET /api/v1/wallets/{payer}/score
GET /api/v1/payees/{payee}/score
```

API keys from [vet402.com/signup](https://vet402.com/signup) — free tier, no invite code. TypeScript client: `npm install @vet402/sdk`. Methods include `getAgentScore`, `getWalletScore`, `getPayeeScore`. Env name is still `VOUCH_API_KEY`.

SpendGuard in the SDK **decides** and does not pay. An agent can still ignore the verdict and sign. That hole is product work, not a blog claim.

## Seller side — should I serve this payer?

```
Client → x402 payment verification → vet402 payer check → your route
                              ↘ optional settlement attest
```

1. x402 middleware verifies payment and yields a **payer wallet**
2. Your gate calls `GET /api/v1/wallets/{payer}/score`
3. On `BLOCK`, return 403 before the expensive handler
4. After allow, optionally `POST /api/v1/payments/x402` so a verified settlement can strengthen later scores

Sample gate: `examples/x402-trust-gate`. Middleware package: `@vet402/middleware`.

## Buyer side — should my agent pay this wallet?

```
Your agent → vet402 payee check → (you still decide whether to sign) → their API
```

1. The agent hits a 402 and extracts the **payee** from the payment requirements
2. It calls `GET /api/v1/payees/{payee}/score` (or `getPayeeScore`) before signing
3. On `BLOCK`, skip the payment; on `WARN`, apply your own policy

A payee’s failure mode is not Sybil feedback. It is taking money and not delivering. The payee mix is receiving history, wallet health, drain shape (native ETH and Base USDC, dust floors so gas residue does not false-positive), and prior outcome labels.

Two details that stay true:

- **The score route never 404s.** An un-attested wallet still returns `200` with `dataDepth: "thin"`. You decide how much a thin score is worth.
- **Attestations are verified on-chain before they count.** A well-formed wallet + txHash is not enough to fabricate settlement history.

## What goes into a payer score (today)

| Signal | Role |
|--------|------|
| ERC-8004 identity | Registered agent + metadata URI presence |
| ERC-8004 reputation | Feedback volume / average, with Sybil dampening |
| Wallet heuristics | Age, activity, burner patterns, funder clusters |
| Manual WL/BL | Per-customer policy (after the chain score) |
| x402 settlements | Attested payment history (**10% weight** — still accumulating data) |

Recommendations: **≥70 ALLOW**, **40–69 WARN**, **&lt;40 BLOCK** (blacklist / high Sybil risk forces BLOCK). Scores are **estimates** — not a guarantee or a credit rating.

Owner-index lag is surfaced as `dataCoverage` so integrators see freshness instead of assuming omniscience.

## API surface

```bash
# Public facts (no key)
curl https://vet402.com/api/v1/observatory/state

# Score a payer wallet (seller side)
curl -H "Authorization: Bearer $VOUCH_API_KEY" \
  https://vet402.com/api/v1/wallets/0xYOUR_PAYER/score

# Score a payee wallet (buyer side, before your agent pays)
curl -H "Authorization: Bearer $VOUCH_API_KEY" \
  https://vet402.com/api/v1/payees/0xTHEIR_WALLET/score

# Attest a verified payment (idempotent on txHash)
curl -X POST -H "Authorization: Bearer $VOUCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"wallet":"0xYOUR_PAYER","txHash":"0x...","resource":"/api/premium"}' \
  https://vet402.com/api/v1/payments/x402
```

Also available: agent-ID scoring, batch scores, outcome reporting (`POST /v1/events/{id}/outcome`), MCP tools on `@vet402/mcp-server`.

## Design choices we will not apologize for

- **Fail closed** on wallet binding / critical RPC failure when verifying binders — better a 502/BLOCK than a silent ALLOW.
- **Attestations are verified on-chain before they count.**
- **Whitelist is not a Sybil free pass** — high Sybil risk refuses to promote WARN→ALLOW.
- **Public facts stay key-less. Score lookups are keyed.** The observatory is not a scrape farm; it is a published measurement.
- **x402 settlement weight starts small (10%)** until the attested set deserves more.
- **Every score explains itself** — `breakdown` of identity / reputation / wallet / x402.
- **Measured operators are not customers.** Verdicts are not for sale.

## Try it

- Observatory: [vet402.com/observatory/state](https://vet402.com/observatory/state)
- Sign up for a key: [vet402.com/signup](https://vet402.com/signup)
- SDK: `npm install @vet402/sdk`
- Code: [github.com/kzmttkc/vet402](https://github.com/kzmttkc/vet402)

Building a gateway or an agent runtime? Reply here. We compare notes; we do not sell a better private verdict.

---

*Built with Next.js, viem, Neon, and the ERC-8004 registries on Base. We buy. We settle. We publish the measurements.*

---

## Claim → implementation map (do not publish this section)

| Claim | Backing |
|---|---|
| Observatory facts, key-less | `GET /api/v1/observatory/state` |
| Payee HTML | `/payee/{address}` |
| Score APIs keyed | `authorizeApiRequest` on `/api/v1/wallets` and `/api/v1/payees` |
| `getPayeeScore` | `@vet402/sdk` |
| SpendGuard decides, does not pay | SDK SpendGuard; `payOrRefuse` **not shipped** — do not add |
| Thresholds 70 / 40 | `SCORE_THRESHOLDS` |
| x402 weight 10% | `SCORE_WEIGHTS.x402 = 0.1` |
| Signup open, no invite | `/signup` |
