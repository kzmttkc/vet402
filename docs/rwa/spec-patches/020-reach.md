# SPEC patch 020: any wallet gets a fast, stable, honest answer

Status: shipped on 2026-09-30 in `rwa-recon-0.3` (main `b9d9269c`), from branch `rwa-w1-reach`. Merged into SPEC §5, §7, §9 and §10.
Method version: the integrator bumps it once to `rwa-recon-0.3`. This patch
changes scope only when `RWA_ALCHEMY_URL` is set.

## Why

Measured on 2026-09-30 in production by the sprint audit. The operator wallet
`0x973cD8a91A771C2C04C6036888F8175D6b4F6227` holds no Stock Token and got three
different answers in a row: 503 `too_busy`, then 404 after 6 s, then 503
`feed_unavailable` after 35 s. `/rwa/0x…dEaD` waited 45 s and said "Reading the
chain failed". A judge who pastes their own wallet most likely holds no Stock
Token, so this is the first answer most of them see.

Causes found in the code:

1. The empty answer (404) was not cached, in memory or at the CDN. Every paste
   walked NVDA's full history again: 16 `eth_getLogs` on the public RPC, which
   answers item-level 429 to bursts.
2. The page asked the facts route first. On a 404 or 503 it then rebuilt the
   record itself, so one page view could cost two walks.
3. A timed-out reconstruction released its in-flight slot while its reads kept
   running. The next request started another walk beside it, drawing more 429s.
4. Any failure, including an RPC timeout, was reported as `feed_unavailable`.

## §5 scope (only with `RWA_ALCHEMY_URL`)

With `RWA_ALCHEMY_URL` set, the transactions to replay come from
`alchemy_getAssetTransfers` (category `erc20`, `excludeZeroValue: false`, the
195 canonical addresses as `contractAddresses`, split 100 per request, one query
for `fromAddress` and one for `toAddress`, every `pageKey` followed, `toBlock` =
`as_of_block`). Scope becomes every canonical token that ever moved to or from
the address, plus tokens held at `as_of`. `scope.rule` says so, NVDA gets no
special case, and `exited_positions_not_scanned` is not listed.

Receipts, balances, feeds and the replay invariant are unchanged: every event
still comes from the receipt, and `replayed_raw` must equal the chain balance.
If the Alchemy call fails, the reconstruction falls back to the log walk and
the record carries the old rule and the gap.

Without `RWA_ALCHEMY_URL` nothing about scope changes.

## §7 errors

| code | when |
|---|---|
| 404 `no_stock_token_activity` | holds none of the canonical tokens and no history in scope. The body states what was checked (below). Cached like a record: `s-maxage=300, stale-while-revalidate=86400` |
| 422 `wallet_too_large` | one request cannot rebuild it: more than 6 tokens to walk on the public RPC (16 log queries each), or more than 600 transactions to replay with Alchemy. The body lists the held symbols and the limit hit. Cached like a record |
| 503 `too_busy` | another wallet is being rebuilt on this instance. `Retry-After: 30` |
| 503 `still_reading` | the read took longer than the free deadline (20 s). It keeps its slot and runs on, and a retry joins it. `Retry-After: 30` |
| 503 `chain_unavailable` | the chain RPC failed. `Retry-After: 60` |

Every 503 body is `{ error, retry_after_sec, detail }`. The paid lane keeps its
own codes and its 45 s deadline (money code, not changed here).

404 body:

```json
{
  "error": "no_stock_token_activity",
  "address": "0x…",
  "chain_id": 4663,
  "as_of": "…",
  "as_of_block": 0,
  "method_version": "…",
  "registry_tokens": 195,
  "held_tokens": 0,
  "history_checked": "every_canonical_token | nvda_only",
  "sent_tx_count": 0,
  "is_contract": false,
  "gaps": ["exited_positions_not_scanned"],
  "detail": "Holds none of the 195 canonical Stock Tokens at block N. …"
}
```

`nvda_only` means the 195 balances at `as_of_block` (one Multicall3 call) and
NVDA's incoming transfers were read. Every way of holding a token starts with a
Transfer to the address (a mint is a Transfer from 0x0), so the receiving side
alone decides whether NVDA was ever held: 8 log ranges instead of 16. When it
finds something, the full walk runs as before. `sent_tx_count` is the nonce at
`as_of_block`, null for a contract.

`0x…dEaD` holds 74 of the 195 tokens (measured 2026-09-30, one Multicall3
call). On the public RPC that is 74 × 16 = 1,184 log queries, which no request
under Vercel's 60 s can finish. Measured locally with the old code it failed
with 429 after 91 s, and after 178 s with the reach code before this limit.
It now gets `wallet_too_large` at once. The limit of 6 comes from the same day:
2 tokens took ~40 s cold and 8 tokens ~140 s on the public RPC.

A cheaper test for "any past Stock Token activity" on the public RPC was checked
and is not available: an `eth_getLogs` without an address filter is capped at
30,000 blocks per query (measured 2026-09-30, head ~76.06M), so one side for all
tokens would take ~2,500 queries. The 404 says what it did not scan instead.

## §9 jobs and RPC

- Read RPC, chosen at call time: `RWA_ALCHEMY_URL`, else `RWA_RPC_URL`, else
  `https://rpc.mainnet.chain.robinhood.com`. The paid lane uses the same
  choice, so it reads through the third-party RPC whenever one is set. The
  public fallback stays for head reads only. An env value that is not an
  `https://` URL is ignored. Scripts that write the RPC into fixtures keep the
  public URL.
- A transport error carries only its error name, never the URL (it may hold a key).
- A provider whose log span limit would need more than 64 ranges for a genesis
  walk is refused at once (`log span limit too small`).
- Cache: the empty answer is cached like a record. A caller stops waiting at its
  deadline (free 20 s, paid 45 s). The reconstruction keeps its slot until it
  ends, or until 55 s, whichever is first. The free route keeps the function
  alive with `after()` so the retry finds the result. Rate limits and the
  one-at-a-time cap are unchanged.

## §10 UI

- `/rwa/<address>` with no Stock Token renders the stated answer with status
  200 and links to example wallets. It no longer shows Next.js's 404 page.
- Every failure renders one view: the reason, the wait, and a
  `<meta http-equiv="refresh">` with that wait.
- The page uses the route's own 404 and 503 answers as final. It reads the chain
  itself only on a transport miss or a 429 from the shared bucket.
- `/rwa` lists "Try these wallets": EOAs picked from chain data that traded
  canonical tokens through the official Uniswap pools and rebuild as
  `reconstructed` or `partial` with the replay on the chain balance
  (`packages/rwa/examples.ts`). The note says what the record shows, never who
  owns the wallet.

## Tests

`packages/rwa/test/reach.test.ts` and `packages/rwa/test/cache.test.ts`: RPC
precedence and call-time choice, no URL in transport errors, the span guard,
the Alchemy client (params, chunks, pages, both sides, balances), the empty
answer on both paths and its stability, a sold-out position found through
Alchemy with the gap dropped, the unchanged path without Alchemy, the fallback
when Alchemy fails, the route's 404 and 503 bodies, the negative cache, and the
slot kept past the deadline.
