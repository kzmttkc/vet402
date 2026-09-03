# SKILL: pay an x402 endpoint only when the evidence is there

> **Status: skeleton created 2026-09-03 (pre-window). The tool it describes does not exist yet —
> it is built during ETHOnline 2026 (2026-09-04 →). Do not treat this as shipped documentation.**
> Required by The Graph's prize: "Open-source the code with a clear README **or SKILL.md** so judges can run it."

## What this gives an agent

A payment gate. Before your agent signs an x402 payment, it asks two independent sources whether the
payee has ever delivered anything — vet402's own purchase ledger, and the **x402 Base subgraph on
The Graph** — and refuses **before a signature exists** if the evidence you asked for is not there.

The refusal names *our* gap, not the seller's fault: `l1_not_attempted` means "we have never bought
from them", not "they are bad".

## Install (planned)

```bash
npm i @vet402/sdk        # payOrRefuse
claude mcp add --transport http vet402 https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com/mcp
```

## Use (planned shape — see WINDOW_PLAN.md §2)

```ts
const r = await payOrRefuse({
  payee, resource, amountUsd, account,
  policy: {
    maxPerTxUsd: 1,
    evidence: { minL1Deliveries: 3, minSubgraphReceipts: 100, source: "both" },
  },
});
// r.status === "refused" → r.decision.reason_codes tells you which source was thin,
//                          and the signer was never reached.
// r.status === "paid"    → r.txHash on Base, attested back to the public register.
```

## Why `source` matters

`source: "subgraph"` reads **only** The Graph — our ledger is not consulted at all.
**You do not have to trust us.** Every decision returns which source it actually read, with the
indexed block number, so the answer is checkable after the fact.

## How a judge can run it

（会期中に埋める: 1行のコマンド、返るはずの形、`_meta.block` は毎回違って当然という注記、
`GRAPH_API_KEY` 無しでも `source: "vet402"` なら動くこと。）
