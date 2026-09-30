# Patch 022: corporate actions in the record

Status: branch `rwa-w3-corpact`, for the integrator to merge into docs/rwa/SPEC.md. Method version is not raised here (the integrator raises it once to `rwa-recon-0.3`).

## What changes

Each token in the facts JSON gains `corporate_actions[]`: every `UIMultiplierUpdated` the token emitted from genesis up to `as_of_block`, with what this wallet held at that moment. The record page gains a short section, "Corporate actions while this wallet held the token".

Nothing else in the record moves. FIFO still runs on raw quantities and USD, the Chainlink price still carries the multiplier, and `realized_usd` is the same with or without this patch (pinned by a test on recorded chain data, see below).

## The event

A Stock Token records a split or a reinvested dividend by changing its UI multiplier, not the raw balances. Shares shown to a person are `raw × uiMultiplier / 1e18`.

- Signature: `UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAt)`, no indexed fields.
- topic0: `0x2205df4534432b2f60654a3fdb48737ffdaf3e9edb1a498bd985bc026b15b055` (viem `toEventSelector`, checked 2026-09-30).
- How the field order was checked: the NVDA update in tx `0x4ac23f2e58e2c4962dcd701c2beff581e87f3995152a29d527c07a3afd67d956` (block 58,952,659) carries the words `1e18, 1000775159164630595, 1788998430`. The same transaction calls `updateMultiplier(uint256,uint256)` (selector `0xbad60f18`) with `(1000775159164630595, 1788998430)`. So word 0 is the multiplier before, word 1 the multiplier after, word 2 the unix time it takes effect (2026-09-10T00:00:30Z, about 10 minutes after the block at 2026-09-09T23:50:42Z). The QQQ update in tx `0x6331915e6ddac124b1ea59b0db720892615fbd8ffbbea59cc9772147e326bba6` has the same shape.

## Where the history comes from

The public RPC cannot answer `eth_call` at an old block, so past multipliers exist only in these logs. It also refuses a log query without an address over more than 30,000 blocks (measured 2026-09-30: "only 30000 are allowed for this request; narrow the block range, or add an address filter"), so each token is its own filter, in the same 10,000,000-block chunks as the Transfer walk.

Logs never change once written, so /rwa keeps them in two layers:

1. `packages/rwa/corporate-actions.json`: a frozen walk of all 195 canonical tokens from genesis to block 76,083,561 (taken 2026-09-30T00:23:57Z), rebuilt by `packages/rwa/scripts/snapshot-corporate-actions.ts`. The script refuses to write if, for any token, the multiplier the logs predict (1e18 before any update, else the last `after` once in effect) differs from `uiMultiplier()` read at that block. Result on 2026-09-30: 46 updates on 43 of the 195 tokens, 0 still scheduled, 0 mismatches. An earlier independent walk of all 204 factory tokens (same day, to block 75,997,569) found 50: the same 45 on canonical tokens plus 5 on WEEK, which is not in Robinhood's list. The one update it did not have is MPWR at block 76,070,684, emitted after it ran.
2. A per-instance memo of the tail. A reconstruction asks the chain only for `to_block + 1 .. as_of_block`, one range per token in scope, batched four per JSON-RPC call. For the demo wallet (NVDA and QQQ) that is one extra POST. A token missing from the frozen walk is read from genesis.

## Fields (per token, `corporate_actions[]`, chain order)

| field | meaning |
|---|---|
| `block`, `tx` | where the update was emitted |
| `time` | ISO time of that block |
| `effective_at` | ISO time from which the token applies the new multiplier, as emitted |
| `multiplier_before`, `multiplier_after` | 18-decimal integers as strings |
| `ratio` | `after / before`, 18 places, trailing zeros cut. A number only. /rwa does not name it "split" or "dividend", because the event does not say which |
| `held` | the wallet held the token right after the update transaction. `null` when the token's history was not walked (`scope.history_not_walked`) |
| `wallet_raw_at` | raw balance from replaying the wallet's own classified events up to the update's position (block, then log index). The same replay FIFO uses |
| `wallet_shares_before`, `wallet_shares_after` | `wallet_raw_at × multiplier / 1e18`, 8 decimals |

Updates while the wallet held nothing stay in the list with `held: false`. The list is the token's history, not a filtered view.

`wallet_raw_at` is the holding at the update transaction, not at `effective_at`. A trade inside that window (588 s for NVDA, 584 s for QQQ) would be counted on the before side. For the demo wallet there is none: its next NVDA transaction after the update is 2,850,388 blocks later, and it has no QQQ transaction after the QQQ update.

If the live tail read fails, the record is still built. It carries no `corporate_actions` and names the gap `corporate_actions_not_read`. The section is display only, so it should not cost the whole record.

New gap: `multiplier_history_mismatch`, when the logs do not explain the multiplier the token reports at `as_of_block` (an update was missed). It is skipped while the last update is still scheduled, because /rwa has not measured what `uiMultiplier()` returns before `effectiveAt`.

## Record page

"Corporate actions while this wallet held the token": effective date, token, multiplier before and after, shares held before and after, tx link. Updates while the wallet held none are folded into one line with a count and open on click.

## Measured on the demo wallet

Live reconstruction of `0xE9B08727131E34010b34006c660D4c1B436EC25f` on 2026-09-30 at block 76,085,543 (`reconstructFacts` with a counting fetch, one run): 25.3 s, 58 `eth_getLogs` of which 2 were the corporate-action tail (one POST). `realized_usd` -284.57, the same as before this patch.

| effective (UTC) | token | multiplier | wallet raw at the update | shares before → after | tx |
|---|---|---|---|---|---|
| 2026-09-10 00:00:30 | NVDA | 1 → 1.000775159164630595 | 82049332007476505675 | 82.04933200 → 82.11293329 | `0x4ac23f2e…` |
| 2026-09-22 00:10:34 | QQQ | 1 → 1.000700791241405425 | 94180700533589531354 | 94.18070053 → 94.24670154 | `0x6331915e…` |

Both holdings agree with a plain sum of the wallet's recorded Transfer logs up to each update (a test does this without the classifier). A copy of Gapwatch's public API response saved on 2026-09-30 lists 20 events (`total: 20`). NVDA is among them. The QQQ update of 2026-09-22 is not.

## Tests

`packages/rwa/test/corporate.test.ts`, no RPC:

- topic and decoding against the real NVDA log
- the holding is the replay up to the update's log, same-block order is respected, and `held:false` entries are kept
- a token whose history was not walked keeps its updates with `held: null`
- the frozen walk covers exactly the 195 canonical tokens and contains the QQQ update of 2026-09-22 (block 69,210,998)
- a live read sends one tail range per token after the frozen walk, and nothing on a repeat
- Fixture C (`fixtures/rwa/C.corpact.json`, recorded by `packages/rwa/scripts/record-fixture-corpact.ts`): the demo wallet's NVDA and QQQ history. It checks the updates read from the chain match the frozen walk, the NVDA 2026-09-10 and QQQ 2026-09-22 rows, that the record with and without corporate actions is identical apart from `corporate_actions` (so `realized_usd` does not move), and that dropping the QQQ update raises `multiplier_history_mismatch`.

## Not changed

- Per-trade share counts: the record has no per-trade list today, so there is no historical share display to correct. The corporate-action rows carry shares before and after each update instead.
- The paid route returns the same JSON as the free route, so its body gains `corporate_actions[]` too. That makes this money code: it ships after an independent review says SHIP.
