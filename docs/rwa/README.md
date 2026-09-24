# vet402 /rwa

`vet402 /rwa` rebuilds a wallet's Stock Token track record on Robinhood Chain
(4663) from public chain data: canonical token transfers, Uniswap v3/v4 swaps,
and the Chainlink feed for each token. It does not trade, hold funds, issue a
token, or give advice. Specification: [SPEC.md](SPEC.md). Rules for this code:
[CLAUDE.md](CLAUDE.md).

## What this Buildathon added, and what it did not

- **Added (first code commit 2026-09-17):** everything under `packages/rwa`,
  `src/app/rwa`, `src/app/api/v1/rwa`, `fixtures/rwa` and `docs/rwa`, plus the
  `rwa:test` line in `package.json`. `git log -- <those paths>` is the diff.
- **Not changed:** vet402's existing `/score` path, its weights, the x402
  observatory, and every existing database table. `/rwa` imports none of them
  and writes no database row.
- **Not claimed:** the parent vet402 product, which predates the event.

## Surfaces

| | |
|---|---|
| Page | `https://vet402.com/rwa/<address>` |
| Facts JSON | `GET https://vet402.com/api/v1/rwa/facts/<address>?chain=4663` (no key; 10/min/IP across instances; 5-minute cache and 3 concurrent reconstructions per instance) |
| Anchor | `RwaAnchor` on Robinhood Chain — see `fixtures/rwa/anchor.json` |

## Venue scope

Robinhood Chain only. Classified venues: canonical token transfers and Uniswap
v3/v4 pools verified against the official factory and PoolManager. Everything
else — other DEX forks, RFQ, lending — is counted as `other_unparsed` and keeps
the record `partial`; it is never dropped.

## Check it yourself

The anchor needs no new contract function to be checked. Recompute the hash
from the published JSON (the five SPEC §9 fields, newline-joined, `realized_usd`
written as `null` when absent, then keccak256) and compare it with the
`Anchored` event, which `eth_getLogs` returns for the anchor tx; `count()` is
readable with a plain `eth_call`. That is all the contract exposes, on purpose
([DECISION_010_anchor_read.md](DECISION_010_anchor_read.md)).

```bash
npm run rwa:test                                           # Fixture A (price formula), Fixture B (FIFO by hand), 60+ tests
npx tsx packages/rwa/scripts/anchor.ts --verify <tx> --mainnet   # recompute the anchored hash from the JSON
```

Reconstruction of public chain data. Not investment advice. Not an offer of Stock Tokens.
