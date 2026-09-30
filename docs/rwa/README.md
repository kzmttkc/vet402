# vet402 /rwa

`vet402 /rwa` rebuilds a wallet's Stock Token track record on Robinhood Chain
(4663) from public chain data: canonical token transfers, Uniswap v3/v4 swaps,
and the Chainlink feed for each token. The record also names the look-alike
tokens the wallet met (never counted) and the corporate actions of each token it
held. It does not trade, hold funds, issue a token, or give advice. Specification: [SPEC.md](SPEC.md). Rules for this code:
[CLAUDE.md](CLAUDE.md).

## 30 seconds

1. Open a real record: <https://vet402.com/rwa/0xE9B08727131E34010b34006c660D4c1B436EC25f>
   (a public wallet on Robinhood Chain that holds NVDA and QQQ and sold out of
   SPY). Its record is `partial`, and the page says how many movements were not
   decoded (42 of 110 in the anchored record). It also shows:
   - **Look-alikes.** Two tokens this wallet met copy real ones. One is a fake
     NVDA named "NVIDIA Robinhood Coin" that it received (25 tokens on
     2026-09-27). The other is a fake USDG whose symbol hides invisible
     characters, in a log that fakes a payment to a copy of a real
     counterparty's address. Both are listed with the reasons and
     `counted: false`. They are in no balance and no USD figure.
   - **Corporate actions (share multiplier changes).** NVDA (2026-09-10), SPY
     (2026-09-18) and QQQ (2026-09-22) each changed their multiplier while the
     wallet held them, for example NVDA from 1 to 1.000775159. These are small
     multiplier changes, not stock splits. The page shows the wallet's shares
     before and after. Realized PnL is on raw amounts, so it does not move.

   These are from the anchored `rwa-recon-0.3` record, as of 2026-09-30 03:00 UTC
   (block 76177362). The live page is recomputed and can be newer.
2. Paste any wallet at <https://vet402.com/rwa>. The entry page lists three example
   wallets. Every wallet gets a stated answer: the record, or a 404 that says what
   was checked when it holds no Stock Token, or a 422 when it is too large for one
   request, or a 503 that names its reason with `Retry-After`.
3. One real round trip, priced by hand to the cent: [Fixture B](../../fixtures/rwa/B.md),
   realized **−$9.62**. CI replays it through the FIFO engine. Three numbers,
   three meanings. −$9.62 is that one hand-priced NVDA round trip. −$113.98 is the
   demo wallet's realized NVDA. −$273.01 is its realized total on the sales that
   could be priced: NVDA −$113.98, QQQ −$170.59, SPY +$11.56. SPY is a position
   the wallet sold out of. It is found because `rwa-recon-0.3` scans exited
   positions through Alchemy's transfer index. The last two numbers are from the anchored
   `rwa-recon-0.3` record, as of 2026-09-30 03:00 UTC.
