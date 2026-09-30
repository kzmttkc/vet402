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
- Agents that want a looser limit can pay per call: the same JSON at
  `/api/v1/rwa/paid/facts/<address>` over x402, 0.01 USDG on Robinhood Chain,
  settled only after the record is built. The free route stays free.
- Reads go to `RWA_ALCHEMY_URL`, else `RWA_RPC_URL`, else Robinhood Chain's
  public RPC. The paid lane reads through that third-party RPC whenever one is
  set. With Alchemy set, every canonical token a wallet ever moved is in scope.
- Alchemy discovery uses `RWA_ALCHEMY_URL`, else `ALCHEMY_API_KEY` on
  `https://robinhood-mainnet.g.alchemy.com/v2/`, else nothing. The key alone does
  not move the plain reads. A refused key (401, 403, network not enabled) sends
  /rwa back to the public path for 10 minutes, and the record keeps its gap.
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
  `node packages/rwa/scripts/verify-record.mjs --record <file> --tx <tx>` (no
  install) or `npx tsx packages/rwa/scripts/anchor.ts --verify <tx>`. We anchor
  again whenever the method version changes, so each version has a checkable
  reference point.
- When we get a number wrong, we fix it, raise the method
  version if the method was at fault, and say what changed in this file's
  history. We do not edit old anchors; they stay as they were.

## Anchoring a new record (operator runbook)

This adds one record to the existing `RwaAnchor`
`0x1955137e7773f2459eb75fb88842026c6517c22d`. It never deploys a contract on
mainnet and never touches `fixtures/rwa/anchor.json`, which stays the 0.1 anchor.
I run it by hand, once per method version, from a Terminal on my own machine.

1. Get the code and dependencies.

   ```bash
   git pull && npm ci
   ```

2. Dry run. No key. It rebuilds the demo wallet's record from chain data
   (about a minute), then prints what it would anchor and what it would cost.

   ```bash
   npx tsx packages/rwa/scripts/anchor.ts --dry-run --mainnet --from-api \
     --contract 0x1955137e7773f2459eb75fb88842026c6517c22d
   ```

   `--from-api` anchors the record https://vet402.com publishes, byte for byte.
   The site reads through a provider this machine has no key for, so a local
   rebuild can differ from what readers see. The script refuses unless the
   site's `X-Facts-Hash` equals the hash it computes.

   Check three things in the output. `method_version` is the version you mean
   to anchor. `hash_material` is `2` for `rwa-recon-0.3` and later. `max_cost_eth`
   is small. On 2026-09-30 (still `rwa-recon-0.2`, material 1) it estimated
   30,677 gas, a limit of 39,880 with headroom, gas price 44,434,000 wei, and a
   maximum of 0.00000177 ETH.

3. Put the key in the environment without writing it to shell history. Paste the
   key and press Enter. Nothing is echoed.

   ```bash
   read -rs RWA_ANCHOR_KEY && export RWA_ANCHOR_KEY
   ```

   Use the key that sent the 0.1 anchor (`0x973cD8a91A771C2C04C6036888F8175D6b4F6227`)
   so every anchor shows one operator. The script never prints, logs or writes
   the key.

4. Send one anchor.

   ```bash
   npx tsx packages/rwa/scripts/anchor.ts --mainnet --from-api \
     --contract 0x1955137e7773f2459eb75fb88842026c6517c22d
   ```

   It rebuilds the record, shows the sender, its balance, the hash and the gas
   estimate, then asks you to type `anchor`. Anything else stops without sending.
   After the receipt it checks the log against the record and writes
   `fixtures/rwa/anchors/<method_version>-<block>.json`. It refuses to overwrite
   an existing file.

5. Remove the key from the shell.

   ```bash
   unset RWA_ANCHOR_KEY
   ```

6. Check the new record like any reader would, then commit that one file.

   ```bash
   node packages/rwa/scripts/verify-record.mjs --record fixtures/rwa/anchors/<file>.json
   git add fixtures/rwa/anchors/<file>.json
   ```

   Then add the file to `packages/rwa/anchors.ts`. The record page shows the
   newest anchor from that list, and `npm run rwa:test` fails until the file is in it.

Anchors sent so far:

- 2026-09-27 anchored `rwa-recon-0.1` in tx `0x9b776d6a4670768e3e85261fcf3a5fc02012668e3323fee7211b07d8deca72d7` (block 74268019, `fixtures/rwa/anchor.json`).
- 2026-09-30 anchored `rwa-recon-0.3` in tx `0x15f9ed8ae5dd466c2f35021c9f1291e7a624abbb52c8ac26b54d47442f585c7f` (block 76177721, `fixtures/rwa/anchors/rwa-recon-0.3-76177721.json`).

What the script refuses, so a slip cannot split the record: a mainnet run
without `--contract`, any mainnet address other than `0x1955…c22d`, a contract
whose runtime keccak256 is not the pinned `RwaAnchor` build, a sender balance
below the maximum cost, and writing to `fixtures/rwa/anchor.json`. `--deploy` works
on testnet (46630) only, for rehearsal.

## What we will build next on Robinhood Chain

In this order (SPEC §14), each one shipped with its own fixture:

1. Every canonical Stock Token, not only NVDA. Shipped on 2026-09-29 as
   `rwa-recon-0.2`: the 195 tokens of Robinhood's own list, frozen with the date
   it was taken and checked on chain, with the 33 Chainlink equity feeds.
   Shipped on 2026-09-30 in `rwa-recon-0.3`: positions the wallet sold out of,
   found through Alchemy's transfer index. Still to do here: refreshing the list
   when Robinhood adds tokens.
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
