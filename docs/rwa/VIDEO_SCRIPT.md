# vet402 /rwa — demo video script (Open House Singapore)

Recorded 2026-09-28 JST, after `/rwa` is live on vet402.com (SPEC §13d).
Screen: recorded by Claude, silent, one clip per scene. Voice: read by Takeshi
from the "Read" column only, **one second of silence between scenes** so the
two tracks can be aligned by the silences. Target length: under 3 minutes.

Numbers on screen change with every block, so **the voice never says a live
number**. It points at the screen ("this figure", "these two lines"). The one
exception is Fixture B's −$9.62, which is frozen in `fixtures/rwa/B.md`.

The first ten seconds carry the three rules the Robinhood Chain reviewers are
most likely to check (decision 2026-09-24): `balanceOf` is not the displayed
share count, the multiplier is never applied to the Chainlink price, and a
stale oracle gets no USD.

| # | Screen (what is recorded) | Read (English, as written) |
|---|---|---|
| 1 | Facts JSON for the demo address (`/api/v1/rwa/facts/0xE9B0…C25f`): `raw` and `shares_ui` side by side, then `feed_answer` and `stale` (≈10 s) | balanceOf is not the share count. The Chainlink price already includes splits, so we never multiply it again. And a stale oracle gets no dollar value. |
| 2 | `vet402.com/rwa/0xE9B08727131E34010b34006c660D4c1B436EC25f` — whole page, slow scroll top to bottom; pause on the balance row (shares, USD, feed time, `stale`, `weekend`) | Stock Tokens on Robinhood Chain let anyone hold Nvidia on-chain. When a wallet, or an agent, claims a track record with them, there is no neutral way to check it. vet402 slash R W A rebuilds that record from public chain data alone. |
| 3 | `events_summary` line and `r1_status: partial` | Every movement of the canonical token is classified. Uniswap v3 swaps, Uniswap v4 swaps, plain transfers. Anything we cannot decode is counted as other unparsed. It is never dropped, and while it exists, the record says partial, not reconstructed. |
| 4 | The realized PnL section, then `replayed_raw` next to `raw` in the facts JSON (`/api/v1/rwa/facts/…`) | Realized profit and loss uses first in, first out, and nothing else. A lot that arrived by plain transfer has no known cost, so we do not invent one. And one check proves nothing was missed: replaying every event lands exactly on the balance the chain reports. |
| 5 | `fixtures/rwa/B.md` (the round trip and the −$9.62 line), then terminal: `npx tsx --test packages/rwa/test/fixture-a.test.ts packages/rwa/test/fixture-b.test.ts` green | Two frozen fixtures hold the method in place. Fixture A pins the price formula to a real block. Fixture B is one real round trip, priced by hand at minus nine dollars sixty-two. The code has to agree with it to the cent. |
| 6 | Terminal: the same test after changing `usd.ts` to multiply `uiMultiplier` into the price — one test turns red | Stock splits are where records usually go wrong. The feed already includes the split, so applying the multiplier again double counts. If anyone makes that mistake, this test fails. |
| 7 | Robinhood Chain explorer: the `RwaAnchor` contract and the `anchor` transaction; then terminal `npx tsx packages/rwa/scripts/anchor.ts --verify <tx> --mainnet` printing `match: true` | Before submitting, we anchored a hash of this record on Robinhood Chain. The contract has no owner and no upgrade path. Anyone can recompute the hash from the published JSON and compare it with the chain. |
| 8 | The disclaimer paragraph at the bottom of the page | No custody. No trading. No token. This is a reconstruction of public data, not investment advice. It is a new surface of vet402, built in this Buildathon, and it measures only Robinhood Chain. |

## Before recording (Claude)

- Production cold request for the demo address returns 200 in under 60s (SPEC §11 patch 011). If not, stop and report; do not raise the route limit.
- `fixtures/rwa/anchor.json` exists and `--verify` prints `match: true`.
- Browser zoom and window size fixed for all clips; no personal tabs, bookmarks or extensions visible.

## Assembly (Claude)

Detect the silences in the voice track, cut the eight clips to the spoken
length of each scene, add English subtitles from the Read column verbatim,
export mp4, check the length, and hand over the file and the subtitle text.