4. The anchor: `RwaAnchor`
   [`0x1955137e7773f2459eb75fb88842026c6517c22d`](https://robinhoodchain.blockscout.com/address/0x1955137e7773f2459eb75fb88842026c6517c22d)
   on Robinhood Chain, source verified on Blockscout (exact match). No owner, no
   upgrade path. The demo record is anchored in tx
   [`0x15f9ed8a…585c7f`](https://robinhoodchain.blockscout.com/tx/0x15f9ed8ae5dd466c2f35021c9f1291e7a624abbb52c8ac26b54d47442f585c7f)
   (block 76177721), under `rwa-recon-0.3`, with a hash that binds the whole JSON.
5. Check the anchor yourself. No key, no account, no `npm ci`, only Node 18 or later:

   ```bash
   git clone https://github.com/kzmttkc/vet402 && cd vet402
   node packages/rwa/scripts/verify-record.mjs \
     --record fixtures/rwa/anchors/rwa-recon-0.3-76177721.json \
     --tx 0x15f9ed8ae5dd466c2f35021c9f1291e7a624abbb52c8ac26b54d47442f585c7f
   # every line says OK, the last one says "RESULT: MATCH"
   ```

   It reads the receipt from a public RPC, checks that the log came from
   `RwaAnchor`, and recomputes the hash from the record kept in
   [`fixtures/rwa/anchors/rwa-recon-0.3-76177721.json`](../../fixtures/rwa/anchors/rwa-recon-0.3-76177721.json)
   (the wallet in step 1, as of block 76177362). Details in
   [Verify it yourself in five minutes](#verify-it-yourself-in-five-minutes).
6. The same record, bought by an agent: 0.01 USDG over x402 on Robinhood Chain.
   The first settlement was a test I paid myself, settled through Dexter in tx
   [`0xeb26d1b5…3760`](https://robinhoodchain.blockscout.com/tx/0xeb26d1b5b0b1a12056ec8abd99640fcbb00860552b4c5a44d3e1b67b3da73760)
   ([`fixtures/rwa/paid-receipt.json`](../../fixtures/rwa/paid-receipt.json)). The free JSON stays free.

## What this Buildathon added, and what it did not

- **Added (first code commit 2026-09-16 22:03 UTC):** everything under
  `packages/rwa`, `src/app/rwa`, `src/app/api/v1/rwa` and `fixtures/rwa`, plus
  the `rwa:test` line in `package.json`. `git log -- <those paths>` is the diff.
- **Written before the event:** the spec in `docs/rwa`. I started it on
  2026-09-09, before the event, and added its patches during the event.
- **Not changed:** vet402's existing `/score` path, its weights, the x402
  observatory, and every existing database table. `/rwa` imports none of them
  and writes no database row.
- **Not claimed:** the parent vet402 product, which predates the event.

## Surfaces

| | |
|---|---|
| Page | `https://vet402.com/rwa/<address>` |
| Facts JSON | `GET https://vet402.com/api/v1/rwa/facts/<address>?chain=4663` (no key; 10/min/IP across instances; 5-minute cache and one reconstruction at a time per instance). It answers within 20 seconds. A slower read keeps running and the retry joins it. |
| Paid facts JSON | `GET https://vet402.com/api/v1/rwa/paid/facts/<address>` over x402 v2: 0.01 USDG on Robinhood Chain (`exact`, Permit2, facilitator Dexter), same JSON, 60/min/IP (not prioritised over the free route). Verified, then built, then settled: a 404 or 503 is never charged, and once settle is sent the record is returned. The receipt is in `PAYMENT-RESPONSE`; `X-Payment-Status` says `settled` or `unknown`. Payers sign with a plain key (EOA); smart-contract wallets are not accepted yet. |
| Anchor | `RwaAnchor` `0x1955137e7773f2459eb75fb88842026c6517c22d` on Robinhood Chain. The 0.1 record is `fixtures/rwa/anchor.json`, later records are `fixtures/rwa/anchors/<method_version>-<block>.json` |
| Hash header | Both facts routes send `X-Facts-Hash`: the v2 anchor hash of the JSON body. The body is unchanged |

## Venue scope

Robinhood Chain only. Classified venues: canonical token transfers and Uniswap
v3/v4 pools verified against the official factory and PoolManager. Everything
else (other DEX forks, RFQ, lending) is counted as `other_unparsed` and keeps
the record `partial`; it is never dropped.

## Verify it yourself in five minutes

The checker is one file, [`packages/rwa/scripts/verify-record.mjs`](../../packages/rwa/scripts/verify-record.mjs).
It has no dependencies and carries its own keccak256. It talks to a public
Robinhood Chain RPC and to nothing run by vet402.

From a clone:

```bash
git clone https://github.com/kzmttkc/vet402 && cd vet402
node packages/rwa/scripts/verify-record.mjs \
  --record fixtures/rwa/anchors/rwa-recon-0.3-76177721.json \
  --tx 0x15f9ed8ae5dd466c2f35021c9f1291e7a624abbb52c8ac26b54d47442f585c7f
```

Without a clone, two files over HTTPS:

```bash
curl -LO https://raw.githubusercontent.com/kzmttkc/vet402/main/packages/rwa/scripts/verify-record.mjs
node verify-record.mjs \
  --record https://raw.githubusercontent.com/kzmttkc/vet402/main/fixtures/rwa/anchors/rwa-recon-0.3-76177721.json \
  --tx 0x15f9ed8ae5dd466c2f35021c9f1291e7a624abbb52c8ac26b54d47442f585c7f
```

The earlier anchor still verifies. It is the `rwa-recon-0.1` record of the same
wallet as of block 74267752 (2026-09-27, realized −$113.98 on NVDA only), with
the v1 hash material:

```bash
node packages/rwa/scripts/verify-record.mjs --record fixtures/rwa/anchor.json \
  --tx 0x9b776d6a4670768e3e85261fcf3a5fc02012668e3323fee7211b07d8deca72d7
```

What each line checks. The run exits 0 only when all of them say OK.

| Line | Check |
|---|---|
| `tx status` | The transaction succeeded. |
| `contract` | The `Anchored` log was emitted by `0x1955137e7773f2459eb75fb88842026c6517c22d`. A log from any other address is ignored, so a look-alike contract cannot pass. |
| `contract code` | keccak256 of the code at that address is `0x9032fa49…f9b5b0`, the Foundry build of `RwaAnchor.sol` (see below). |
| `anchoredBy` | The sender in the log is the operator the record names. For a bare facts JSON, pass `--operator 0x…` to require one. |
| `subject` | keccak256 of the lower-cased wallet address. |
| `factsHash` | Recomputed from the JSON with the hash material its `method_version` selects. |
| `methodVersion`, `asOf` | Recomputed from the JSON. |

On 2026-09-30 the 0.3 run printed nine OK lines and `RESULT: MATCH` in under a
second, and the 0.1 run also ended in `RESULT: MATCH`. The same command with the deploy tx (which has no `Anchored` log) prints
`FAIL contract` and exits 1.

`npx tsx packages/rwa/scripts/anchor.ts --verify <tx> [--record <file>]` does the
same checks with the product's own code (`packages/rwa/anchor.ts` and viem). Tests
hold both implementations to the same answers
(`packages/rwa/test/verify-record.test.ts`).

### What the hash covers

| `method_version` | Material | Preimage, newline-joined, then keccak256 |
|---|---|---|
| `rwa-recon-0.1`, `rwa-recon-0.2` | v1 | `method_version`, lower-cased `address`, `as_of`, `r1_status`, `realized_usd` (the word `null` when absent) |
| `rwa-recon-0.3` and later | v2 | the same five, then keccak256 of the whole record as canonical JSON: keys sorted at every depth, no whitespace, strings and numbers as `JSON.stringify` writes them, top-level `address` lower-cased |

v1 does not bind `tokens` or `evidence`. v2 binds every field. The 0.1 anchor
stays v1 and still verifies. `X-Facts-Hash` on the facts routes is always the v2
hash of the body.

### The contract is the source

`RwaAnchor` has one write function and one counter. There is no owner, no admin,
no proxy, no upgrade path and no way to receive ether. Anyone may call
`anchor()`. The log names the sender.

```bash
brew install foundry          # or foundryup
cd packages/rwa/contracts && forge test
```

21 tests on 2026-09-30, all passing: each revert and its order, every event field
and the log layout verifiers decode, `count` starting at 0 and adding 1, fuzz
(1,024 runs each) over any input and any sender, 4 invariants over 16,384 random
calls, the selector list fixed at `count()` and `anchor(bytes32,bytes32,uint32,uint64)`,
admin and upgrade selectors answering nothing, ether refused, and a walk over the
runtime opcodes showing no `CALL`, `DELEGATECALL`, `STATICCALL`, `CREATE`,
`CREATE2` or `SELFDESTRUCT`. With no external call there is nothing to re-enter.

The same suite pins the bytecode. The build (solc 0.8.26, optimizer 200 runs,
EVM cancun, [`foundry.toml`](../../packages/rwa/contracts/foundry.toml)) hashes to
the runtime pinned in [`onchain.json`](../../packages/rwa/contracts/onchain.json).
To compare with the chain directly:

```bash
cd packages/rwa/contracts && forge build && cd ../../..
node packages/rwa/scripts/check-bytecode.mjs
```

On 2026-09-30 both public RPCs returned 548 bytes of runtime with keccak256
`0x9032fa493b888a32b4773a18ae74814d4f492d136c4cd55ade593eb783f9b5b0`, equal to the
Foundry build byte for byte, including the metadata tail. That tail holds an IPFS
hash of the compiler metadata, which includes a hash of the source file, so a
full match pins the source text and not only the logic. `count()` returns 2 (the
0.1 and 0.3 anchors), read with `eth_call` on both public RPCs on 2026-09-30.

## What is not trustless

An anchor proves that a record existed at a time and has not changed since. It
does not prove the record is right. These are the parts you still take on trust,
and how to narrow each one.

- **One operator key writes the anchors.** There is no multisig and no second
  signer. The contract accepts `anchor()` from anyone and records the sender as
  `anchoredBy`, so you see who wrote each log and decide whom to believe. The 0.1
  and 0.3 anchors were both sent by `0x973cD8a91A771C2C04C6036888F8175D6b4F6227`.
- **The reconstruction runs on my server.** The anchor fixes its output. It does
  not recheck it. You can rerun the method from this repo against the same block.
- **The token list is a dated snapshot.** [`packages/rwa/registry.json`](../../packages/rwa/registry.json)
  holds 195 tokens taken from Robinhood's asset list at 2026-09-28T22:24:32Z,
  33 of them with a Chainlink feed. A token listed after that is not read until
  the snapshot is refreshed and the method version goes up.
- **USDG is taken as 1 USD** ([`packages/rwa/quote.ts`](../../packages/rwa/quote.ts)).
  A depeg would move every USDG-priced cost and proceeds, and the record would not
  show it.
- **Prices come from Chainlink feeds on Robinhood Chain.** A stale feed makes the
  USD mark `null` with `stale: true`. It is never guessed. Trades quoted in WETH
  have no ETH/USD feed on 4663 yet, so those lots stay cost-unknown.
- **Reads go through public RPC.** The default endpoints are
  `rpc.mainnet.chain.robinhood.com` and `robinhood-rpc.publicnode.com`. They keep no
  historical state: on 2026-09-30, `eth_call` for `count()` at block 74268016
  answered "historical state … is not available". So past balances and past
  anchors are rebuilt from logs, not read at a block. To avoid trusting these
  endpoints, run the checker with `--rpc <your node>`.
- **The paid lane depends on one facilitator, Dexter.** If Dexter does not answer
  at verify, the paid route returns 502 and charges nothing. The free route does
  not use it.
- **What the decoder does not understand is counted, not dropped.** It appears as
  `other_unparsed` and keeps the record `partial`. The demo wallet's anchored
  0.3 record (as_of 2026-09-30T03:00:07Z) has 42 `other_unparsed` events next to
  30 Uniswap v3 and 38 Uniswap v4 swaps, 110 movements in all.
- **The look-alike search is only as wide as it says.** Without Alchemy it reads
  the record's own transactions and a recent window of blocks, and
  `lookalikes_scope` names what it did not search. For the demo wallet a
  full-history search is frozen in
  [`fixtures/rwa/lookalikes-demo.json`](../../fixtures/rwa/lookalikes-demo.json)
  (blocks 0 to 76081226).
- **`X-Facts-Hash` comes from my server.** It is a convenience for matching a
  response to a log. The proof is the log plus your own recomputation.

## Check it yourself

The anchor needs no new contract function to be checked. Recompute the hash from
the published JSON and compare it with the `Anchored` event, which
`eth_getLogs` returns for the anchor tx. `count()` is readable with a plain
`eth_call`. That is all the contract exposes, on purpose
([DECISION_010_anchor_read.md](DECISION_010_anchor_read.md)).

```bash
npm run rwa:test                                                       # Fixture A, Fixture B, anchor v1/v2, the paid lane
node packages/rwa/scripts/verify-record.mjs --record <file|url> --tx <tx>   # no install
(cd packages/rwa/contracts && forge test)                              # the contract
```

Reconstruction of public chain data. Not investment advice. Not an offer of Stock Tokens.
