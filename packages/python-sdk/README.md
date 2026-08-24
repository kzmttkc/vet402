# vet402-sdk (Python)

Python client for the [vet402](https://vet402.com) Trust API — check a payee
before your agent pays, and never pay without an explicit `ALLOW`.

Python 3.10+, single runtime dependency (`httpx`). Semantics mirror the
TypeScript SDK ([`@vet402/sdk`](https://www.npmjs.com/package/@vet402/sdk)
0.2.x): fail-closed SpendGuard by default, identical machine-readable reason
codes, identical error contract.

> **Not yet published to PyPI.** Until then, install from a local checkout:
>
> ```bash
> pip install -e path/to/agent-trust/packages/python-sdk
> ```

## Quickstart

Get a key at [vet402.com/dashboard/keys](https://vet402.com/dashboard/keys),
export it as `VOUCH_API_KEY`, and this runs as-is:

```python
import os
from vet402 import create_vouch_client

# api_url defaults to https://vet402.com/api/v1 — pass it only to point at
# another deployment (a local dev server, say).
vouch = create_vouch_client(os.environ["VOUCH_API_KEY"])

# Seller side: "should I accept payment from this wallet?"
score = vouch.get_wallet_score("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")
print(score["trustScore"], score["recommendation"])  # e.g. 72 'ALLOW'

# Buyer side: "should my agent pay this wallet?"
payee = vouch.get_payee_score("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045")
print(payee["score"], payee["recommendation"], payee["dataDepth"])
```

Methods: `get_agent_score`, `get_wallet_score`, `get_payee_score`,
`batch_score`, `attest_x402_payment`, `create_spend_guard`.

## Errors

A non-2xx answer raises `VouchApiError` carrying the API's machine-readable
code and the HTTP status, so you can tell *your key is wrong* from *we are
having a bad day* without parsing strings:

```python
from vet402 import VouchApiError

try:
    vouch.get_payee_score("0x...")
except VouchApiError as err:
    if err.status == 401:
        # err.code == "missing_api_key" | "invalid_api_key" — fix the key.
        ...
```

## SpendGuard — pre-payment policy for agents

Before your agent *pays* someone, ask the guard. It returns an allow/deny
decision plus machine-readable reasons — and nothing else. SpendGuard is
strictly non-custodial: it never touches keys, funds, signing, or transaction
submission. Execution stays with your wallet stack.

**Fail-closed by default.** Money moves only on a clean `ALLOW` verdict unless
you explicitly opt out. With no `trust_policy` set, every `evaluate()` performs
the payee trust lookup and **denies** when:

| Condition | Reason code |
|---|---|
| Recommendation is `WARN` or `BLOCK` | `payee_recommendation_not_allow` |
| The score came from a degraded read | `payee_score_degraded` |
| Partial measurement (`signalsUnavailable` non-empty) | `payee_partial_measurement` |
| The score is older than 5 min or past its own expiry | `payee_score_stale` |
| The lookup was refused for your key (401/403) | `payee_trust_unauthenticated` |
| The lookup failed on our side (5xx, timeout, rate limit) | `payee_trust_unavailable` |

Opt-outs: `trust_policy="block-only"` (WARN passes; BLOCK, degraded, stale and
failed lookups still deny) or `trust_policy="custom"` (only the rules you set
apply, and the lookup only runs when `min_payee_score` /
`block_on_recommendation` is set).

```python
guard = vouch.create_spend_guard(
    max_per_tx_usd=10,      # deny any single payment above $10
    daily_budget_usd=50,    # deny once today's allowed total would pass $50
    # trust_policy="allow-only" is the default: deny anything but a clean ALLOW
    min_payee_score=40,     # optional stricter floor on top of the policy
)

decision = guard.evaluate("0x...", 5)
if decision.allow:
    ...  # hand off to your wallet stack / signer
else:
    print(decision.reasons)  # e.g. ["payee_recommendation_not_allow"]
```

How it works:

- The local rules (`max_per_tx_usd`, `daily_budget_usd`) are optional — set
  only the ones you want. Under the default `trust_policy="allow-only"` the
  payee trust lookup (`GET /api/v1/payees/{address}/score`) always runs, but
  is skipped when a local rule already denied, so no quota is burned on a dead
  payment.
- Everything the guard cannot vet **fails closed** (reason codes in the table
  above). A failed lookup names *whose* problem it is:
  `payee_trust_unauthenticated` means the API key is missing or invalid and
  retrying will not help; `payee_trust_unavailable` means the upstream is
  unhappy and retrying might.
- A DENY is returned as a structured `SpendDecision`, never raised — only
  invalid arguments raise.
- Budget reservation is optimistic and lock-protected: once the local rules
  pass, the amount is reserved *before* the trust lookup runs and returned
  automatically if the trust rules deny — so concurrent `evaluate` calls
  within one process cannot race past the daily budget together. If an
  allowed transfer then fails or is skipped, call `guard.release(amount_usd)`
  to give the reservation back.
- The daily budget counter lives **in this process's memory** (UTC day): it
  resets on process restart and is not shared across replicas. Treat it as a
  runaway-agent brake, not an accounting system — persist your own ledger if
  you need durable budgets.

## Using it from LangChain (Python)

Gate a payment tool with the guard so the model can decide *what* to buy but
never *whether* an unvetted payee gets paid:

```python
import os
from langchain_core.tools import tool
from vet402 import create_vouch_client

vouch = create_vouch_client(os.environ["VOUCH_API_KEY"])
guard = vouch.create_spend_guard(max_per_tx_usd=10, daily_budget_usd=50)

@tool
def pay_service(payee: str, amount_usd: float) -> str:
    """Pay an x402 service. Refuses anything but a clean ALLOW verdict."""
    decision = guard.evaluate(payee, amount_usd)
    if not decision.allow:
        return f"DENIED: {', '.join(decision.reasons)}"
    tx_hash = my_wallet.transfer(payee, amount_usd)  # your wallet stack
    # Feed the settlement back — weights future scores.
    vouch.attest_x402_payment(wallet=payee, tx_hash=tx_hash)
    return f"paid {amount_usd} USD to {payee}: {tx_hash}"
```

The guard's answer is authoritative inside the tool: a prompt-injected model
cannot talk its way past it, because the DENY branch never reaches the wallet
call.

## Testing your integration

`VouchClient` accepts an injected `httpx` transport, so you can run the whole
guard offline:

```python
import httpx
from vet402 import VouchClient

def handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={...})  # a canned payee score

vouch = VouchClient("vk_test", transport=httpx.MockTransport(handler))
```

## Links

- [API key](https://vet402.com/dashboard/keys) — `VOUCH_API_KEY`
- [API docs](https://vet402.com/docs/api) · [OpenAPI spec](https://github.com/kzmttkc/vet402/blob/main/docs/openapi.yaml)
- [`@vet402/sdk`](https://www.npmjs.com/package/@vet402/sdk) — TypeScript twin of this package
- [`@vet402/middleware`](https://www.npmjs.com/package/@vet402/middleware) — seller side (x402 request gate)
- [`@vet402/mcp-server`](https://www.npmjs.com/package/@vet402/mcp-server) — MCP tool

MIT · [vet402](https://vet402.com)
