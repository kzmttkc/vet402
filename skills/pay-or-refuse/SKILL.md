---
name: pay-or-refuse
description: Pay an x402 (HTTP 402 Payment Required) resource only when vet402's evidence says the seller delivers, and refuse before any signature exists otherwise. Use when an agent receives a 402 from an API, is about to pay a seller in USDC on Base, or asks "should I pay this?". Covers the MCP tool pay_if_trusted (@vet402/mcp-server), the SDK call payOrRefuse (@vet402/sdk), every refuse reason code and what to do on each, and how to make The Graph's x402 Base subgraph your own evidence source so you do not have to trust vet402's ledger.
license: MIT
metadata:
  version: 0.5.0
  author: vet402
  documentation: https://vet402.com/docs/api
---

# pay-or-refuse — an agent's procedure for an x402 402

This skill is for the **agent that is about to pay**. The judge's runbook (clone, build, run every
block) is the repository's root `SKILL.md`; this file does not repeat it.

One rule, held by code rather than by prose: **the signer is reached only after every check has
passed.** On any refusal the payment module is never loaded, so no signature can exist. A refusal
is a machine-readable list of reason codes, and it happens *before* money can move.

## When to use this skill

- An HTTP call answered `402 Payment Required` with a `PAYMENT-REQUIRED` header (x402).
- You hold a payer wallet and are deciding whether to sign a USDC transfer on Base.
- The user asks "is it safe to pay this seller?" or "pay this if it's legit".

Do **not** use it to score a wallet or an ERC-8004 agent in general; that is `check_payee_trust` /
`check_agent_trust` on the same MCP server, and they return a verdict for *you* to act on. This
skill is the path where the tool itself holds the signer.

## Path A — MCP tool `pay_if_trusted` (Claude Code, Claude Desktop, Cursor)

The server is `packages/mcp-server` **in this repository**, launched with `node` from the plugin's
own checkout (`.mcp.json` runs `${CLAUDE_PLUGIN_ROOT}/packages/mcp-server/dist/index.js`). The npm
release `@vet402/mcp-server` is 0.2.0 (2026-08-24) and does **not** contain `pay_if_trusted`;
publishing is out of scope until after submission, so the plugin starts the build from the clone,
not the npm package. This plugin registers the server as `vet402`; without the plugin, add the
block from `packages/mcp-server/README.md` to your client, pointing `command`/`args` at the same
`dist/index.js`.

### Step 1. Turn the URL into a `resourceId`

`resourceId` is `sha256(method + " " + canonical_url)` as a 64-char hex string. Do not compute it
yourself; the canonicalisation rules live on the server:

```
GET https://vet402.com/api/v1/resolve?q=<the 402 URL>   ->  .resource.resource_id
```

No key is needed for this read.

### Step 2. Dry-run: the pre-payment checks alone

