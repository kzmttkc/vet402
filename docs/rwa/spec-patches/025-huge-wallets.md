# SPEC patch 025: a huge wallet gives the slot back in seconds

Status: shipped on 2026-09-30 (main `d96660f5` to `067d0dc9`), from branch
`rwa-r2-fix`. Merged into SPEC §7 (the table of answers) and §9 (reads and
limits). METHOD_VERSION stays
rwa-recon-0.3. The limits (10/min free, 60/min paid, one reconstruction at a
time) do not change.

## Why

Second audit, 2026-09-30, in production. Opening
`0x6aa80dbbed9ae5ab45fbf61f9644fada3b29326e` (a contract, nonce 1, holds no
Stock Token) answered 503 `still_reading` after 20.5 s. While it ran, the next
three wallets got 503 `too_busy` in about 0.3 s each.

Measured locally on the public RPC with the old code: NVDA's receiving side
alone returned "logs matched by query exceeds limit of 10000" for several 10M
block ranges. The walk split them range after range and ended with HTTP 429
after 49.5 s, holding the slot all that time. With Alchemy, the old read took
up to 20 pages each way of every ERC-20 transfer, then up to 20 more pages per
contract chunk. Past that cap it threw, and the record fell back to that same
public walk.

## §9 reads stop as soon as the wallet is too large

- The shared Alchemy read (every ERC-20 transfer, both sides) counts canonical
  transfers and transactions page by page. At the first page past 600
  transactions or 20,000 transfers it stops and the wallet gets 422. Its page
  cap is unchanged (20 each way).
- The discovery read with the canonical contracts as a filter stops the same
  way. Its page cap (21 per contract chunk and side) sits past the transfer
  cap, so "too many pages" can no longer end in a fallback.
- A 422 found on the Alchemy path is final. It never falls back to the public
  walk. Only a failed Alchemy read (network, refusal, bad answer) does.
- The public walk counts the distinct transactions its log ranges name, across
  every token and side of one record, and stops past 600 (the same replay budget
  as with Alchemy). Measured 2026-09-30 on the address above: 422 after 10.3 s
  instead of HTTP 429 after 49.5 s. How: a scratch script, not in the repo,
  that ran `reconstructFacts` with `alchemyUrl: null` and logged each JSON-RPC
  POST.

A check before taking the slot was considered and not added. It would be an
RPC read outside the one-at-a-time cap, open to anyone at 10/min. A contract
address is not refused either: a contract wallet can hold Stock Tokens, and
the 422 already says why this one is not rebuilt.

## §7 the 422 body

- `limit.kind` gains `transfers` (with Alchemy, more than 20,000 canonical
  transfers). When a read stopped at a limit, `found` is the count it had
  reached and `detail` says "more than N (the read stopped at M)".
- On the public path, when the wallet does not hold NVDA, the token count
  includes NVDA and `detail` says so: "7 tokens (the 6 it holds, plus NVDA,
  which this path always walks)". It used to say only "7 tokens" next to
  "Holds 6".
- The 422 header carries `s-maxage=300`, but Vercel's CDN does not keep a 422.
  Measured 2026-09-30 on `/api/v1/rwa/facts/0x44df…b3f4`: two requests both
  `x-vercel-cache: MISS`, 10.85 s then 0.33 s. The second was answered from the
  server's in-memory cache, which each instance keeps for 5 minutes. Tests in `packages/rwa/test/reach.test.ts` check that a second ask
  for the same huge wallet reads nothing.

## §5 a public-path answer says Alchemy was not available

When an Alchemy endpoint is configured but its read failed (or its refusal is
remembered), the record lists gap `alchemy_unavailable` next to
`exited_positions_not_scanned`. The 404 lists the same gap and adds one
sentence. The 422 adds one sentence to `detail`. A record built with no
Alchemy endpoint at all does not list it.

Production on 2026-09-30 showed a case: the 422 for `0x44df…b3f4` had the
public path's limit (`tokens`, max 6) while the demo record showed an `alchemy`
source, so the Alchemy read had failed for that wallet. The reason is not
known, because no Alchemy key is available outside Vercel.

## Record page

The summary line said "sales found, none could be priced" whenever
`realized_usd` was null and `realized_status` was `partial`. A wallet that only
received Stock Tokens by transfer (`0x7f61…4c9d`: 15 transfers, 0 swaps) read
that way. Only a swap sells under the method, so with no swap and no undecoded
movement the line now says "no sales yet". With swaps and nothing priced it
says "no priced sale yet": the JSON does not say which way the swaps went, so
the line claims no sale either way. The JSON is unchanged.

## Tests

`packages/rwa/test/reach.test.ts`: endless canonical transfers stop after one
Alchemy page, endless other transfers stop after one canonical page (41 calls),
the transfer cap, the public walk stopping after one batch of four ranges, the
fallback sentence, the NVDA wording, `alchemy_unavailable` present only when
Alchemy was configured, and the slot freed for the next wallet with the 422
remembered. `packages/rwa/test/record-lines.test.ts`: the summary line.
