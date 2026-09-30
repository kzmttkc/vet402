# Patch 021: the chain confirms the list, and a record names the fakes a wallet met

Status: proposed on branch `rwa-w2-lookalike` (2026-09-30). The integrator merges it into SPEC.md and bumps `METHOD_VERSION` once for the sprint. This patch does not bump it.

## Why

Robinhood's own page says a token with a matching name or ticker at another address is not a Stock Token. /rwa already counted only the 195 addresses in Robinhood's list. Two things were missing.

1. The list was the only root. Nothing in the record showed that those addresses are what Robinhood Chain itself says Stock Tokens are.
2. A wallet that received a fake saw nothing about it. The fake was silently left out of the PnL, which is right, but the reader was never told it was there.

## 1. Second root for the registry

`packages/rwa/registry.json` now carries, for each of the 195 tokens:

- `code_hash`: keccak256 of `eth_getCode`
- `beacon`: the EIP-1967 beacon slot (the runtime code embeds the same address)
- `factory_log`: the Stock Token factory's deployment event that names the token (block, tx, log index)
- `needs_review`: why the on-chain identity disagrees, empty when it agrees

and a top-level `identity` block with the reference values (`packages/rwa/identity.ts`): code hash `0x6c1fdd40002dcb440c7fff6a84171404d279ccb057803b65826f7546acd65630`, beacon `0xe10b6f6B275de231345c20D14Ab812db62151b00`, factory `0x4783C67b63dE2B358Ac5951a7D41F47A38F3C046`, deployment event topic0 `0xd9b0c6a1…a76d6`, and the beacon's current implementation.

Measured at block 76057945 with `npx tsx packages/rwa/scripts/snapshot-registry.ts --identity-only`:

- 195 of 195 tokens have the reference code hash
- 195 of 195 have the reference beacon in the EIP-1967 slot
- 195 of 195 are named by a factory deployment event (the factory emitted 204 such events in total)
- 0 need review

`--identity-only` adds these fields to the existing snapshot. It does not fetch Robinhood's list again, so the token set and every count stay as they were (`taken_at` is unchanged). A full rebuild runs the same identity step. A token whose code hash or beacon differs, or that no factory event names, is written with `needs_review` and a reason. It is never silently dropped and never silently trusted. `packages/rwa/test/registry.test.ts` pins 195/195/195 and 0 needs review.

A code hash alone is not proof. Anyone can deploy the same proxy bytecode pointing at the same beacon. The factory event is the second root. Membership still comes from Robinhood's list.

## 2. Look-alike judgement (`packages/rwa/lookalike.ts`, pure)

Input: a token's address, symbol, name and code hash. Output: `lookalike`, `needs_review`, `imitates` (a canonical ticker or `USDG`), and reason codes.

A token at a canonical address, or the real USDG, is never a look-alike. Any other token is a look-alike when it does at least one of these:

| reason | meaning |
|---|---|
| `symbol_copies_stock_token` | the symbol is a Stock Token ticker as written |
| `symbol_disguises_stock_token` | the symbol becomes a ticker after NFKC, removing invisible characters (Unicode default-ignorable, format controls, braille blank, combining marks), folding digit 0 to O and Cyrillic/Greek homoglyphs to Latin, and upper-casing |
| `name_copies_stock_token` | the name, without a Robinhood ending, is a Stock Token's company name |
| `name_claims_robinhood_stock_token` | the name ends in "Robinhood Token", "Robinhood Coin", "Robinhood Stock", "Robinhood Share(s)" or "Robinhood Stock Token", with or without a separator |
| `imitates_usdg` | the symbol or name becomes USDG or "Global Dollar" after the same normalisation |

Extra reasons explain how: `hidden_characters`, `confusable_characters`, `code_hash_differs` (not the Stock Token code), `mimics_counterparty` (address poisoning, below), and `not_canonical_address`, which every look-alike carries.

A non-canonical token that carries the Stock Token code is `needs_review` with `reference_code_not_listed`. It is not called a fake, because it may be a delisted token or a proxy pointed at the issuer's beacon. It is not counted either way.

Address poisoning: a transfer whose other side shares the first four and last four hex digits of an address the wallet really exchanged USDG with, without being it.

A check that starts from tokens named "... Robinhood Token" never sees the "NVIDIA Robinhood Coin" NVDA that reached the demo wallet. Here it is caught by ticker, by company name and by the "Coin" ending.

## 3. In the record

Two new top-level fields in the facts JSON:

- `lookalikes`: one entry per look-alike token met, with `token`, `symbol_raw` and `name_raw` (every code point outside printable ASCII shown as ⟨U+XXXX⟩, the bullet excepted), `imitates`, `reasons`, `needs_review`, `direction` (`received`, or `sent` when a log names the wallet as sender), `counterparty`, `mimics`, `first_seen_block`, `tx`, `amount_raw`, `transfers_seen`, `counted: false`, `found_by`.
- `lookalikes_scope`: `complete`, `searched` (each source with its block range and a plain description), `not_scanned` (plain words for every part not searched), `tokens_judged`, `tokens_not_judged`.

