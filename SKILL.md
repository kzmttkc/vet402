# SKILL: pay an x402 endpoint only when the evidence is there

> **Status: implemented and green as of 2026-09-05 (ETHOnline 2026 window).**
> `payOrRefuse` (`@vet402/sdk`) and the MCP tool `pay_if_trusted` (`@vet402/mcp-server`) both exist
> and are exercised by tests you can run yourself — see **How a judge can run it** below.
> **The Graph subgraph evidence source is built, wired and paid for.** `payOrRefuse` reads the
> x402 Base subgraph directly (`packages/sdk/src/subgraph-evidence.ts` →
> `packages/sdk/src/pay-or-refuse.ts`), and on 2026-09-05 it signed and settled a real $0.01 USDC
> payment to The Graph's own x402 endpoint on that evidence alone — tx
> [`0xf12093fb…e469ad`](https://basescan.org/tx/0xf12093fba9314b1d3a514e7b667969201be8d021a6f4d6bdeb8d6c7f2de469ad).
> See **Paying on The Graph's own data** below. What remains unbuilt is listed in
> **What is not built yet**, and everything on this page was run before it was written.
> Required by The Graph's prize: "Open-source the code with a clear README **or SKILL.md** so judges can run it."

## What this gives an agent

A payment gate that holds the signer.

Most trust tools *answer a question* and leave the payment to you. `pay_if_trusted` is different:
on anything other than `ALLOW`, **the payment module is never even loaded**, so no signature can
exist. The refusal is machine-readable and it happens *before* a signature, not after.

The refusal names **our** gap, not the seller's fault: `l1_not_attempted` means "we have never
bought from them", not "they are bad".

## Install

`@vet402/sdk@0.5.0` and `@vet402/mcp-server@0.2.0` on npm predate this work — publishing is out of
scope until after submission (WINDOW_PLAN §2). **Build from the repo:**

```bash
git clone https://github.com/kzmttkc/vet402.git
cd vet402/packages/sdk        && npm install && npm run build
cd ../mcp-server              && npm install && npm run build
```

`packages/mcp-server` depends on `packages/sdk` through `file:../sdk`, so the SDK must be built
first. `npm install` in `mcp-server` creates the link.

## Configure

The MCP server takes no constructor arguments — **its env block is its options object.**

```jsonc
{
  "mcpServers": {
    "vet402": {
      "command": "node",
      "args": ["/absolute/path/to/vet402/packages/mcp-server/dist/index.js"],
      "env": {
        "VOUCH_API_KEY": "…",          // required. https://vet402.com/dashboard/keys
        "VOUCH_TIMEOUT_MS": "10000"    // optional, default 10000
        // "VOUCH_PAYER_PRIVATE_KEY": "0x…"  // optional — see "Actually paying"
      }
    }
  }
}
```

## How a judge can run it

Every block below was executed on 2026-09-05 and the output is pasted verbatim.

### 1. The tests (no key, no network)

```bash
cd packages/mcp-server && npm test 2>&1 | grep -E '^ℹ '
```

```
ℹ tests 32
ℹ suites 0
ℹ pass 32
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

The three that matter are `G21a` / `G21b` / `G21c`. They wrap the signer in a `Proxy` and assert on
**property access**, not call count — a refusal must show *zero* `sign*` accesses, because
"never called" and "cannot be reached" are different claims. `G21b` is the negative control: it
proves the instrument can see "exactly one", so "zero" is not just broken wiring.

### 2. The gate refusing, offline (no key, no network)

```bash
cd packages/mcp-server && node --input-type=module -e '
import { payIfTrusted } from "./dist/pay-if-trusted.js";
const signer = { address: "0x0000000000000000000000000000000000000000",
  signTypedData: async () => { throw new Error("the signer must never be reached on a refusal"); } };
const r = await payIfTrusted({
  resourceId: "9e8469d365d65bc9b4a3f588f951bfc70ae64cc1afa2ebdf7e8f11a940d40763",
  signer,
  fetch: async () => ({ ok: true, status: 200, headers: new Map(), json: async () => ({
    recommendation: "WARN", reason_codes: ["l1_not_attempted"], facts: {},
    evidence: [{ level: "L1", source: "vet402", url: "https://vet402.com/observatory" }],
    degraded: false, rules_version: "2026-09-02.1" }) }),
});
console.log(JSON.stringify(r, null, 2));
'
```

```json
{
  "decision": "REFUSE",
  "safe_to_pay": false,
  "refuse_reasons": [
    "l1_not_attempted",
    "payee_recommendation_not_allow"
  ],
  "summary": "Do not pay: the recommendation is WARN, not ALLOW.",
  "signed": false,
  "attested": false,
  "txHash": null,
  "nonce": null,
  "settlement": null,
  "measurement": {
    "recommendation": "WARN",
    "reason_codes": ["l1_not_attempted"],
    "facts": {},
    "evidence": [
      { "level": "L1", "source": "vet402", "url": "https://vet402.com/observatory" }
    ],
    "rules_version": "2026-09-02.1",
    "degraded": false
  }
}
```

The signer throws if touched. It is not touched. `nonce: null` is the machine-readable proof that
no signature exists.

### 3. The MCP server over stdio, listing the tool

```bash
cd packages/mcp-server && printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"judge","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 | VOUCH_API_KEY=dummy node dist/index.js 2>/dev/null | tail -1
```

Returns seven tools; the new one is last:

```
check_agent_trust, check_wallet_trust, check_payee_trust, explain_trust_score,
attest_x402_payment, check_resource_decision, pay_if_trusted
```

`pay_if_trusted` input schema: `resourceId, resource, payee, amountUsd, method, maxPerTxUsd, policy`
(`policy.requireVet402Allow`, `policy.evidence.{source, minL1Deliveries, minSubgraphReceipts}` — the Graph
key is **not** an input, it comes from `GRAPH_API_KEY`).

### 4. Fail-closed against the live API, with a deliberately wrong key

This one needs the network but **no valid key** — that is the point. A lookup that does not answer
must not become an ALLOW.

```bash
cd packages/mcp-server && printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"judge","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"pay_if_trusted","arguments":{"resourceId":"9e8469d365d65bc9b4a3f588f951bfc70ae64cc1afa2ebdf7e8f11a940d40763"}}}' \
 | VOUCH_API_KEY=not_a_real_key node dist/index.js 2>/dev/null | tail -1
```

The tool result text:

```json
{
  "decision": "REFUSE",
  "safe_to_pay": false,
  "refuse_reasons": ["evidence_unavailable"],
  "summary": "The decision could not be read — no answer is not an ALLOW.",
  "signed": false, "attested": false, "txHash": null, "nonce": null, "settlement": null,
  "measurement": { "recommendation": null, "reason_codes": [], "facts": {},
                   "evidence": [], "rules_version": null, "degraded": null }
}
```

That `resourceId` is real: `sha256("POST https://gateway.thegraph.com/api/x402/subgraphs/id/…")`,
The Graph's own x402 endpoint. With a valid key it returns **HTTP 404 `not_found`** — The Graph is
not in our catalogue, and we did not add it (see *The uncatalogued-seller path in MCP* under
**What is not built yet**). The subgraph evidence source does not need the catalogue — see
**Paying on The Graph's own data**.

## Reading the answer

Read two fields and nothing else:

| field | meaning |
|---|---|
| `decision` | `PAID` \| `REFUSE` \| `FAILED` |
| `safe_to_pay` | boolean, always `decision === "PAID"` |

- **`REFUSE`** — stopped *before* a signature existed. `refuse_reasons` carries the server's own
  `reason_codes` **unchanged** (we do not overwrite them with our vocabulary), plus one of
  `evidence_unavailable`, `payee_recommendation_not_allow`, `payment_target_unknown`,
  `payer_not_configured`, `payee_mismatch`, `chain_or_asset_mismatch`, `price_above_ceiling`.
- **`FAILED`** — it signed and the seller did not settle. `signed` and `nonce` are returned, not
  hidden: an EIP-3009 authorization stays live until `validBefore`, so it can still be settled
  later, and the nonce is the only way to tie an on-chain tx back to this purchase.
- **`settlement`** is at most `"settle_claimed"`. The seller's `PAYMENT-RESPONSE` header is a
  *claim*; only a verifier that re-reads the chain may say `settled`. We do not blur that line.
- **`measurement`** is the `/decision` body **verbatim**, including `evidence[]` with each row's own
  `source`. A test fails if we rewrite those rows — see *Why `source` matters*.

## Actually paying

**By default this server cannot move money, and that is deliberate.** Signing needs two things you
must opt into:

1. `VOUCH_PAYER_PRIVATE_KEY` in the server's env block, and
2. `npm i viem` inside `packages/mcp-server` (viem is *not* a dependency — an MCP server that holds
   a private key should be a choice, not something you get by installing).

Without both, the tool still runs the whole gate and returns the decision, then refuses with
`payer_not_configured`. To execute, also pass `resource`, `payee` and `amountUsd`; omit them and you
get the gate alone (refusing with `payment_target_unknown`).

`payee` is the address **you already expect**; the 402 challenge's `payTo` must match it. Money
gate, unchanged from the SDK: Base mainnet only, canonical USDC `0x8335…2913`, scheme `exact`,
EIP-3009, EIP-712 domain pinned to the token's on-chain values (never read from the seller), a
120-second authorization window, and a per-payment ceiling (`maxPerTxUsd`, default $1).

The buyer never calls a facilitator: sign → resend the original request with `PAYMENT-SIGNATURE` →
read the receipt from the response header. A test asserts zero calls to any `/settle` URL.

## Why `source` matters

`source: "subgraph"` reads **only** The Graph — our ledger is not consulted at all.
**You do not have to trust us.** Every decision returns which source it actually read, so the answer
is checkable after the fact. `pay_if_trusted` passes `evidence[]` through untouched for exactly this
reason, and two mutation tests fail if a future change strips `source` or rewrites every row to
`"vet402"`.

## Paying on The Graph's own data

`policy.evidence.source: "subgraph" | "both"` makes `payOrRefuse` read the x402 Base subgraph
(`Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj`) through the Graph Gateway and put the result on
the decision as its own evidence row — `source: "subgraph"`, with `subgraphId`, `_meta.block` and
`queriedAt`, so a reader can tell a live read from a cached number. `minSubgraphReceipts` is the
floor you can then require. If the subgraph cannot be read, the call **refuses** with
`evidence_unavailable` + `subgraph_evidence_unavailable`; it never falls back to our own ledger.

Wiring: `packages/sdk/src/subgraph-evidence.ts` (the reader) → `packages/sdk/src/pay-or-refuse.ts`
(§3.5, read before the judgement so a refusal still carries what the other source knew) →
exported from `packages/sdk/src/index.ts`. Tests `C11`, `C11b`, `C11c` and
`packages/sdk/test/subgraph-evidence.test.mjs` cover the floor, the caller-error cases and the
reader contract:

```bash
cd packages/sdk && npm install && npm test 2>&1 | grep -E '^ℹ '
```

```
ℹ tests 159
ℹ pass 159
ℹ fail 0
```

(Re-run 2026-09-06 with `npm ci && npm test`. The count grows as tests are added — run it, do not
trust this line.)

**It has moved real money.** On 2026-09-05 a throwaway payer bought The Graph's own x402 endpoint
with `requireVet402Allow: false` and `minSubgraphReceipts: 1`. Our own engine rates that payee
**WARN 69**; the caller's policy said "The Graph's own ledger is enough". It read **259** receipts
and paid.

```
payOrRefuse   status=paid   signed=true
reasons       resource_uncatalogued, allowed_by_caller_policy
verdict from  caller_policy
floor met     minSubgraphReceipts (subgraph) 1 <= 259
txHash        0xf12093fba9314b1d3a514e7b667969201be8d021a6f4d6bdeb8d6c7f2de469ad
```

Re-read on-chain, not taken from the API's own word: block **50898704**, success, an ERC-20
`Transfer` of **0.01 USDC** from `0xdb62bd20…3aa673` to The Graph's receiving wallet
`0x79dc34e4…d52fccb`, payer balance 1.00 → 0.99, payer ETH still 0 (EIP-3009 — the buyer pays no
gas). Check it yourself:
<https://basescan.org/tx/0xf12093fba9314b1d3a514e7b667969201be8d021a6f4d6bdeb8d6c7f2de469ad>.
The decision record kept `verdict from: caller_policy` and the waived `WARN`: **we did not rewrite
our own judgement to match the payment.** (Details: `docs/ethonline-2026/WINDOW_PLAN.md` §10.5.)

### Paying on The Graph's own data — live

The two commands filmed in the demo video read The Graph **live** through your own gateway key.
Build order and runtime first:

```bash
# Node >= 22.18 (examples/ethonline-2026-demo/package.json "engines" — the demo runs .ts files directly)
cd packages/sdk && npm install && npm run build      # 1. the SDK first — the demo imports its dist/
cd ../../examples/ethonline-2026-demo                 # 2. then the demo (nothing to install without --live)
export GRAPH_API_KEY=…    # free key from Subgraph Studio: https://thegraph.com/studio → API Keys
export VOUCH_API_KEY=…    # https://vet402.com/dashboard/keys
node src/run.ts refuse    # two sources side by side; refuses before a signature can exist
node src/run.ts pay       # dry run: fetches the real 402 challenge, signs nothing (no --live)
```

Both were run on 2026-09-06 13:01 UTC. Key values are never printed — the demo's own redactor
(`src/emit.ts`) rewrites the key inside the gateway URL to `<KEY>`. `refuse`, abridged to the lines
that matter:

```
 [A] vet402  GET /decision?role=payer           [B] The Graph  x402 Base subgraph (live)
 recommendation  WARN                           _meta.block.number   50955183
 reason_codes    l0_pass                        _meta.block.time     2026-09-06T13:01:53Z
                 l1_not_attempted               _meta.deployment
                 l2_undeclared                    QmcE24HARdXXnziPii9bWFRV6njfWW82H1RKPe5x9hBkUN
 L1 delivered    0  (settled 0, tried 0)        totalPayments        30
 result    refused    signed  false    nonce  null    tx  null
 reasons   l0_pass, l1_not_attempted, l2_undeclared, payee_recommendation_not_allow
 evidence[0]  L1  source=subgraph  receipts=30  block=50955183
 requests  2  —  0 signatures, 0 RPC, 0 settle
           POST https://gateway.thegraph.com/api/<KEY>/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj
```

`pay` (dry run, same minute):

```
 [ok  ] subgraph evidence is live        block 50955185, 260 receipts
 [waiv] payee verdict is ALLOW           WARN (69) — not required by policy
 [ok  ] evidence floor: subgraph >= 1    260 receipts (need 1)
 env       GRAPH_API_KEY=set  VOUCH_API_KEY=set  DEMO_PAYER_PRIVATE_KEY=MISSING
 DRY RUN — no signature was created. The signing module was never loaded.
```

If the subgraph answer carries no `_meta.block`, the reader refuses with `graph_no_block_meta`
(`packages/sdk/src/subgraph-evidence.ts`) — static or cached data does not pass.

## `pay_if_trusted` with The Graph evidence

Since 2026-09-06 the MCP tool takes the same `policy` the SDK does, and forwards it to `payOrRefuse`
**unchanged** — the tool is a thin bridge, it does not re-implement the judgement:

| input | meaning |
|---|---|
| `policy.requireVet402Allow` | default `true`. `false` waives a vet402 **WARN** when every declared floor is met. **BLOCK and `degraded` still refuse** (WINDOW_PLAN §3.2.1) — the boundary lives in the SDK and the MCP tests pin it through the bridge. Needs at least one floor above 0, otherwise the call is a caller error (`invalid_policy`) before any network. |
| `policy.evidence.source` | `"vet402"` (default) \| `"subgraph"` \| `"both"`. `"subgraph"` reads **only** The Graph's x402 Base subgraph; `"both"` refuses if either source cannot be read. |
| `policy.evidence.minSubgraphReceipts` | floor on receipts The Graph's subgraph knows for the payee (`source` must be `subgraph` or `both`). |
| `policy.evidence.minL1Deliveries` | floor on vet402's delivered L1 purchases (`source` must be `vet402` or `both`). |

**The Graph key is not a tool input.** It is read from `GRAPH_API_KEY` in the server's env block, so it
never enters the model's context. If `source` asks for the subgraph and the key is missing, the tool
refuses with `graph_key_not_configured` (plus `evidence_unavailable`, `subgraph_evidence_unavailable`)
**before reading anything** — it does not quietly fall back to judging on vet402 alone.

The answer gains one field, `decision_record`: the SDK's `PayDecisionRecord` verbatim. Its
`evidence[]` carries the subgraph read as its own row (`source: "subgraph"`, `receipts`,
`block.number`, `deployment`, `queriedAt`), `verdict_source` says whose rule decided
(`decision` / `payee_score` / `caller_policy`), and `policy_override` — when
`requireVet402Allow: false` actually waived something — lists what was waived and which floors were
met with which numbers. `measurement` stays what it was: the `/decision` body untouched.

Launch with the key in env (Claude Desktop / Cursor: the same `env` block as `VOUCH_API_KEY`):

```bash
cd packages/mcp-server && printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"judge","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"pay_if_trusted","arguments":{
    "resourceId":"ae0091e802c83179e3b1464a7b15dac64a0c1d3a00cb690eb6a5ac9811c47e3b",
    "resource":"https://kronossignals.com/api/v1/price/btc",
    "payee":"0x36038e1d712c5e39f35952164ec58ec2b96caee7",
    "amountUsd":0.02,
    "policy":{"evidence":{"source":"subgraph","minSubgraphReceipts":1000000000}}}}}' \
 | VOUCH_API_KEY=$VOUCH_API_KEY GRAPH_API_KEY=$GRAPH_API_KEY VOUCH_PAYER_PRIVATE_KEY=$THROWAWAY_KEY \
   node dist/index.js 2>/dev/null | tail -1
