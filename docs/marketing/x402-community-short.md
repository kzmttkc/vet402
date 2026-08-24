# x402 community — short-form drafts

**Status:** DRAFTS for Takeshi to post. Do not publish automatically.
**Where:** x402 Discord / Telegram dev channels, and as replies in x402 integration threads. NOT the Ethereum Magicians forum (that has its own long-form draft).
**Rule:** every claim below maps to a shipped endpoint. No invite code in the text (signup is open). One link max per message.

---

## A. Intro drop (dev channel, when introductions are welcome)

x402 verifies *that* a payer paid — it doesn't tell you whether to serve them. I've been building vet402: after your x402 middleware verifies payment, `GET /v1/wallets/{payer}/score` returns 0–100 + ALLOW/WARN/BLOCK before you run the expensive handler. ERC-8004 identity + reputation (Sybil-dampened) + wallet heuristics + attested x402 settlement history. Open source, on Base. Sample gate: `examples/x402-trust-gate`.

## B. Reply — "what about the wallet my agent is paying?"

Same problem, mirrored. `GET /v1/payees/{address}/score` scores the receiving side — receiving history, wallet health, and an exit-scam drain-pattern check over ETH + Base USDC — so an agent can screen a payee before it signs. Never 404s: an un-attested wallet still returns 200 with `dataDepth: "thin"` and the weights shift, so you decide how much a thin score is worth.

## C. Reply — "how do I know the score is any good?"

Public accuracy page, and it reports our false-positive rate (BLOCKs later confirmed legitimate) with the same prominence as the detection rate — below a minimum sample it says "insufficient data" instead of printing noise. With zero organic traffic there's nothing to measure yet, so there's also a clearly-separated operator benchmark: a fixed, versioned labeled address set (OFAC-sanctioned = known-bad, long-operating public addresses = known-good), stamped so it's never mixed into organic numbers.

## D. Reply — "is it verified or self-reported?"

Attestations are verified on-chain before they count: `POST /v1/payments/x402` requires the tx to be real, successful, and attributable to the claimed wallet — a well-formed wallet+txHash isn't enough to fabricate settlement history. Each score also ships a `breakdown` of the four weighted components so you can see why a verdict is what it is.

---

## Claim → implementation map (for Takeshi's pre-post check)

| Claim in a message | Backing |
|---|---|
| `GET /v1/wallets/{payer}/score` | `src/app/api/v1/wallets/[address]/score` |
| `GET /v1/payees/{address}/score`, never 404s, dataDepth thin/rich | `src/app/api/v1/payees/[address]/score` |
| `POST /v1/payments/x402` on-chain verified | `src/app/api/v1/payments/x402` |
| ALLOW≥70 / WARN 40–69 / BLOCK<40 | `SCORE_THRESHOLDS` (allow 70, warn 40) |
| x402 weight low while thin (10%) | `SCORE_WEIGHTS.x402 = 0.1` |
| public accuracy + false-positive rate + min sample | `/accuracy`, `src/lib/scoring/accuracy.ts` |
| operator benchmark, labeled, separated | `src/lib/benchmark/dataset.ts`, `/accuracy` |
| score `breakdown` of 4 components | shipped in every score response (N-21) |
| `examples/x402-trust-gate` | present in repo |
| signup open, no invite code | `/signup` (invite gate removed) |
