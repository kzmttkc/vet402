# SKILL: pay an x402 endpoint only when the evidence is there

> **Status: implemented and green as of 2026-09-07 (ETHOnline 2026 window; re-run on a clean clone).**
> `payOrRefuse` (`@vet402/sdk`) and the MCP tool `pay_if_trusted` (`@vet402/mcp-server`) both exist
> and are exercised by tests you can run yourself — see **How a judge can run it** below.
> **The Graph subgraph evidence source is built, wired and paid for.** `payOrRefuse` reads the
> x402 Base subgraph directly (`packages/sdk/src/subgraph-evidence.ts` →
> `packages/sdk/src/pay-or-refuse.ts`), and on 2026-09-05 it signed and settled a real $0.01 USDC
> payment to The Graph's own x402 endpoint on that evidence alone — tx
> [`0xf12093fb…e469ad`](https://basescan.org/tx/0xf12093fba9314b1d3a514e7b667969201be8d021a6f4d6bdeb8d6c7f2de469ad).
> See **Paying on The Graph's own data** below. What is and is not in this package is listed in
> **Scope notes**, and everything on this page was run before it was written.
> Required by The Graph's prize: "Open-source the code with a clear README **or SKILL.md** so judges can run it."

## Prerequisites — read this once, then every block below runs in the order written

Everything on this page was walked from a fresh `git clone` on 2026-09-07 (Node v26.3.0, npm 11.16.0).
The numbers here are from that walk, not from memory.

**Node ≥ 22.18.** The strictest `engines` among the packages this page uses is
`examples/ethonline-2026-demo` (`>=22.18` — it runs `.ts` files directly with Node's own type
stripping). `packages/sdk` and `packages/mcp-server` accept `>=20`, `examples/ethonline-2026-ab`
`>=22`. The root `package.json` says `24.x`, but that is the Next.js service; nothing on this page
needs it beyond one `npm ci` for a library (below).

**One command first.** From the repo root:

```bash
# live: skip the repo's own CI runs this on every push (npm ci + build + 5 suites, 25–30 s); its stdout is a table, not JSON
npm run judge-check     # scripts/judge-check.sh — no API key, nothing live
```

It runs `sdk: npm ci → build → test` · `mcp-server: npm ci → build → test` · `demo: npm test` ·
`root: npm ci` · `ab: npm ci → test → test-mutations`, records each step's exit code on its own (no
`&&`), prints one table, and exits 1 if any step was non-zero. It `unset`s every key before it
starts, so a green run is proof that none of this needs one. It takes **about 25–30 s on a clean
clone** (24–27 s across three measurements on 2026-09-07, warm npm cache); `git clone` itself took 1.4 s. The only network it touches is the npm registry.
The suites it runs include the boundary-shape tests (`packages/sdk/test/_shapes.mjs`, one table of malformed values — `null`, `[]`, `"true"`, `NaN`, `"0x10"`, `"1e4"`, `1e400`, … — applied by `boundary-shapes.test.mjs` in `packages/sdk`, `packages/mcp-server` and `examples/ethonline-2026-ab` to every field the SDK, the MCP tool and the A/B bridge read from a `/decision` body, a 402 challenge, a subgraph response or the caller's policy; every money-bearing field must stop before the signer, every other field must not leak into the signature).

**Build order — the dependency chain, not a preference.**

| step | why it must come first |
|---|---|
| 1. `packages/sdk` — `npm ci && npm run build` | everything else imports its `dist/` |
| 2. `packages/mcp-server` — `npm ci && npm run build` | depends on the SDK through `file:../sdk`; `npm ci` here creates the link, so the SDK's `dist/` must already exist |
| 3. `examples/ethonline-2026-demo` — nothing to install | imports `packages/sdk/dist` by relative path; `npm test` and all three commands run without an install |
| 4. `examples/ethonline-2026-ab` — `npm ci` here | the harness's x402 bridge signer imports `viem`, which is now a direct dependency of this example (it was a root-borrowed peer until 2026-09-07) |

**Keys — which blocks need one, and where a free one comes from.**

| key | needed by | not needed by | where to get it |
|---|---|---|---|
| *(none)* | — | `npm run judge-check`, sections **1–3** below (tests, offline refusal, `tools/list`), section **4** (it deliberately uses a wrong key) | — |
| `VOUCH_API_KEY` | **any judgement of an *uncatalogued* seller** — there the verdict comes from the **payee score**, which is a keyed read. The demo's `pay` (its payee is The Graph, uncatalogued) and `judge <url>` on an uncatalogued URL read `[ ? ] verdict not read` without it and flip to REFUSE (measured both ways, 2026-09-08). Also the payee-score and attest tools | catalogued sellers — their verdict comes from `/decision`, which answers key-less at 10/min per IP since 2026-09-07 (`judge https://kronossignals.com/api/v1/price/btc` measured key-less 2026-09-08: `verdict ALLOW`, `verdict from decision`). The demo's `refuse` likewise (same WARN, same refusal). Key-less REST reads: `GET /api/v1/resolve?q=…` and the object reads listed in `README.md` → *Resolve, then decide*; the Bazantic MCP gateway (see **What is not built yet**) | free: <https://vet402.com/signup> (1,000 lookups/month, no card) → <https://vet402.com/dashboard/keys> |
| `GRAPH_API_KEY` | the demo (all three commands read The Graph live) and any `policy.evidence.source: "subgraph" \| "both"` call | everything that reads vet402 only | free key from Subgraph Studio: <https://thegraph.com/studio> → *API Keys* |
| `VOUCH_PAYER_PRIVATE_KEY` / `DEMO_PAYER_PRIVATE_KEY` | moving real money (`--live`) — **and the two `pay_if_trusted` blocks that show a subgraph evidence row** (*`pay_if_trusted` with The Graph evidence*, *Paying a seller outside the catalogue — live*). Those two do not sign: their floor of 10⁹ receipts cannot be met. They need a payer only because the server withholds `resource` / `payee` / `amountUsd` from the SDK when none is configured (`packages/mcp-server/src/index.ts`), so without it the call refuses at `payer_not_configured` before The Graph is read — the measured payer-less output is printed in that section | sections **1–4**, the demo's three commands, and every dry run — those load no signing module | your own throwaway wallet on Base. **Nothing on this page signs or spends**, with or without it |

Export keys in the shell, never in a file that gets committed. The demo rewrites the key inside
the gateway URL to `<KEY>` on every line it prints (`examples/ethonline-2026-demo/src/emit.ts`), and
the SDK puts the key-less `publicUrl` on the evidence row (`packages/sdk/src/subgraph-evidence.ts`),
so a `decision_record` never carries it; the MCP outputs below were redacted by hand where noted.

**cwd.** Every block states its own `cd`; paths are relative to the repo root. If a block says
`cd packages/mcp-server` and you are already there, `../mcp-server` is the same place.

## What this gives an agent

A payment gate that holds the signer.

Most trust tools *answer a question* and leave the payment to you. `pay_if_trusted` is different:
on anything other than `ALLOW`, **the payment module is never even loaded**, so no signature can
exist. The refusal is machine-readable and it happens *before* a signature, not after.

The refusal names **our** gap, not the seller's fault: `l1_not_attempted` means "we have not
signed a paid attempt against them", and `l1_inconclusive` means "we paid, and our own request
was answered 4xx — no conclusion" (a gap in our measurement, not evidence against the seller).
Neither means "they are bad".

## Install

`@vet402/sdk@0.5.0` and `@vet402/mcp-server@0.2.0` on npm predate this work — publishing is out of
scope until after submission (WINDOW_PLAN §2 — Japanese, internal plan). **Build from the repo:**

```bash
# live: skip clones the repo — it cannot run inside a checkout of the repo it clones
git clone https://github.com/kzmttkc/vet402.git
cd vet402/packages/sdk        && npm install && npm run build
cd ../mcp-server              && npm install && npm run build
```

The order is the dependency chain in **Build order** above (the SDK's `dist/` must exist before
`mcp-server` links it).

## Configure

The MCP server takes no constructor arguments — **its env block is its options object.**

```jsonc
{
  "mcpServers": {
    "vet402": {
      "command": "node",
      "args": ["/absolute/path/to/vet402/packages/mcp-server/dist/index.js"],
      "env": {
        "VOUCH_API_KEY": "…",          // optional since 2026-09-07: check_resource_decision / pay_if_trusted read /decision key-less (10/min per IP); the score and attest tools still need one. https://vet402.com/dashboard/keys
        "VOUCH_TIMEOUT_MS": "10000"    // optional, default 10000
        // "VOUCH_PAYER_PRIVATE_KEY": "0x…"  // optional — see "Actually paying"
      }
    }
  }
}
```

## How a judge can run it

Every block below is pasted verbatim from a real run on a clean clone on 2026-09-07; the test counts are kept current by `npm run refresh-numbers` (the printed date inside a block is the run it came from).
**Every `` ```bash `` block on this page is accounted for by `scripts/skill-live-check.mjs`**
(`.github/workflows/skill-live.yml`, daily; also part of the repo's `npm test`). Each one carries a
first line that says what it is — the line is a bash comment, so it is inert if you paste the block:

| marker | what happens |
|---|---|
| `# live: expect <jq>` | re-run **every day against production**; stdout is slurped with `jq -s` and the expression must be `true`, or the run goes red and opens an issue |
| `# live: needs VAR[,VAR] expect <jq>` | the same, when those variables are set; otherwise counted as a skip |
| `# live: skip <reason>` | not run — and the reason is written here, in the open |

A block with **no** marker fails the check, so none can be dropped from the walk quietly. On top of
that, a static lint reads every block and fails if a JSON-RPC message is folded across lines: stdio
MCP reads one message per line, so a folded request is dropped without a word and you would get back
only the `initialize` reply. Two blocks on this page were broken that way until 2026-09-08, outside
the four that were then marked — which is why the walk now covers all twelve.

### 1. The tests (no key, no network)

```bash
# live: skip prints `ℹ tests N` counters, not JSON; the counts are kept current by `npm run refresh-numbers` and the suite itself runs in CI
cd packages/mcp-server && npm test 2>&1 | grep -E '^ℹ '
```

```
ℹ tests 748
ℹ suites 0
ℹ pass 748
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
# live: expect .[0].decision == "REFUSE" and .[0].signed == false and .[0].nonce == null
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
# live: expect .[0].result.tools | map(.name) == ["check_agent_trust","check_wallet_trust","check_payee_trust","explain_trust_score","attest_x402_payment","check_resource_decision","pay_if_trusted"]
cd packages/mcp-server && printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"judge","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 | VOUCH_API_KEY=dummy node dist/index.js | tail -1
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
# live: expect .[0].result.content[0].text | fromjson | .decision == "REFUSE" and .refuse_reasons == ["evidence_unavailable","invalid_api_key"] and .signed == false and .nonce == null
cd packages/mcp-server && printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"judge","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"pay_if_trusted","arguments":{"resourceId":"9e8469d365d65bc9b4a3f588f951bfc70ae64cc1afa2ebdf7e8f11a940d40763"}}}' \
 | VOUCH_API_KEY=not_a_real_key node dist/index.js | tail -1
```

The tool result text (production, 2026-09-08 — the server's own word for the 401, `invalid_api_key`, rides along after `evidence_unavailable` since 2026-09-07 so a model can tell "fix the key" from "wait"):

```json
{
  "decision": "REFUSE",
  "safe_to_pay": false,
  "refuse_reasons": ["evidence_unavailable", "invalid_api_key"],
  "summary": "The decision could not be read (HTTP 401 invalid_api_key) — no answer is not an ALLOW.",
  "signed": false, "attested": false, "txHash": null, "nonce": null, "settlement": null,
  "measurement": { "recommendation": null, "reason_codes": [], "facts": {},
                   "evidence": [], "rules_version": null, "degraded": null, "caller_policy": null },
  "decision_record": null
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
  `payer_not_configured`, `payee_mismatch`, `chain_or_asset_mismatch`, `price_above_ceiling`
  (the 402 asks more than `maxPerTxUsd`), `price_above_declared` (the 402 asks more than the `amountUsd` you named).
- **`FAILED`** — it signed and the seller did not settle. `signed` and `nonce` are returned, not
  hidden: an EIP-3009 authorization stays live until `validBefore`, so it can still be settled
  later, and the nonce is the only way to tie an on-chain tx back to this purchase.
- **`settlement`** is at most `"settle_claimed"`. The seller's `PAYMENT-RESPONSE` header is a
  *claim*; only a verifier that re-reads the chain may say `settled`. We do not blur that line.
- **`measurement`** is the `/decision` body **verbatim**, including `evidence[]` with each row's own
  `source`. A test fails if we rewrite those rows — see *Why `source` matters*.
- **`measurement.caller_policy`** (since 2026-09-07) — *your* rule, applied by the server next to
  ours, in the same words the SDK uses. See *Your own policy on `/decision`* below. When its
  `verdict` is `REFUSE`, its `reason_codes` are in `refuse_reasons` too.

## Actually paying

**By default this server cannot move money, and that is deliberate.** Signing needs two things you
must opt into:

1. `VOUCH_PAYER_PRIVATE_KEY` in the server's env block, and
2. `npm i viem` inside `packages/mcp-server` (viem is *not* a dependency — an MCP server that holds
   a private key should be a choice, not something you get by installing).

Without both, the tool reads `/decision` and applies the pre-payment checks (Graph-key presence,
degraded, the server's `caller_policy`, ALLOW), returns that decision, and refuses with
`payer_not_configured` if you passed any of `resource` / `payee` / `amountUsd` — those three are
dropped before the SDK is reached, so the evidence floors and The Graph read (both live inside the
SDK's `payOrRefuse`) are **not evaluated** on this path. To execute, configure the payer and pass
`resource`, `payee` and `amountUsd`; omit all three and you get the same pre-payment checks alone,
refusing with `payment_target_unknown` (floors not evaluated there either).

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
# live: skip prints `ℹ tests N` counters, not JSON; same reason as section 1
cd packages/sdk && npm install && npm test 2>&1 | grep -E '^ℹ '
```

```
ℹ tests 1615
ℹ pass 1615
ℹ fail 0
```

(Re-run <!-- n:as_of -->2026-09-08<!-- /n --> with `npm ci && npm test`. The count grows as tests are added — run it, do not
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
our own judgement to match the payment.** (Details: `docs/ethonline-2026/WINDOW_PLAN.md` §10.5 — Japanese, internal plan.)

### Paying on The Graph's own data — live

The two commands filmed in the demo video read The Graph **live** through your own gateway key.
Build order and runtime first:

```bash
# live: skip two `export` lines whose value is a literal `…` — this block is for a human to fill in, and its output is a table, not JSON
# Node >= 22.18 (examples/ethonline-2026-demo/package.json "engines" — the demo runs .ts files directly)
cd packages/sdk && npm install && npm run build      # 1. the SDK first — the demo imports its dist/
cd ../../examples/ethonline-2026-demo                 # 2. then the demo (nothing to install without --live)
export GRAPH_API_KEY=…    # free key from Subgraph Studio: https://thegraph.com/studio → API Keys
export VOUCH_API_KEY=…    # `refuse` runs without it; `pay` needs it (its payee is uncatalogued) — see below
node src/run.ts refuse    # two sources side by side; refuses before a signature can exist
node src/run.ts pay       # dry run: fetches the real 402 challenge, signs nothing (no --live)
```

**`VOUCH_API_KEY` is not optional for `pay`.** `/decision` answers key-less (10/min per IP), so
`refuse` is unaffected — measured key-less on 2026-09-08, same `WARN`, same refusal, and so is
`judge` on a **catalogued** URL (`verdict ALLOW`, `verdict from decision`). But `pay`'s payee is The
Graph, which is **not** in our catalogue, so its verdict comes from the **payee score** — a keyed
read. Without the key that gate cannot be read and the run's conclusion inverts. `judge` inherits
the same rule for any uncatalogued URL. Both conditions, run on 2026-09-08:

```
GRAPH_API_KEY only   [  ? ] payee verdict is ALLOW   verdict not read
                     predicted --live would REFUSE before signing
both keys            [waiv] payee verdict is ALLOW   WARN (68) — not required by policy
                     predicted --live would sign and send $0.01
```

That is fail-closed working as designed — an unread verdict is not an ALLOW — but a judge running
with one key would see a REFUSE and conclude the gate is broken. It is not; the key is missing.

Both were run on 2026-09-06 13:01 UTC. Key values are never printed — the demo's own redactor
(`examples/ethonline-2026-demo/src/emit.ts`) rewrites the key inside the gateway URL to `<KEY>`. `refuse`, abridged to the lines
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

### judge — bring your own 402 (dry-run, no signing path)

```bash
# live: skip a usage synopsis — `<url>` is yours to choose, so there is nothing fixed to run
cd examples/ethonline-2026-demo
node src/run.ts judge <url> [--method POST] [--body '<json>'] [--policy vet402|subgraph|both] \
                            [--min-subgraph-receipts N] [--min-l1-deliveries N] [--ceiling-usd X] \
                            [--pin-deployment <id>]
```

Same picture as `pay`, for any x402 URL you choose: 402 → `/decision` (404 = uncatalogued, the normal
case) → payee score for the 402's `payTo` → The Graph x402 Base subgraph → a dry-run verdict.
A floor >= 1 waives vet402's verdict (`requireVet402Allow=false`) exactly as `pay` does; BLOCK and
degraded are never waived. There is no `--live` and no account: the signing module is never loaded
(`test/judge.test.mjs` counts signer property reads — zero).
`--pin-deployment <id>` rejects the subgraph read unless `_meta.deployment` matches that id (needs `--policy subgraph` or `both`); the two-run example and the REFUSE it produces are under "`judge <url>`" in `examples/ethonline-2026-demo/README.md`.

Verified 2026-09-06 (live, keys redacted by the demo itself):

- The Graph `POST .../subgraphs/id/Cb56epg3…` with `--policy both --min-subgraph-receipts 1 --ceiling-usd 0.01`
  → `verdict ALLOW` · `resource_uncatalogued, allowed_by_caller_policy` · WARN (69) waived · subgraph 260 receipts, block 50956186
- `GET https://kronossignals.com/api/v1/price/btc` (catalogued) → `verdict ALLOW` from `/decision` · ALLOW (85) · 1351 receipts, block 50956189
- A non-402 URL stops in one line: `error: not an x402 endpoint: HTTP 200 … has no PAYMENT-REQUIRED header`

Mutation check on the demo: flipping the floor comparison, removing the BLOCK boundary, or touching the
signer each turns tests red (7 / 2 / 3 failures). `packages/sdk/test-mutations.mjs` does the same for the
SDK itself: <!-- n:sdk_mutations -->45<!-- /n --> mutations, all killed, ~20 s.

**`npm run judge-check` does not run the SDK's set.** Its `test-mutations` step is the A/B harness's own
set — <!-- n:ab_mutations -->27<!-- /n --> mutations in `examples/ethonline-2026-ab/test-mutations.mjs`
(`scripts/judge-check.sh` runs `node test-mutations.mjs` in that directory). Run the SDK's set
separately: `cd packages/sdk && node test-mutations.mjs`.

### Your own policy on `/decision` — the server answers in the SDK's words

The first real A/B (`docs/ethonline-2026/WINDOW_PLAN.md` §16.3 — Japanese, internal plan; 2026-09-07) found a hole that was ours,
not the model's: for the over-ceiling fixture the right reason, `price_above_ceiling`, **was a word no
tool ever returned** — it lived only in the SDK's caller-side policy. A Recipe cannot make a model say a
word the tool does not give it. So since 2026-09-07 `GET /api/v1/resources/{id}/decision` takes the
caller's policy as query parameters and returns the verdict **in the same document, in the SDK's words**:

| query | meaning |
|---|---|
| `amount_usd` | what the 402 asks (compared with the ceiling) |
| `max_per_tx_usd` | your per-payment ceiling, default `1` (= the SDK's `DEFAULT_MAX_PER_TX_USD`) |
| `min_l1_deliveries` | floor on `facts.l1.n_delivered` — our own delivered L1 purchases |
| `require_vet402_allow` | default `true` (= the SDK's `requireVet402Allow`): a WARN refuses with `payee_recommendation_not_allow`; `false` waives the WARN and needs `min_l1_deliveries` ≥ 1, else `400 invalid_policy` |

The response gains one block and changes nothing else (without these queries the body is byte-identical):

```json
"caller_policy": {
  "applied": { "amount_usd": 1.5, "max_per_tx_usd": 1, "min_l1_deliveries": 0, "require_vet402_allow": true },
  "verdict": "REFUSE",
  "reason_codes": ["price_above_ceiling"],
  "not_evaluated": ["min_subgraph_receipts"]
}
```

- Order and words are the SDK's: `price_above_ceiling` → `evidence_unavailable` (degraded) →
  `payee_recommendation_block` → `payee_recommendation_not_allow` (unless `require_vet402_allow=false`) →
  `insufficient_delivery_evidence`. No new vocabulary.
- The default is the SDK's default: a raw-HTTP caller reading only `caller_policy` gets the same
  answer `payOrRefuse` would give (WARN → REFUSE). `require_vet402_allow=false` is the same waiver as
  `requireVet402Allow: false` and carries the same obligation — a floor in its place (§3.2).
- `recommendation` is **never rewritten**. A waived WARN stays a WARN beside a `caller_policy` ALLOW; you
  read both. A floor or a waiver never lifts BLOCK or degraded (§3.2.1).
- `not_evaluated` says what the server did **not** check. `min_subgraph_receipts` is always there: The
  Graph is read only with *your* Gateway key, by `payOrRefuse` / `pay_if_trusted`, never by us.
- A bad value is `400` with the SDK's own caller-error word (`invalid_amount_usd`, `invalid_policy`,
  `invalid_evidence_policy`). An uncatalogued resource stays `404` — the SDK judges those from the 402's
  `payTo` and the payee score (I23).
- The SDK and `pay_if_trusted` send these queries themselves and keep their local gates (two layers).
  When the two disagree, the local gate decides `status` and **both** words are kept on
  `decision_record.reason_codes` — no `policy_disagreement` word is invented.

Two `curl`s tell the whole story (run them against production; the first was measured there on 2026-09-07):

```bash
# live: expect .[0] == "ALLOW" and .[1].verdict == "REFUSE" and .[1].reason_codes == ["price_above_ceiling"] and .[2] == false
RID=$(curl -sL "https://vet402.com/api/v1/resolve?q=https://kronossignals.com/api/v1/price/btc" | jq -r '.resource.resource_id')
# over your ceiling → caller_policy.verdict REFUSE, reason_codes ["price_above_ceiling"]
curl -sL "https://vet402.com/api/v1/resources/$RID/decision?role=payer&amount_usd=1.5&max_per_tx_usd=1" | jq '.recommendation, .caller_policy'
# no policy query → the body of 2026-09-02, unchanged (no caller_policy key)
curl -sL "https://vet402.com/api/v1/resources/$RID/decision?role=payer" | jq 'has("caller_policy")'
```

Production answered the first `curl` on 2026-09-07 (HTTP 200, `jq '{recommendation, caller_policy}'`):

```json
{
  "recommendation": "ALLOW",
  "caller_policy": {
    "applied": {
      "amount_usd": 1.5,
      "max_per_tx_usd": 1,
      "min_l1_deliveries": 0,
      "require_vet402_allow": true
    },
    "verdict": "REFUSE",
    "reason_codes": [
      "price_above_ceiling"
    ],
    "not_evaluated": [
      "min_subgraph_receipts"
    ]
  }
}
```

The same block comes through `check_resource_decision` (`amountUsd` / `maxPerTxUsd` / `minL1Deliveries` /
`requireVet402Allow` are tool inputs now). Run on 2026-09-07 over stdio against the real route handler with the catalogue
stubbed (`tests/decision-caller-policy.test.ts` uses the same stub; the production body above is what the tool
reads on the live path):

```json
{
  "decision": "REFUSE",
  "safe_to_pay": false,
  "refuse_reasons": ["l0_pass", "l1_delivered", "l2_undeclared", "price_above_ceiling"],
  "summary": "ALLOW (2026-09-02.1) — l0_pass, l1_delivered, l2_undeclared · caller_policy REFUSE (price_above_ceiling)",
  "measurement": { "recommendation": "ALLOW", "caller_policy": { "applied": { "amount_usd": 1.5, "max_per_tx_usd": 1, "min_l1_deliveries": 0, "require_vet402_allow": true }, "verdict": "REFUSE", "reason_codes": ["price_above_ceiling"], "not_evaluated": ["min_subgraph_receipts"] } }
}
```

`judge` and `pay` apply the same gates locally *before* asking the server (the SDK's ceiling check runs
before `/decision` is fetched), so in their output the server's word shows up only where the two layers
disagree; the `decision_record.decision.caller_policy` they store carries it verbatim either way.

## `pay_if_trusted` with The Graph evidence

Since 2026-09-06 the MCP tool takes the same `policy` the SDK does, and forwards it to `payOrRefuse`
**unchanged** — the tool is a thin bridge, it does not re-implement the judgement:

| input | meaning |
|---|---|
| `policy.requireVet402Allow` | default `true`. `false` waives a vet402 **WARN** when every declared floor is met. **BLOCK and `degraded` still refuse** (WINDOW_PLAN §3.2.1 — Japanese, internal plan) — the boundary lives in the SDK and the MCP tests pin it through the bridge. Both paths (`/decision` and the uncatalogued payee score) read the verdict word and the quality flags through one shared rule in `packages/sdk/src/verdict-shape.ts`, so the boundary does not depend on how the server serialised them: `" BLOCK "` is a BLOCK, and a `degraded` that is not a boolean is not a measurement. Needs at least one floor above 0, otherwise the call is a caller error (`invalid_policy`) before any network. |
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
# live: needs VOUCH_API_KEY,GRAPH_API_KEY,THROWAWAY_KEY expect .[0].result.content[0].text | fromjson | .decision == "REFUSE" and .signed == false and .nonce == null and ((.refuse_reasons | index("insufficient_subgraph_evidence")) != null) and ((.decision_record.evidence | map(.source) | index("subgraph")) != null)
cd packages/mcp-server && printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"judge","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"pay_if_trusted","arguments":{"resourceId":"ae0091e802c83179e3b1464a7b15dac64a0c1d3a00cb690eb6a5ac9811c47e3b","resource":"https://kronossignals.com/api/v1/price/btc","payee":"0x36038e1d712c5e39f35952164ec58ec2b96caee7","amountUsd":0.02,"policy":{"evidence":{"source":"subgraph","minSubgraphReceipts":1000000000}}}}}' \
 | VOUCH_API_KEY=$VOUCH_API_KEY GRAPH_API_KEY=$GRAPH_API_KEY VOUCH_PAYER_PRIVATE_KEY=$THROWAWAY_KEY \
   node dist/index.js | tail -1
```

**Each JSON-RPC message is one line, and there is no `2>/dev/null`.** stdio MCP reads one message
per line: a request folded over several lines is dropped without a word, and you would get only the
`initialize` reply back. Nothing is written to stderr on a healthy run, so anything you see there is
real — a stack trace here means the build step above did not finish.

That `resourceId` is a catalogued seller our engine rates **ALLOW**. The floor of 10⁹ receipts is
deliberately unmeetable, so the run reads the **live Gateway** and stops before a signature — a way
to show the evidence row without moving money.

**This block needs a payer key** (`THROWAWAY_KEY`), even though it never signs. The server does not
forward `resource` / `payee` / `amountUsd` to the SDK unless a payer is configured
(`packages/mcp-server/src/index.ts`), so with no payer the call stops one step earlier, at
`payer_not_configured`, and never reads The Graph. Measured on 2026-09-08 with
`VOUCH_API_KEY` + `GRAPH_API_KEY` set and **no** payer key — the same block, verbatim:

```json
{
  "decision": "REFUSE",
  "safe_to_pay": false,
  "refuse_reasons": ["l0_pass", "l1_delivered", "l2_undeclared", "payer_not_configured"],
  "summary": "This server has no payer: set VOUCH_PAYER_PRIVATE_KEY in its env block and install viem in the server package to enable payment. The decision above was still measured.",
  "signed": false, "attested": false, "txHash": null, "nonce": null, "settlement": null,
  "measurement": { "recommendation": "ALLOW", "reason_codes": ["l0_pass","l1_delivered","l2_undeclared"],
                   "facts": { "…": "verbatim /decision facts" }, "rules_version": "2026-09-08.1", "degraded": false },
  "decision_record": null
}
```

The measurement is still made and still returned; only the payment path is closed. With a payer
configured, run on 2026-09-06 13:18 UTC (the long verbatim `/decision` bodies are folded with `…`;
every other value is as returned):

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
`resource_id` answers **404 `not_found`** (WINDOW_PLAN §3.1 — Japanese, internal plan; measured 2026-09-04). Until 2026-09-06
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
# live: needs VOUCH_API_KEY,GRAPH_API_KEY,THROWAWAY_KEY expect .[0].result.content[0].text | fromjson | .decision == "REFUSE" and .refuse_reasons == ["resource_uncatalogued","insufficient_subgraph_evidence"] and .signed == false and .nonce == null
cd packages/mcp-server && printf '%s\n%s\n%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"judge","version":"0"}}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"pay_if_trusted","arguments":{"resourceId":"9e8469d365d65bc9b4a3f588f951bfc70ae64cc1afa2ebdf7e8f11a940d40763","resource":"https://gateway.thegraph.com/api/x402/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj","payee":"0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB","amountUsd":0.01,"method":"POST","policy":{"requireVet402Allow":false,"evidence":{"source":"subgraph","minSubgraphReceipts":1000000000}}}}}' \
 | VOUCH_API_KEY=$VOUCH_API_KEY GRAPH_API_KEY=$GRAPH_API_KEY VOUCH_PAYER_PRIVATE_KEY=$THROWAWAY_KEY \
   node dist/index.js | tail -1
```

One line per JSON-RPC message, and no `2>/dev/null` — same reason as the block above. This block
needs the same payer key for the same reason: the server withholds `resource` / `payee` /
`amountUsd` from the SDK when none is configured, so The Graph is never read. Measured on
2026-09-08 with `VOUCH_API_KEY` + `GRAPH_API_KEY` and **no** payer key — the same block, verbatim:
`"refuse_reasons": ["evidence_unavailable", "payer_not_configured"]`, `"signed": false`,
`"nonce": null`, `"decision_record": null`. (`evidence_unavailable` here is the 404 from the
catalogue, which the SDK can only judge past when it is given the `resource` to read the 402 from.)

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

## Scope notes — what is in this package, and what is not

Stated plainly, because a SKILL.md that oversells is worse than none.

| | state |
|---|---|
| **Evidence policy on the MCP tool** | Since 2026-09-06: `policy.requireVet402Allow` and `policy.evidence` (`source`, `minSubgraphReceipts`, `minL1Deliveries`) are tool inputs; the Graph key comes from `GRAPH_API_KEY`. See **`pay_if_trusted` with The Graph evidence**. |
| **The uncatalogued-seller path in MCP** | Since 2026-09-06: when `resource` is given, a `/decision` 404 is handed to `payOrRefuse`, which judges from the 402 `payTo`, the payee score for that address and the caller's evidence floors (I23). Without `resource` a 404 still refuses with `evidence_unavailable`. See **Paying a seller outside the catalogue — live**. |
| **npm publish** | Out of scope until after submission. Build from the repo. |
| **The hosted MCP gateway** | Two MCP surfaces, two roles. The Bazantic gateway (`https://2vjhqfgvw5dt5lja2zpjsjwrem.bazgateway.com/mcp`, Recipe `x402-payee-verification-via-vet402-gateway`) fronts vet402's REST API as **57 tools** (`tools/list`, measured 2026-09-06) — use it for discovery and every key-free read (`/decision`, `/resolve`, scores). `pay_if_trusted` is the one tool that holds a signer, and it is **only** in this package over stdio, not on the gateway. |
