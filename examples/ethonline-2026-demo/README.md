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
