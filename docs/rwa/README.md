# vet402 /rwa

`vet402 /rwa` rebuilds a wallet's Stock Token track record on Robinhood Chain
(4663) from public chain data: canonical token transfers, Uniswap v3/v4 swaps,
and the Chainlink feed for each token. It does not trade, hold funds, issue a
token, or give advice. Specification: [SPEC.md](SPEC.md). Rules for this code:
[CLAUDE.md](CLAUDE.md).

## 30 seconds

1. Open a real record: <https://vet402.com/rwa/0xE9B08727131E34010b34006c660D4c1B436EC25f>
   (a public wallet on Robinhood Chain; it is marked `partial` because 12 of its
   movements are not decoded, and the page says so). Any other wallet:
   <https://vet402.com/rwa>.
2. One real round trip, priced by hand to the cent: [Fixture B](../../fixtures/rwa/B.md),
   realized **−$9.62**. CI replays it through the FIFO engine.
3. The anchor: `RwaAnchor`
   [`0x1955137e7773f2459eb75fb88842026c6517c22d`](https://robinhoodchain.blockscout.com/address/0x1955137e7773f2459eb75fb88842026c6517c22d)
   on Robinhood Chain, source verified on Blockscout (exact match). No owner, no
   upgrade path.
4. Recompute the anchored hash from the published JSON yourself:

   ```bash
   git clone https://github.com/kzmttkc/vet402 && cd vet402 && npm ci
   npx tsx packages/rwa/scripts/anchor.ts --verify 0x9b776d6a4670768e3e85261fcf3a5fc02012668e3323fee7211b07d8deca72d7 --mainnet
   # prints "match": true
   ```

   The script hashes the record kept in [`fixtures/rwa/anchor.json`](../../fixtures/rwa/anchor.json)
   (the wallet in step 1, as published at block 74267752) and compares it with
   the `Anchored` event it reads from the chain.

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
| Facts JSON | `GET https://vet402.com/api/v1/rwa/facts/<address>?chain=4663` (no key; 10/min/IP across instances; 5-minute cache and one reconstruction at a time per instance, 45-second cutoff) |
| Paid facts JSON | `GET https://vet402.com/api/v1/rwa/paid/facts/<address>` over x402 v2: 0.01 USDG on Robinhood Chain (`exact`, Permit2, facilitator Dexter), same JSON, 60/min/IP (not prioritised over the free route). Verified, then built, then settled: a 404 or 503 is never charged, and once settle is sent the record is returned. The receipt is in `PAYMENT-RESPONSE`; `X-Payment-Status` says `settled` or `unknown`. |
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
