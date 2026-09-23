# Fixture B — one round trip, priced and realized by hand

SPEC §4 (FIFO only) and §11. This file is the reason `realized_usd` may be
published at all: until the decoder agrees with the hand calculation below to
within $0.01, every surface answers `null`.

Both transactions are public swaps by the demo address
`0xE9B08727131E34010b34006c660D4c1B436EC25f` on Robinhood Chain (4663),
through the Uniswap v3 NVDA/USDG pool `0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3`
(fee 500, verified against factory `getPool` — SPEC §3).

USDG is treated as 1 USD with 6 decimals (SPEC §2):
`usd_cents = usdg_amount * 100 / 1e6`, integer, floored.

## Entry — the lot

| | |
|---|---|
| tx | `0xa8431b2093a5d821b816500ba9a43727c60fd00569e06cde0956f56465de1045` |
| block | 52211835 |
| type | `univ3_swap` |
| raw in (NVDA received) | `10000000000000000000` (10 × 1e18) |
| raw out (USDG paid) | `2173349387` |

Hand calculation of the lot's cost:

```
2173349387 * 100 / 1e6 = 217334.9387 → 217334 cents = $2,173.34
```

## Exit — the realization

| | |
|---|---|
| tx | `0x9255af2563f46860ee31f093b6aea37dcb6c21a91f667c15220c3d60f36cf03f` |
| block | 61819228 |
| type | `univ3_swap` |
| raw out (NVDA sold) | `10000000000000000000` (10 × 1e18) |
| raw in (USDG received) | `2163726193` |

Hand calculation of the proceeds and the realization:

```
proceeds = 2163726193 * 100 / 1e6 = 216372.6193 → 216372 cents = $2,163.72
realized = 216372 - 217334 = -962 cents = -$9.62
```

## The FIFO premise

One lot, opened by the entry above, closed in full by the exit. The exit sells
exactly the lot's quantity, so no partial lot arithmetic is exercised here and
`realized_status` is `complete`. Quantities are raw uint256 throughout;
`uiMultiplier` is never applied to a price (Fixture A holds that line).

`packages/rwa/test/fixture-b.test.ts` replays these two events through the FIFO
engine and requires the realized figure to land within $0.01 of -$9.62.
