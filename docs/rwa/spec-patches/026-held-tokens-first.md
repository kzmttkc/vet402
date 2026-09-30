# SPEC patch 026: tokens held are counted before the transfer read

Status: proposed on branch `rwa-r3-fix`, 2026-09-30. Merge into SPEC §7 (the
table of answers) and §10 (the record page). METHOD_VERSION stays
rwa-recon-0.3. The limits (10/min free, 60/min paid, one reconstruction at a
time, 6 tokens public, 30 tokens Alchemy) do not change.

## Why

The third audit (2026-09-30) found that a wallet holding 192 of the 195
canonical tokens kept the one reconstruction slot about 11 s on the Alchemy
path before its 422. The time went to `alchemy_getAssetTransfers`. The
Multicall3 balance read that runs first already says how many tokens the
wallet holds.

## §7 the 422 with Alchemy

- With an Alchemy endpoint, a wallet that holds more than 30 canonical tokens
  gets 422 `wallet_too_large` from the balance read, before any transfer read.
  `limit` is `{ kind: "tokens", max: 30, found: <tokens held> }`. The tokens in
  scope include every token held, so `found` is a lower bound, and `detail`
  says "reading at least the N tokens it holds".
- A wallet holding 30 or fewer is read as before. The public path keeps its
  budget of 6 tokens (NVDA counted), so it never accepts a wallet the Alchemy
  path refuses.
- Cache: the 422 header carries `s-maxage=300`, but Vercel's CDN does not keep a
  422 (patch 025). A repeat within 5 minutes comes from the server's in-memory
  cache, which each instance keeps.

Measured 2026-09-30 with `reconstructFacts` on the public RPC and an Alchemy URL
that fails on any call: 0x92d4…f765, 0x2f45…4a07 and 0x8f10…f996 held 142, 45
and 192 tokens at head, each answered 422 with `kind: "tokens"` in 0.45 to
0.57 s, and no call reached the Alchemy URL. Tests in
`packages/rwa/test/reach.test.ts` fix 31 and 192 tokens held (no transfer read),
30 held (both transfer reads run, no 422) and the public path's budget.

## §10 the record page

- The too-large page shows the 422 `detail` and then the symbols held. A wallet
  that holds none shows the `detail` alone, which already opens with "Holds 0 of
  the 195 canonical Stock Tokens".
- Every realized figure on the record page reads like the summary line:
  "−$273.01", "+$11.56". This covers the Realized PnL line and the per-token
  Realized cell. The JSON keeps its plain decimal strings.