Look-alikes are never counted. The classifier reads canonical addresses only. `packages/rwa/test/lookalike-scan.test.ts` adds a fake NVDA transfer to Fixture A's own receipts and checks that `tokens`, `events_summary`, `realized_usd`, `unrealized_usd`, `r1_status`, `gaps` and `evidence` are identical with and without it, and that the fake is listed with `counted: false`.

`anchorPreimage` is unchanged. The anchored hash does not cover these fields.

### How the search works

Measured on 2026-09-30: a Transfer log query without an address filter is capped at 30,000 blocks on the public RPC. A full-history search for one wallet, run on 2026-09-30 for the demo wallet, took 5,081 such queries (about 55 minutes) with no error left. About 1,000,000 blocks pass every 27.9 hours (block 76056458 minus 1,000,000 blocks = 100,569 seconds). So a live record cannot search the whole chain on the public RPC.

In order of preference:

1. `RWA_ALCHEMY_URL` set: `alchemy_getAssetTransfers` with `toAddress` and again with `fromAddress`, category `erc20`, no contract filter, every page up to `as_of_block`. Scope `complete` when both finish. The client is `packages/rwa/alchemy.ts`. The key in the URL is never logged, never in an error message and never in the record (tested with mocked responses shaped like Alchemy's published examples. No key exists yet).
2. Otherwise, three partial sources, each named in `searched`:
   - `receipts`: non-canonical Transfer logs naming the wallet in the transactions the record already read
   - `recent_logs`: Transfer logs naming the wallet as sender or recipient, no address filter, over the last 4 x 30,000 blocks (about 3.3 hours), newest span first, one query at a time. The public RPC refused a batch of these queries as a whole but answered single ones spaced a few hundred milliseconds apart (2026-09-30: 7 of 8 single queries answered at 0.3 s spacing, 2 of 4 batches of two). The window counts only the spans read without a break from the head down and says where it stopped.
   - `fixture`: a full-history search done ahead of time, `fixtures/rwa/lookalikes-demo.json` for the demo wallet, with its source and last block
   Anything outside those ranges is listed in `not_scanned`. When the fixture reaches from block 0 to the start of the recent window, the scope is `complete`.

The search runs after every read the record needs, pool lookups included, so it never competes with them for the RPC's rate limit and cannot make them fail. It has an 8-second budget, shrunk so that it ends by 38 seconds after the reconstruction started (the record's deadline is 45 s). A record whose own reads took 38 s or more gets no live search, only the fixture, and says so. The search never fails the record. A refused or slow RPC is written into `not_scanned`. Measured on the demo wallet on 2026-09-30 with `scanLookalikes` alone: 1.4 s, 3.2 s and 2.5 s in three runs, each `complete: true` with both look-alikes below. Whole reconstructions of the demo wallet on 2026-09-30, alternating the code before this patch and after it, three runs each: before 31.0 to 81.7 s with one HTTP 429 failure, after 32.7 to 61.1 s with one HTTP 429 failure. Other jobs were sharing the public RPC at the time, so these runs cannot isolate the search's own cost. By construction it adds at most 8 s, and nothing once 38 s have passed.

Before a demo, walk the fixture forward: `npx tsx packages/rwa/scripts/lookalikes-fixture.ts --extend fixtures/rwa/lookalikes-demo.json`.

### The demo wallet (0xE9B08727131E34010b34006c660D4c1B436EC25f)

Full search, blocks 0 to 76081226, 315 Transfer logs, 34 non-canonical tokens met, 2 look-alikes. Each kept log was checked against its transaction receipt.

- `0x5DD716Fe12275B69f04b26bEeca343843C8e3539`, symbol `NVDA`, name "NVIDIA Robinhood Coin". 25 tokens (raw 25000000000000000000, `decimals()` 18) sent to the wallet at block 73953009 (2026-09-27 12:52 UTC) in `0x1b838f40…77b51b`, signed by `0x3433e16e…abd0`. Reasons: ticker, company name, "Coin" ending, code hash differs.
- `0x4190Ee598c2a69D35Bef53c83d152Ae0f25EA416`, symbol and name `U⟨U+17B5⟩S⟨U+17B5⟩DG` (Khmer inherent vowel, invisible). A log at block 63379129 in `0x63c6fdd0…a01e`, signed by `0x3ea4ee9d…c286`, not by the wallet, shows the wallet sending 10 (raw 10000000, `decimals()` 6) to `0x1eb99afa…77c3`. That address copies the start and end of `0x1eb96a9c…77c3`, which the wallet really paid 10 USDG (raw 10000000, USDG has 6 decimals) at block 62621590. Reasons: imitates USDG, hidden characters, mimics a counterparty.

The other 32 tokens (PONS, `P0NS`, `PO⟨U+200B⟩NS` and similar spam) copy nothing canonical and are not listed.

## 4. On the page

`/rwa/[address]` gets a short section "Look-alikes this wallet received (not counted)". Each entry shows the escaped symbol and name, what it pretends to be, the reasons in plain words, the first transaction, and links to Blockscout. Address poisoning reads "A fake USDG transfer made to look like a payment to a real counterparty", then names both addresses. The section ends with what was searched and what was not. A record made before this patch renders no section.

## Money code

The paid route returns the same JSON, so it now carries `lookalikes` and `lookalikes_scope`. `packages/rwa/x402.ts` and the paid route's code are not changed. It ships after an independent review says SHIP.
