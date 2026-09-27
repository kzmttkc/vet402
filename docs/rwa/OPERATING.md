# vet402 /rwa: how we keep it running

`/rwa` was built during the Arbitrum Open House Singapore Buildathon, and we
are keeping it running after the event. This page says what stays up, how we
change it, how you can check us, and what we will build next on Robinhood
Chain. Each item names the file or command that shows whether we kept it.

## What stays up

| Surface | Where | Check it |
|---|---|---|
| Page | `https://vet402.com/rwa/<address>` | open it |
| Facts JSON | `GET https://vet402.com/api/v1/rwa/facts/<address>?chain=4663` | `curl` it |
| Method | `docs/rwa/SPEC.md` | read it |
| Anchor contract | `RwaAnchor` on Robinhood Chain (address in `fixtures/rwa/anchor.json`) | Blockscout |

- There is no end date. If we ever retire `/rwa`, we give 90 days' notice on this
  page and anchor a final snapshot before the surfaces go down.
- The page and the facts JSON need no key, no account and no fee. Limits are
  published in `docs/openapi.yaml` and do not change quietly.
- You cannot trade, deposit or delegate anything here: no custody, no token,
  no advice. That stays the same as coverage grows.

## How the method changes

- Every result carries `method_version`. Any change to how movements are
  classified, priced or realized raises the version, and old results are
  recomputed rather than silently mixed with new ones.
- Anything we cannot decode stays counted as `other_unparsed` and keeps the
  record `partial`. We add a venue only with a fixture that pins a real
  transaction, and the version goes up when we do.
- Every published record states `replayed_raw` next to the balance the chain
  reports. A mismatch is shown as `balance_mismatch`, not hidden.

## How you can check us

- `fixtures/rwa/A.json` pins the price formula to a real block.
  `fixtures/rwa/B.md` is one real round trip priced by hand. Both run in CI
  (`npm run rwa:test`), so a change that breaks them cannot ship.
- A hash of a published record is written to `RwaAnchor`, which
  has no owner and no upgrade path. Recompute it from the JSON with
  `npx tsx packages/rwa/scripts/anchor.ts --verify <tx> --mainnet`. We anchor
  again whenever the method version changes, so each version has a checkable
  reference point.
- When we get a number wrong, we fix it, raise the method
  version if the method was at fault, and say what changed in this file's
  history. We do not edit old anchors; they stay as they were.

## What we will build next on Robinhood Chain

In this order (SPEC §14), each one shipped with its own fixture:

1. Every canonical Stock Token, not only NVDA, read from the official
   registry rather than a hard-coded list.
2. An MCP tool, `check_rwa_wallet`, so an agent can read the same facts
   before it relies on someone's claimed record.
3. Identity binding through ERC-8004, so a record can be tied to an agent
   only when the chain proves it.
4. More venues beyond Uniswap v3/v4, each behind a method version bump.

## Giving back to the ecosystem

- The code is MIT-licensed. The classifier, the FIFO engine, the fixtures and the
  anchor contract are reusable by anyone building on Robinhood Chain.
- When a pool, a feed or a token
  behaves in a way that makes records unreadable, we tell its maintainers
  directly, with the transaction and what we expected, instead of only
  working around it.
- We will publish coverage (which tokens and
  venues are decoded) and latency from the running system, not from our own
  estimates. Operator test traffic is marked and left out of any count we
  publish.

Reconstruction of public chain data. Not investment advice. Not an offer of Stock Tokens.
