# SKILL: pay an x402 endpoint only when the evidence is there

> **Status: implemented and green as of 2026-09-05 (ETHOnline 2026 window).**
> `payOrRefuse` (`@vet402/sdk`) and the MCP tool `pay_if_trusted` (`@vet402/mcp-server`) both exist
> and are exercised by tests you can run yourself — see **How a judge can run it** below.
> **One thing described here is NOT built yet: the The Graph subgraph evidence source.** It is
> scheduled for 09-08 and is marked explicitly in **What is not built yet**. Everything else on this
> page was run before it was written.
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
ℹ tests 31
ℹ suites 0
ℹ pass 31
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

`pay_if_trusted` input schema: `resourceId, resource, payee, amountUsd, method, maxPerTxUsd`.

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
not in our catalogue, and we did not add it (see **What is not built yet**).

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

## What is not built yet

Stated plainly, because a SKILL.md that oversells is worse than none.

| | state |
|---|---|
| **The Graph subgraph as an evidence source** | **NOT BUILT.** Scheduled 09-08 (WINDOW_PLAN §2 #3). The SDK accepts `policy.evidence.source: "subgraph" \| "both"` and **fail-closes** on it (`evidence_unavailable`) rather than quietly falling back to our own ledger. `subgraphId` / `_meta.block` will ride on the `source: "subgraph"` evidence rows when it lands. The queries themselves are verified working (WINDOW_PLAN §15) — the wiring into `payOrRefuse` is not. |
| **Evidence policy on the MCP tool** | Not exposed. `pay_if_trusted` takes no `policy.evidence`, because the only interesting value for it is the one above. Use `payOrRefuse` from the SDK for the vet402-ledger floor (`minL1Deliveries`) today. |
| **The uncatalogued-seller path in MCP** | Not exposed. `payOrRefuse` handles a `/decision` 404 by judging from the 402 `payTo` plus the payee score; `pay_if_trusted` refuses with `evidence_unavailable` instead, because it is not given a payment target at that point. |
| **npm publish** | Out of scope until after submission. Build from the repo. |
| **The hosted MCP gateway** | The Bazantic gateway at `bazgateway.com` fronts vet402's REST API, **not this package**; it does not expose `pay_if_trusted`. Run the stdio server above. |