```

That `resourceId` is a catalogued seller our engine rates **ALLOW**. The floor of 10⁹ receipts is
deliberately unmeetable, so the run reads the **live Gateway** and stops before a signature — a way
to show the evidence row without moving money. Run on 2026-09-06 13:18 UTC (the long verbatim
`/decision` bodies are folded with `…`; every other value is as returned):

```json
{
  "decision": "REFUSE",
  "safe_to_pay": false,
  "refuse_reasons": [
    "l0_pass",
    "l1_delivered",
    "l2_undeclared",
    "insufficient_subgraph_evidence"
  ],
  "summary": "Do not pay: l0_pass, l1_delivered, l2_undeclared, insufficient_subgraph_evidence.",
  "signed": false,
  "attested": false,
  "txHash": null,
  "nonce": null,
  "settlement": null,
  "measurement": {
    "recommendation": "ALLOW",
    "reason_codes": [
      "l0_pass",
      "l1_delivered",
      "l2_undeclared"
    ],
    "facts": {
      "…": "verbatim /decision facts, unchanged"
    },
    "evidence": [
      "… the two vet402 rows, unchanged"
    ],
    "rules_version": "2026-09-02.1",
    "degraded": false
  },
  "decision_record": {
    "recommendation": "REFUSE",
    "reason_codes": [
      "l0_pass",
      "l1_delivered",
      "l2_undeclared",
      "insufficient_subgraph_evidence"
    ],
    "verdict_source": "decision",
    "evidence": [
      {
        "level": "L1",
        "source": "subgraph",
        "url": "https://gateway.thegraph.com/api/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj",
        "subgraphId": "Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj",
        "block": {
          "number": 50955674,
          "timestamp": 1788700695
        },
        "deployment": "QmcE24HARdXXnziPii9bWFRV6njfWW82H1RKPe5x9hBkUN",
        "queriedAt": "2026-09-06T13:18:16.672Z",
        "receipts": 1351
      },
      {
        "level": "L0",
        "source": "vet402",
        "url": "https://vet402.com/observatory/e/dd0869a6-10a1-40a5-b6eb-f75ab7b5a00c"
      },
      {
        "level": "L1",
        "source": "vet402",
        "url": "https://vet402.com/api/v1/observatory/endpoints/dd0869a6-10a1-40a5-b6eb-f75ab7b5a00c/purchases",
        "purchase_id": "eip155:8453:0x4a1251f2ea6183d9bc9a0de89416a63122ce45fdd611c945f846080959277558"
      }
    ],
    "decision": {
      "…": "the /decision body verbatim (recommendation ALLOW, rules_version 2026-09-02.1)"
    },
    "payeeScore": null,
    "policy_override": null,
    "source": "mcp"
  }
}
```

Read it bottom-up: The Graph's subgraph knew **1,351** receipts for that payee at block **50955674**
(`deployment` and `queriedAt` say it was a live read, not a cached number); the floor was 10⁹; so
`insufficient_subgraph_evidence`, `signed: false`, `nonce: null`. vet402 said ALLOW and that is
still there, unrewritten, in `measurement` — the two sources are reported side by side, never added.

Same call with `GRAPH_API_KEY` unset:

```json
{
  "decision": "REFUSE",
  "safe_to_pay": false,
  "refuse_reasons": ["evidence_unavailable", "subgraph_evidence_unavailable", "graph_key_not_configured"],
  "summary": "policy.evidence.source asks for The Graph, but this server has no Graph Gateway key: set GRAPH_API_KEY in the MCP server's env block (it is never taken from tool input). Nothing was read and nothing was signed.",
  "signed": false, "attested": false, "txHash": null, "nonce": null, "settlement": null,
  "measurement": { "recommendation": null, "reason_codes": [], "facts": {}, "evidence": [], "rules_version": null, "degraded": null },
  "decision_record": null
}
```

Tests: `packages/mcp-server/test/pay-if-trusted.test.mjs` H1–H7 — WARN + subgraph 259 pays with the
signer touched exactly once and `source: "subgraph"` on the record; subgraph 0 refuses with
`insufficient_subgraph_evidence` and the signer untouched; BLOCK and `degraded` refuse even with
`requireVet402Allow: false`; a missing key refuses with zero network calls; no floor is a caller
error; and `tools/list` shows `policy` but no key field. Each gate was removed one at a time to
confirm the test that guards it goes red.

### Paying a seller outside the catalogue — live

The demo's payee, The Graph's own x402 endpoint, is **not in vet402's catalogue**: `/decision` for its
`resource_id` answers **404 `not_found`** (WINDOW_PLAN §3.1, measured 2026-09-04). Until 2026-09-06
the MCP tool stopped there with `evidence_unavailable`, so there was no way to pay The Graph *from*
an MCP client even though `payOrRefuse` could already judge that case (I23). Now, when `resource`
(the URL that answers 402) is given, the 404 is handed to the SDK, which judges from the 402's
`payTo`, the payee score for that address and the caller's floors. The boundary is the SDK's and is
pinned through the bridge (`test/pay-if-trusted.test.mjs` H8–H12): `payTo` must equal `payee`, a
**BLOCK** payee score refuses even with `requireVet402Allow: false`, and a 404 **without** `resource`
still refuses with `evidence_unavailable` after exactly one request.

Run against the real Gateway on 2026-09-06 13:30 UTC — The Graph's own 402 URL as `resource`,
`requireVet402Allow: false`, `source: "subgraph"`, and a floor of 10⁹ receipts that cannot be met, so
it reads The Graph live and stops before a signature (key values redacted; nothing else edited):

```bash
cd packages/mcp-server && printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"judge","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"pay_if_trusted","arguments":{
    "resourceId":"9e8469d365d65bc9b4a3f588f951bfc70ae64cc1afa2ebdf7e8f11a940d40763",
    "resource":"https://gateway.thegraph.com/api/x402/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj",
    "payee":"0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB",
    "amountUsd":0.01,
    "method":"POST",
    "policy":{"requireVet402Allow":false,"evidence":{"source":"subgraph","minSubgraphReceipts":1000000000}}}}}' \
 | VOUCH_API_KEY=$VOUCH_API_KEY GRAPH_API_KEY=$GRAPH_API_KEY VOUCH_PAYER_PRIVATE_KEY=$THROWAWAY_KEY \
   node dist/index.js 2>/dev/null | tail -1
