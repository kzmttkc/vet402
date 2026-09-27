# vet402 /rwa: demo video script (Open House Singapore)

Recorded 2026-09-28 JST on production (`vet402.com`). Screen: recorded by
Claude, silent, one clip per scene. Voice: read by Takeshi from the "Read"
column only, **one second of silence between scenes** so the two tracks can be
aligned by the silences. English subtitles are the "Read" column verbatim.
The subtitles are canonical; the voice is not re-recorded for pronunciation.
The name is read "vet four-oh-two" (`.company/steering/outward_names.yaml`).
Target length: under 3 minutes.

Numbers on screen change with every block, so **the voice never says a live
number**. The one exception is Fixture B's −$9.62, which is frozen in
`fixtures/rwa/B.md`.

Shape: a 10-second opening with the five things Robinhood Chain reviewers are
most likely to check (decision 2026-09-28), then 起承転結: the problem, how it
works, what real data showed us, and why it keeps running.

| # | Part | Screen (what is recorded) | Read (English, as written) |
|---|---|---|---|
| 0 | Opening (≈10 s) | Fast cuts, ≈2 s each: facts JSON `raw` vs `shares_ui` → `feed_answer` and `stale` → `fixtures/rwa/B.md` line `realized = … = -962 cents` → Blockscout: the `RwaAnchor` anchor tx on Robinhood Chain | balanceOf isn't shares. Splits live in the Chainlink price, never applied twice. Stale oracle, no dollars. One trade, priced by hand: minus nine sixty-two. Anchored on Robinhood Chain. |
| 1 | 起: the problem | `vet402.com/rwa/0xE9B08727131E34010b34006c660D4c1B436EC25f`, top of page | Stock Tokens let anyone hold Nvidia on Robinhood Chain. When someone shows you their track record with them, you have to take their word for it. vet four-oh-two slash R W A rebuilds that record from public chain data, so you don't have to. |
| 2 | 承: what it reads | Slow scroll: the balance row (shares, USD, feed time, `stale`, `weekend`), then `events_summary` | It reads three things only: the canonical token's transfers, Uniswap swaps checked against the official factory, and the Chainlink feed for the token. Every movement is sorted into one of four kinds, and nothing is thrown away. |
| 3 | 承: how it adds up | The realized PnL section on the page, then the facts JSON with `replayed_raw` next to `raw` | Profit and loss is first in, first out, nothing else. A lot that arrived by plain transfer has no known cost, so we don't make one up. And one check proves nothing was missed: replaying every event lands exactly on the balance the chain reports. |
| 4 | 承: how it stays honest | Terminal: `npx tsx --test packages/rwa/test/fixture-a.test.ts packages/rwa/test/fixture-b.test.ts` green; then `usd.ts` changed to multiply `uiMultiplier` into the price and the same run turns one test red | Two frozen fixtures hold the method in place. If anyone applies the split twice, this test fails, and the change can't ship. |
| 5 | 転: what real data showed | The page's `events_summary` with `other_unparsed` highlighted, then Blockscout on one of those swaps showing a pool the official Uniswap factory did not create | Here's what surprised us on a real wallet. Some of its trades went through a pool the official Uniswap factory never created. We can't vouch for that pool, so those trades are counted, shown, and the record says partial. It would have been easy to hide them. |
| 6 | 結: check it yourself | Blockscout: `RwaAnchor` verified source, then terminal `npx tsx packages/rwa/scripts/anchor.ts --verify <tx> --mainnet` printing `match: true` | We anchored a hash of this record on Robinhood Chain, in a contract with no owner and no upgrade path. Anyone can recompute it from the published JSON and compare. |
| 7 | 結: why it keeps running | `docs/rwa/OPERATING.md` on GitHub, scrolling past "What stays up" and "What we will build next" | We're keeping it running after the Buildathon, with no end date, and every Stock Token is next. Paste any wallet into vet four-oh-two dot com slash R W A and check it yourself. |
| 8 | Close | The disclaimer paragraph at the bottom of the page | There's no custody, no trading and no token here. It's a reconstruction of public data, and it isn't investment advice. |

## Before recording (Claude)

- Production cold request for the demo address returns 200 in under 60s (SPEC §11 patch 011). If not, stop and report; do not raise the route limit.
- `fixtures/rwa/anchor.json` exists, Blockscout shows the source verified, and `--verify` prints `match: true`.
- Warm the demo address once right before recording so the page is not a 17-second cold load on camera.
- Browser zoom and window size fixed for all clips; no personal tabs, bookmarks or extensions visible.
- Scene 5: check on the day that the demo address still has `other_unparsed` > 0 and pick the transaction shown from the live data.

## Assembly (Claude)

Detect the silences in the voice track, cut the nine clips to the spoken
length of each scene, add English subtitles from the Read column verbatim,
export mp4, check the length, and hand over the file and the subtitle text.