Call `pay_if_trusted` with **only** `resourceId`. This runs the checks that do not need a payment
target (Graph-key presence, `degraded`, the server's `caller_policy`, ALLOW) and always ends in
`REFUSE` with `payment_target_unknown`. Read `measurement` (the `/decision` body verbatim) and
`refuse_reasons`. If anything *other than* `payment_target_unknown` is there, stop: the payment
would be refused for that reason too.

### Step 3. Pay

Call again with the payment target:

```json
{
  "resourceId": "<64 hex from step 1>",
  "resource": "https://seller.example/api/thing",
  "payee": "0x<address you already expect to be paid>",
  "amountUsd": 0.02,
  "method": "GET",
  "maxPerTxUsd": 1,
  "policy": {
    "requireVet402Allow": true,
    "evidence": { "source": "vet402", "minL1Deliveries": 1 }
  }
}
```

- `payee` is the address **you** expect. The 402's `payTo` must equal it or the call refuses with
  `payee_mismatch`. Resolve ENS names yourself first; the gate never resolves names.
- `amountUsd` is what you believe it costs; a 402 asking more refuses with `price_above_declared`.
- `maxPerTxUsd` is your ceiling (default $1); a 402 asking more refuses with `price_above_ceiling`.
- `method` defaults to `GET`. The Graph's own x402 endpoint is `POST`.
- The Graph Gateway key is **never** a tool argument. It is read from `GRAPH_API_KEY` in the server's
  environment so it never enters the model's context.

### Step 4. Read exactly two fields

| field | meaning |
|---|---|
| `decision` | `PAID` \| `REFUSE` \| `FAILED` |
| `safe_to_pay` | boolean, always `decision === "PAID"` |

Everything else is supporting evidence: `refuse_reasons`, `summary`, `signed`, `nonce`, `txHash`,
`settlement` (at most `"settle_claimed"`), `measurement`, `decision_record`.

## Path B — SDK call `payOrRefuse` (TypeScript, your own agent loop)

```ts
import { payOrRefuse } from "@vet402/sdk";

const result = await payOrRefuse({
  payee: "0x36038e1d712c5e39f35952164ec58ec2b96caee7", // 0x address only; no ENS
  resource: "https://kronossignals.com/api/v1/price/btc",
  amountUsd: 0.02,
  method: "GET",
  account, // { address, signTypedData } — a viem account satisfies this
  fetch, // pass it explicitly; the gate never grabs the global one
  policy: {
    maxPerTxUsd: 1,
    requireVet402Allow: true,
    evidence: { source: "vet402", minL1Deliveries: 1 },
  },
  decisionStore: ".vet402/decisions.jsonl", // optional; nothing is written unless you pass it
});

if (result.status !== "paid") {
  // result.decision.reason_codes tells you why; result.signed tells you whether a signature exists
}
```

`result.status` is `"paid"`, `"refused"` (stopped before a signature) or `"failed"` (signed, and
the seller did not settle). `result.decision.reason_codes` carries the server's own `reason_codes`
unchanged plus the SDK's words from the table below. `result.decision.verdict_source` says who
allowed it: `decision` (vet402's `/decision`), `payee_score` (seller outside the catalogue),
`caller_policy` (your floors, with `policy_override` spelling out what was waived).

Caller errors (a payee that is not a 0x address, a missing `fetch`, a policy that waives vet402
without declaring a floor) **throw** with an `invalid_*` prefix before any request is made. They
are your bug, not a refusal.

## Reason codes — what each one means and what to do

The codes below are the SDK's `PAY_REFUSE_REASONS` and the MCP tool's `REFUSE_REASONS`, plus the
two the MCP layer and the settle path add. A repository test (`tests/agent-skill-plugin.test.ts`)
fails if this table and those constants drift apart. Server `reason_codes` (for example `l0_pass`,
`l1_delivered`) pass through unchanged next to them.

| code | it means | what the agent does |
|---|---|---|
| `price_above_ceiling` | the 402 asks more than `maxPerTxUsd` | do not raise the ceiling silently; tell the user the price and ask |
| `price_above_declared` | the 402 asks more than the `amountUsd` you named | re-check the seller's price page; retry only with the corrected amount if the user agrees |
| `payee_mismatch` | the 402's `payTo` is not the `payee` you expected | stop; a changed payee is the classic redirect attack. Never "fix" `payee` from the 402 |
| `chain_or_asset_mismatch` | no accept is Base mainnet + canonical USDC + scheme `exact` | stop; this gate pays USDC on Base only |
| `no_eligible_accept` | the 402 was readable but offered no payable option | stop; report the seller's accepts to the user |
| `evidence_unavailable` | `/decision` or the 402 could not be read (network, non-JSON, wrong API key) | not an ALLOW. Check `VOUCH_API_URL` / `VOUCH_API_KEY`, retry once later; do not pay blind |
| `subgraph_evidence_unavailable` | The Graph's subgraph could not be read (or a pinned `deploymentId` did not match) | check `GRAPH_API_KEY`; with `source: "both"` this refuses even if vet402 could be read |
| `graph_key_not_configured` | `policy.evidence.source` is `subgraph`/`both` but the MCP server has no `GRAPH_API_KEY` | set the key in the server's env block, never in tool input |
| `payee_recommendation_block` | vet402 says BLOCK for this payee | stop. BLOCK cannot be waived by `requireVet402Allow: false` |
| `payee_recommendation_not_allow` | vet402 says WARN (or degraded) and you require ALLOW | either stop, or declare your own floors and set `requireVet402Allow: false` (WARN only; see below) |
| `insufficient_delivery_evidence` | vet402's delivered-purchase count is below `minL1Deliveries` | lower the floor only if the user accepts the risk; otherwise stop |
| `insufficient_subgraph_evidence` | The Graph's receipt count for the payee is below `minSubgraphReceipts` | same as above; the count read is on `decision_record.evidence[]` |
| `resource_uncatalogued` | `/decision` answered 404; judgement came from the 402's `payTo` and that address's payee score | informational; it always sits next to the decisive code |
| `payment_target_unknown` | MCP only: `resource`/`payee`/`amountUsd` were not all given | expected on the dry-run; otherwise pass all three |
| `payer_not_configured` | MCP only: the server has no `VOUCH_PAYER_PRIVATE_KEY` (and `viem`) | the decision was still measured; to pay, configure the server (see Setup) |
| `settle_failed` | on `FAILED`: signed, the seller did not settle | see "If it FAILED" |
| `allowed_by_caller_policy` | not a refusal: your floors, not vet402, allowed it | appears on ALLOW records with `verdict_source: "caller_policy"`; report that to the user |

## Your own evidence source — you do not have to trust vet402

`policy.evidence.source`:

- `"vet402"` (default) — vet402's L1 delivery ledger.
- `"subgraph"` — **only** The Graph's x402 Base subgraph is read, through the Graph Gateway with
  *your* key. vet402's ledger is not consulted at all. The read lands on
  `decision_record.evidence[]` as its own row with `source: "subgraph"`, `receipts`, `block.number`,
  `deployment`, `queriedAt` — the proof it came from a live index.
- `"both"` — both are read; if either cannot be read, refuse. Counts from different sources are
  never added together.

`requireVet402Allow: false` waives a vet402 **WARN** — never BLOCK, never `degraded` — and only when
every floor you declared is met. Declare at least one floor above 0 or the call throws
`invalid_policy`. The decision record then says so out loud: `verdict_source: "caller_policy"` and
`policy_override` with what was waived and which floors were met with which numbers.

## If it FAILED

`FAILED` means a signature exists (`signed: true`) and the seller did not settle. The EIP-3009
authorization stays live until its `validBefore` (a 120-second window), so it may still be settled
later. Keep `nonce` and `txHash`: the nonce is the only way to tie an on-chain transfer back to this
purchase. **Do not sign again for the same purchase inside that window**; a second signature can
turn one failed purchase into two payments. Report the nonce to the user.

`settlement` is at most `"settle_claimed"`. The seller's `PAYMENT-RESPONSE` header is a claim; only
a verifier that re-reads the chain may say "settled".

## Setup

Install as a Claude Code plugin from a clone of the repository (the manifest is
`.claude-plugin/plugin.json`; it registers this skill, and the MCP server `vet402` from the
repository's `.mcp.json`). The server's `dist/` is committed, but its `node_modules` are not, and
`@vet402/sdk` is linked from `packages/sdk` through `file:../sdk` — so install in the same order
as the root `SKILL.md`'s **Build order** before starting Claude Code:

```bash
# live: skip installs dependencies and then starts an interactive Claude Code session — nothing to assert from stdout
cd packages/sdk && npm ci && npm run build        # 1. the SDK first — the MCP server links it through file:../sdk
cd ../mcp-server && npm ci && npm run build       # 2. then the MCP server (dist/ is committed; its node_modules are not)
cd ../.. && claude --plugin-dir "$PWD"            # 3. the plugin root is the clone: ${CLAUDE_PLUGIN_ROOT} resolves to it
```

Environment for the MCP server (all optional; the gate refuses loudly for whatever is missing):

| variable | when you need it |
|---|---|
| `VOUCH_API_URL` | defaults to `https://vet402.com/api/v1` in the plugin manifest |
| `VOUCH_API_KEY` | any judgement of an *uncatalogued* seller (payee score is a keyed read). Catalogued sellers answer key-less at 10 requests/min per IP. Free at <https://vet402.com/signup> |
| `GRAPH_API_KEY` | `policy.evidence.source` = `subgraph` or `both` |
| `VOUCH_PAYER_PRIVATE_KEY` + `npm i viem` in the server package | actually paying. Without both, every payment attempt refuses with `payer_not_configured`; the server cannot move money by default, on purpose |

## Where the code is

- SDK gate: `packages/sdk/src/pay-or-refuse.ts` (reason codes: `PAY_REFUSE_REASONS`)
- The Graph read: `packages/sdk/src/subgraph-evidence.ts`
- MCP tool: `packages/mcp-server/src/pay-if-trusted.ts` and `src/index.ts` (`pay_if_trusted`)
- Judge's runbook, every block runnable: root `SKILL.md`
