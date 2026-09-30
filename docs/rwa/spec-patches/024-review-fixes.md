# SPEC patch 024: four fixes from the rwa-recon-0.3 review

Status: shipped on 2026-09-30 (main `df6d1393` to `7ea94342`), from branch
`rwa-fix1`. Merged into SPEC §7 (facts routes, the table of answers) and §9
(reads and limits). METHOD_VERSION stays
rwa-recon-0.3. The record's fields and the realized figures do not change.

## §9 A refused Alchemy URL also moves the log reads

When `RWA_ALCHEMY_URL` answers 401, 403 or "network not enabled", the refusal is
remembered for 10 minutes and every read goes to the non-Alchemy primary
(`RWA_RPC_URL`, else the public RPC). This now includes the Transfer log walk
and the UIMultiplierUpdated reads. They no longer fix their URL list to the
Alchemy URL. The URL is chosen per batch, so a walk that meets the refusal in
its first batch finishes on the public RPC. `eth_getLogs` still never goes to
the head-only fallback.

## §9 The paid lane ends the look-alike search 30 s after the request

The look-alike search is the last step of a fresh record. It already ends 38 s
after the record started. The paid route also passes its own limit: 30 s after
the request started, which leaves 8 s before settle must begin (38 s). A search
cut short says so in `lookalikes_scope.not_scanned` with the existing wording
("no time was left inside the record's deadline") and `complete: false`. A paid
call that joins a record already being built gets that record as it is.

## §7 / §9 With Alchemy, more than 30 tokens is `wallet_too_large`

With Alchemy, each token the wallet held or moved costs one state read and one
multiplier read, one after another. Past 30 such tokens the request answers 422
`wallet_too_large` at once, with `limit: { kind: "tokens", max: 30, found: N }`
and a detail that says "reading N tokens it held or moved". No state or receipt
is read. The paid lane answered 503 `charged: false` for this case. Since the 2026-09-30
audit fix it answers 422 `wallet_too_large` with `charged: false` (SPEC §7 errors).

Basis: on 2026-09-30, 20 serial `readTokenState` calls against the public RPC
for the demo wallet took 3.9 s in total (median 194 ms). How: a scratch script,
not in the repo, that called `readTokenState` from packages/rwa/feed.ts for the
first 20 registry tokens one after another at head 76165657 and timed each call.
So 30 tokens cost about 6 s, and all 195 would cost about 39 s. The Alchemy
endpoint was not timed.

Table row, replacing the 422 line:

| 422 `wallet_too_large` | one request cannot rebuild it: more than 6 tokens to walk on the public RPC (16 log queries each), or with Alchemy more than 600 transactions to replay or more than 30 tokens held or moved. The body lists the held symbols and the limit hit. Cached like the 404 |

## §7 404 and 422 go stale for 60 s at most

The free route's 404 `no_stock_token_activity` and 422 `wallet_too_large` now
carry `public, max-age=60, s-maxage=300, stale-while-revalidate=60`. A wallet
that buys its first Stock Token no longer reads "none" from the CDN for a day.
The 200 record keeps `public, max-age=60, s-maxage=300, stale-while-revalidate=86400`.

Table row, replacing the 404 line's last sentence:

| 404 `no_stock_token_activity` | holds none of the canonical tokens and no history in scope. The body states what was checked (below). Cached: `s-maxage=300, stale-while-revalidate=60` |