```

```json
{
  "decision": "REFUSE",
  "safe_to_pay": false,
  "refuse_reasons": [
    "resource_uncatalogued",
    "insufficient_subgraph_evidence"
  ],
  "summary": "Do not pay: resource_uncatalogued, insufficient_subgraph_evidence.",
  "signed": false,
  "attested": false,
  "txHash": null,
  "nonce": null,
  "settlement": null,
  "measurement": {
    "recommendation": null,
    "reason_codes": [],
    "facts": {},
    "evidence": [],
    "rules_version": null,
    "degraded": null
  },
  "decision_record": {
    "recommendation": "REFUSE",
    "reason_codes": [
      "resource_uncatalogued",
      "insufficient_subgraph_evidence"
    ],
    "verdict_source": "payee_score",
    "evidence": [
      {
        "level": "L1",
        "source": "subgraph",
        "url": "https://gateway.thegraph.com/api/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj",
        "subgraphId": "Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj",
        "block": {
          "number": 50956053,
          "timestamp": 1788701453
        },
        "deployment": "QmcE24HARdXXnziPii9bWFRV6njfWW82H1RKPe5x9hBkUN",
        "queriedAt": "2026-09-06T13:30:57.083Z",
        "receipts": 260
      }
    ],
    "decision": null,
    "payeeScore": null,
    "policy_override": null,
    "source": "mcp"
  }
}
```

Read it bottom-up: `measurement` is empty because there is no `/decision` body to pass through — the
catalogue said 404. `decision_record.reason_codes` starts with `resource_uncatalogued`, the
machine-readable mark of the 404 path. The Graph's subgraph knew **260** receipts for that wallet at
block **50956053** (`deployment` and `queriedAt` say it was a live read), the floor was 10⁹, so
`insufficient_subgraph_evidence`, `signed: false`, `nonce: null`. `payeeScore` is `null` here only
because the floor stopped the run before the 402 and the score were read — the SDK applies declared
floors first (§3.6) so that a refusal still shows what the other source knew. With a floor of 1 the
same call reads the 402, checks `payTo`, reads the payee score (WARN 69), and pays under
`verdict_source: "caller_policy"` — that is the path H8 pins with a mock seller, and the path that moved
0.01 USDC on 2026-09-05 from the SDK directly (§ "It has moved real money").

## What is not built yet

Stated plainly, because a SKILL.md that oversells is worse than none.

| | state |
|---|---|
| **Evidence policy on the MCP tool** | Exposed as of 2026-09-06 (`ethonline: feat(mcp)` on `ethonline/payorrefuse`): `policy.requireVet402Allow` and `policy.evidence` (`source`, `minSubgraphReceipts`, `minL1Deliveries`) are tool inputs; the Graph key comes from `GRAPH_API_KEY`. See **`pay_if_trusted` with The Graph evidence**. |
| **The uncatalogued-seller path in MCP** | Exposed as of 2026-09-06 (second `ethonline: feat(mcp)` on `ethonline/payorrefuse`). When `resource` is given, a `/decision` 404 is handed to `payOrRefuse`, which judges from the 402 `payTo`, the payee score for that address and the caller's evidence floors (I23). Without `resource` a 404 still refuses with `evidence_unavailable`. See **Paying a seller outside the catalogue — live**. |
| **npm publish** | Out of scope until after submission. Build from the repo. |
| **The hosted MCP gateway** | Two MCP surfaces, two roles. The Bazantic gateway (`https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com/mcp`, Recipe `x402-payee-verification-via-vet402-gateway`) fronts vet402's REST API as **57 tools** (`tools/list`, measured 2026-09-06) — use it for discovery and every key-free read (`/decision`, `/resolve`, scores). `pay_if_trusted` is the one tool that holds a signer, and it is **only** in this package over stdio, not on the gateway. |
