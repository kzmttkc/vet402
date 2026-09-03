# Ask vet402 to validate your agent (ERC-8004)

Status 2026-09-03: **we have received zero requests.** This page exists so the first one is possible,
not because a queue is waiting. In 750,000 blocks of Base (~17 days) the ValidationRegistry at
`0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58` recorded **two** events in total — one request and one
response, from a single validator about a single agent. The registry is essentially unused.

## Why you have to start it, not us

ERC-8004 is written in one direction. The **agent owner** (or an approved operator) calls
`validationRequest(validatorAddress, agentId, requestURI, requestHash)`; the **validator** answers with
`validationResponse(...)`. A validator cannot open a request about an agent it does not own —
the call reverts with `Not authorized`. We measured this on Base against three live agents on
2026-08-21 through 2026-09-03: fourteen attempts, fourteen reverts, zero transactions sent.

That means vet402 can publish a signed on-chain record about your endpoint **only if you ask for it**.

## How to ask

1. Have an agent id in the ERC-8004 Identity Registry (`0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`)
   whose owner is the address you control.
2. Call, from that owner address on Base mainnet:

   ```
   ValidationRegistry.validationRequest(
     validatorAddress = 0x24d5DD87fB24eC4D923b9c1D1d0dDedD8eeD037d,   // vet402
     agentId          = <your agent id>,
     requestURI       = https://vet402.com/observatory/e/<your endpoint id>,
     requestHash      = keccak256(<your x402 purchase id, chain:txHash>)
   )
   ```
3. That is all. We watch the registry for requests naming that address.

## What we will write back

A `validationResponse` carrying the same measurement the public record carries — the L0 payment-wall
result and, where a real purchase exists, whether it settled with an on-chain receipt. Response value
is 0–100 per ERC-8004 (0 = failed, 100 = passed), `responseURI` points at the endpoint record, and the
tag says which level it came from (`vet402:l1`, `vet402:l2`).

We will not write a record we did not measure, and we will not withhold one because it is unflattering.
If we later find the record was wrong, the correction is published at
[/corrections](https://vet402.com/corrections) with the same weight.

## Checking for yourself

`npm run registry:inbox -- --validator 0x24d5DD87fB24eC4D923b9c1D1d0dDedD8eeD037d --blocks 750000`
scans the registry read-only and prints how many requests name us. Today it prints zero, and the
count of events in the whole registry, so that a zero cannot be confused with a broken scanner.
