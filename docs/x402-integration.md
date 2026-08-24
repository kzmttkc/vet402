# x402 Integration Guide

How x402 API providers use Vouch to verify agents **before** accepting payment.

> Examples below use the current production URL `https://agent-trust-tawny.vercel.app/api/v1`.
> A custom domain (e.g. `api.vouch.dev`) is not yet registered — once it is, replace this base
> URL throughout this file (and set `VOUCH_API_URL` accordingly).

## Problem

x402 tells you *who paid*, but not whether that wallet is trustworthy. ERC-8004 reputation alone is sybil-vulnerable. Vouch adds wallet history, sybil detection, and customer WL/BL on top.

## Recommended flow

```
1. Agent requests paid endpoint
2. x402 middleware returns 402 (payment required)
3. Agent pays via x402
4. x402 verifies payment → sets payer wallet
5. Vouch checks GET /v1/wallets/{payer}/score
6. BLOCK → reject before handler (403)
7. WARN  → allow with rate limits / extra scrutiny
8. ALLOW → serve response
```

## Minimal integration (curl)

```bash
# After x402 payment, you know the payer wallet
PAYER=0x1234567890123456789012345678901234567890

curl -s -H "Authorization: Bearer $VOUCH_API_KEY" \
  "https://agent-trust-tawny.vercel.app/api/v1/wallets/${PAYER}/score" | jq .
```

Response:

```json
{
  "agentId": "42",
  "wallet": "0x1234...",
  "trustScore": 78,
  "recommendation": "ALLOW",
  "signals": { ... }
}
```

Decision logic:

| `recommendation` | Action |
|---|---|
| `ALLOW` | Serve API response |
| `WARN` | Serve with stricter rate limit or logging |
| `BLOCK` | Return 403 before spending compute |

## Express middleware sample

See [`examples/x402-trust-gate`](../examples/x402-trust-gate/) for a runnable demo.
TypeScript clients can use [`@vet402/sdk`](../packages/sdk/) (`getWalletScore` + `attestX402Payment`).

```typescript
import { createVouchTrustGate, demoWalletFromHeader } from "./middleware";

// Mount AFTER @x402/express paymentMiddleware
app.use("/api/premium", createVouchTrustGate({
  apiUrl: process.env.VOUCH_API_URL!,
  apiKey: process.env.VOUCH_API_KEY!,
  rejectOn: ["BLOCK"],
  getWallet: (req) => req.payerWallet ?? demoWalletFromHeader(req),
}));
```

### Dual auth (API key OR x402)

If some clients pay via x402 and others use API keys, route before x402:

```typescript
app.use((req, res, next) => {
  if (req.headers.authorization?.startsWith("Bearer ")) {
    return next(); // skip x402 for API key clients
  }
  return x402Middleware(req, res, () => {
    req.paidViaX402 = true;
    next();
  });
});
```

## Wallet verification with agent ID

When the agent sends both agent ID and wallet (recommended):

```bash
curl -H "Authorization: Bearer $VOUCH_API_KEY" \
  "https://agent-trust-tawny.vercel.app/api/v1/agents/42/score?wallet=0x..."
```

This verifies the wallet matches the agent's on-chain `agentWallet` metadata.

## Customer whitelist

Register your own agents to avoid false BLOCKs:

1. Dashboard → **Lists** → add wallet to Allow
2. Or API: customer-scoped lists apply per API key

Whitelisted wallets get score floor 80; WARN can be promoted to ALLOW.

## Batch pre-check

Before a batch job touches many agents:

```bash
curl -X POST -H "Authorization: Bearer $VOUCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"agents":[{"agentId":"1"},{"agentId":"2","wallet":"0x..."}]}' \
  https://agent-trust-tawny.vercel.app/api/v1/scores/batch
```

## Rate limits

Vouch API has monthly plan limits. Cache scores for 5 minutes (built into API). For high-volume x402 gateways, consider:

- Cache ALLOW results briefly in Redis
- Only re-check WARN/BLOCK wallets more frequently

## MCP alternative

Agents can self-check trust via MCP before paying:

```
check_wallet_trust(wallet="0x...")
```

See [MCP setup](./mcp-setup.md).

## Next steps (Phase 2+)

- On-chain safety gateway with the same agent ID space
- Raise `SCORE_WEIGHTS.x402` toward 15–20% once settlement volume is meaningful

## Settlement write-back (Phase 1.5 — live)

After x402 verifies payment, POST an attestation so settlement history weights into the score (10% today):

```bash
curl -X POST https://agent-trust-tawny.vercel.app/api/v1/payments/x402 \
  -H "Authorization: Bearer $VOUCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "wallet": "0xpayer...",
    "txHash": "0xabc...",
    "amount": "1000000",
    "network": "base",
    "resource": "/api/premium/data"
  }'
```

Idempotent on `txHash`. The sample middleware supports optional `getPaymentTxHash` for fire-and-forget attestation after ALLOW/WARN.