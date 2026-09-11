# ETHOnline 2026 demo CLI

The two commands filmed in the demo video. Both read **live** production data — vet402's own
`/decision` API and The Graph's x402 Base subgraph — and neither of them fabricates a number.

```bash
cd examples/ethonline-2026-demo

export GRAPH_API_KEY=…        # https://thegraph.com/studio  (both commands)
export VOUCH_API_KEY=…        # refuse: optional (/decision answers key-less at 10/min per IP). pay: required — see `pay` below

node src/run.ts refuse        # refuse before a signature can exist
node src/run.ts pay           # dry run: what would have been signed. Nothing is signed.
node src/run.ts pay --live    # actually sign and send $0.01. A human decision.
node src/run.ts judge <url>   # your own x402 URL: same picture, dry-run verdict. No signing path.
```

`packages/sdk` must be built first (`cd ../../packages/sdk && npm install && npm run build`);
this demo imports its `dist/`. No install is needed in this directory unless you use `--live`,
which additionally needs `DEMO_PAYER_PRIVATE_KEY` and `npm install viem@2.56.3` (no lockfile here on
purpose — `scripts/judge-check.sh` and CI run this directory without an install; 2.56.3 is the version
`examples/ethonline-2026-ab/package-lock.json` resolves for the same signer path, and the root lockfile
resolves 2.55.1 — both satisfy the `^2.55.1` peer range in `package.json`).

## `refuse`

Puts two independent sources side by side for the same address
(`0xb15a55e85FdF5edc41B6c1eaf7813e2c6e6def59`, the payee behind `agent.api.0x.org`):

- **[A] vet402** has *seen* this seller (`l0_pass`) and has paid it once, but has **no delivery on record**
  (`l1_inconclusive`, `L1 delivered 0`): the one paid response came back non-2xx from our own request shape.
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

**`pay` needs `VOUCH_API_KEY` as well as `GRAPH_API_KEY`.** Its payee (The Graph's gateway) is not in vet402's catalogue
(`/decision` 404), so the verdict comes from the payee score, a keyed read. With the Graph key alone the run prints
`[  ? ] payee verdict is ALLOW   verdict not read` and `predicted --live would REFUSE before signing`; with both keys it
prints `WARN (68) — not required by policy` and `predicted --live would sign and send $0.01` (both measured 2026-09-11, dry run).

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
- `--pin-deployment <id>` **rejects the read unless `_meta.deployment` matches that id.** A block
  number proves the answer is live; it does not prove it came from the subgraph you were promised.
  The same subgraph id can be redeployed with different mappings, and until this flag existed the
  gate would have paid against the new one without noticing. Pinned and matching, nothing changes;
  pinned and different, the read is `graph_deployment_mismatch` and the verdict is `REFUSE` with
  `subgraph_evidence_unavailable` — the receipt count is never consulted. **Without the flag,
  behaviour is unchanged** (`test/judge.test.mjs` (h1) asserts the two screens are identical).
  Try both, against The Graph's own x402 subgraph:

  ```bash
  node src/run.ts judge https://kronossignals.com/api/v1/price/btc \
    --policy subgraph --min-subgraph-receipts 1 \
    --pin-deployment QmcE24HARdXXnziPii9bWFRV6njfWW82H1RKPe5x9hBkUN   # matches → verdict as before
  node src/run.ts judge https://kronossignals.com/api/v1/price/btc \
    --policy subgraph --min-subgraph-receipts 1 \
    --pin-deployment QmNotTheDeploymentYouWerePromised00000000000   # differs → REFUSE
  ```

  The pin is only read when the subgraph is: `--policy vet402` with a pin is a caller error rather
  than a pin that silently does nothing.
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
