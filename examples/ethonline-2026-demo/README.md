# ETHOnline 2026 demo CLI

The two commands filmed in the demo video. Both read **live** production data — vet402's own
`/decision` API and The Graph's x402 Base subgraph — and neither of them fabricates a number.

```bash
cd examples/ethonline-2026-demo

export GRAPH_API_KEY=…        # https://thegraph.com/studio  (both commands)
export VOUCH_API_KEY=…        # https://vet402.com/dashboard/keys  (both commands)

node src/run.ts refuse        # refuse before a signature can exist
node src/run.ts pay           # dry run: what would have been signed. Nothing is signed.
node src/run.ts pay --live    # actually sign and send $0.01. A human decision.
node src/run.ts judge <url>   # your own x402 URL: same picture, dry-run verdict. No signing path.
```

`packages/sdk` must be built first (`cd ../../packages/sdk && npm install && npm run build`);
this demo imports its `dist/`. No install is needed in this directory unless you use `--live`,
which additionally needs `DEMO_PAYER_PRIVATE_KEY` and `npm install viem`.

## `refuse`

Puts two independent sources side by side for the same address
(`0xb15a55e85FdF5edc41B6c1eaf7813e2c6e6def59`, the payee behind `agent.api.0x.org`):

- **[A] vet402** has *seen* this seller (`l0_pass`) and has **never bought from it** (`L1 delivered 0`).
- **[B] The Graph** knows that same address has received payments, reported with
  `_meta.block.number` and `_meta.deployment` — the only self-evident proof that the data is live.

They know different things, and the refusal names **our** gap, not the seller's fault.
`payOrRefuse` returns `status=refused`, `signed=false`, `nonce=null`: the signature does not exist,
because the payment module is never loaded on this path.

## `pay`

**The default is a dry run.** It fetches the real 402 challenge from The Graph's x402 gateway and
shows what would have been signed — amount, `payTo`, asset, the EIP-3009 authorisation window — and
then stops. `payOrRefuse` is not called, so the signing module is never loaded. It also prints, from
the facts it just read, what `--live` would do today.

`--live` is the only thing that lets a signature exist, and it is meant to be typed by a person.

## `judge <url>`

For judges who want to point the same machinery at **their own** x402 seller. It resolves the
URL, reads the 402 challenge without paying, asks vet402's `/decision` (404 for anything outside
the catalogue is expected — that is the normal case), reads the payee score for the `payTo` the
402 named, reads The Graph's x402 Base subgraph for that same address, and prints the `pay` picture
plus a **dry-run verdict**: `verdict: ALLOW|REFUSE`, `reason_codes[]`, `signed: false`.

```bash
node src/run.ts judge https://kronossignals.com/api/v1/price/btc
node src/run.ts judge https://gateway.thegraph.com/api/x402/subgraphs/id/<id> \
  --method POST --body '{"query":"{ _meta { block { number } } }"}' \
  --policy both --min-subgraph-receipts 1 --ceiling-usd 0.01
```

- `--policy vet402|subgraph|both` (default `both`) says whose ledger the evidence floors read.
  `GRAPH_API_KEY` is needed only for `subgraph` and `both`.
- `--min-subgraph-receipts N` / `--min-l1-deliveries N` declare floors. **A floor of 1 or more
  waives vet402's verdict** (`requireVet402Allow=false`), exactly as `pay` does; without a floor,
  vet402 must say ALLOW. `BLOCK` and `degraded` are never waived.
- `--ceiling-usd X` defaults to the SDK's `DEFAULT_MAX_PER_TX_USD`.
- A URL that does not answer with a `PAYMENT-REQUIRED` header stops in one line
  (`error: not an x402 endpoint: …`, exit 1).

There is **no `--live`** for this command and it takes no account: the verdict is computed with the
same rules and the same reason codes as the SDK's `payOrRefuse` (`test/judge.test.mjs` checks every
reason code against the SDK source), but the signing module is never loaded.

## Secrets

Keys are read **only** from the environment. The Graph's gateway carries the key in the URL path, so
every line this CLI prints — including error messages and stack traces — goes through one redactor
(`src/emit.ts`) that replaces known secret values and rewrites `/api/<key>/subgraphs/` to
`/api/<KEY>/subgraphs/`. `test/refuse.test.mjs` runs the command with planted keys and asserts none
of them appear; `test/emit.test.mjs` asserts no file outside `src/emit.ts` writes to stdout at all.

## Tests

```bash
npm test        # node --test test/*.test.mjs — no network, no keys needed
```
