# Hackathon Starter (vet402)

Minimal buyer-side agent template: **check trust before you pay.** One file,
one dependency, runs in under a minute with zero configuration.

## What this shows

vet402 payee scores are grounded in real purchase verification: attested x402
settlements, wallet history, and drain-pattern reads — not self-reported
reputation. This starter asks for that verdict, then lets SpendGuard's
fail-closed default decide: no clean `ALLOW`, no payment.

## Quickstart

```bash
git clone https://github.com/kzmttkc/vet402.git && cd vet402/examples/hackathon-starter
npm install
npx tsx index.ts
```

Without `VOUCH_API_KEY` this runs in **dry-run mode** (offline): the trust
lookup answers 401 locally and the guard denies with
`payee_trust_unauthenticated` — a live demonstration of the fail-closed
default. Get a key at [vet402.com/dashboard/keys](https://vet402.com/dashboard/keys),
`export VOUCH_API_KEY=...`, and the same file runs against the hosted API.

## For ETHGlobal builders (agent track)

If your hack has an agent that spends money — x402 endpoints, autonomous
purchasing, agent-to-agent commerce — the judging question is always "what
stops it from paying a scam?". This template is that answer in ~150 lines:
score the payee, gate the payment on a fail-closed policy, and (commented, in
`index.ts`) execute on Base Sepolia testnet and attest the settlement back so
the next agent's score is smarter. Fork it, swap in your wallet stack, keep
building after the weekend — the SDK ([`@vet402/sdk`](../../packages/sdk/))
and API stay up.

## Where to go deeper

- [`../agentkit-spend-guard`](../agentkit-spend-guard/) — deterministic
  SpendGuard demo (per-tx cap, daily budget) plus the Coinbase AgentKit
  integration sketch this starter's payment template is taken from
- [`../x402-trust-gate`](../x402-trust-gate/) — the seller side: Express
  middleware gating paid x402 routes on trust
- [SDK README](../../packages/sdk/README.md) — full SpendGuard contract and
  every deny reason code
