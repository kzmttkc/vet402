# Quickstart

Get Vouch running locally in under 5 minutes.

## 1. Install

```bash
git clone <repo> agent-trust
cd agent-trust
cp .env.example .env.local
npm install
```

## 2. Configure `.env.local`

```bash
DEV_API_KEY=dev_local_key_change_me
BASE_RPC_URL=https://mainnet.base.org
# Optional for full features:
# DATABASE_URL=postgresql://...
```

## 3. Run

```bash
npm run dev
```

## 4. Test the API

```bash
export DEV_API_KEY=dev_local_key_change_me

# Health
curl http://localhost:3000/api/health

# Score an agent
curl -H "Authorization: Bearer $DEV_API_KEY" \
  http://localhost:3000/api/v1/agents/1/score

# Score by wallet (x402 path)
curl -H "Authorization: Bearer $DEV_API_KEY" \
  http://localhost:3000/api/v1/wallets/0x1234567890123456789012345678901234567890/score

# Score a payee (buyer-side: "should my agent pay this wallet?")
curl -H "Authorization: Bearer $DEV_API_KEY" \
  http://localhost:3000/api/v1/payees/0x1234567890123456789012345678901234567890/score

# Attest an x402 settlement (after payment verification)
curl -X POST -H "Authorization: Bearer $DEV_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"wallet":"0x1234567890123456789012345678901234567890","txHash":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}' \
  http://localhost:3000/api/v1/payments/x402

# Report what actually happened after a past score verdict (result label)
curl -X POST -H "Authorization: Bearer $DEV_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"outcomeType":"confirmed_fraud","notes":"chargeback filed by customer"}' \
  http://localhost:3000/api/v1/events/<trustEventId>/outcome
```

Responses include `signals.x402` and `dataCoverage` (indexer + settlement freshness).

## 5. Production setup (database)

```bash
# Set DATABASE_URL in .env.local, then push schema (includes cache_epochs, owner_usage, ip_rate_limits)
npm run db:push
npm run api-key:create -- --plan free --name "my app"
```

Use the printed `vouch_live_...` key instead of `DEV_API_KEY`.

For per-IP rate limits, name the proxy in front of the app: `PROXY_HEADER_SOURCE=vercel` on Vercel, `generic` behind a reverse proxy that rewrites `X-Forwarded-For`, `none` when there is no proxy. The default is `none` — nothing is believed until you say so.

## 6. Dashboard

Open http://localhost:3000/dashboard and sign in with your database API key.

## 7. MCP (Cursor)

```bash
cd packages/mcp-server && npm install && npm run build
```

Add to Cursor MCP config — see [mcp-setup.md](./mcp-setup.md).

## 8. x402 integration

See [x402-integration.md](./x402-integration.md) and `examples/x402-trust-gate/`.

## 9. TypeScript SDK

```bash
cd packages/sdk && npm install && npm run build
```

```typescript
import { createVouchClient } from "@vet402/sdk";
const vouch = createVouchClient({ apiUrl: "http://localhost:3000/api/v1", apiKey: process.env.VOUCH_API_KEY! });
await vouch.getWalletScore("0x...");
```

### SpendGuard (buyer-side spend policy)

Decision-only guard for agents that *pay*: per-tx cap + in-memory daily budget +
payee trust check in one allow/deny. Never touches keys or funds — execution
stays with your wallet stack.

**Fail-closed by default (v0.2.0, breaking):** money moves only on a clean
`ALLOW` — a WARN/BLOCK verdict, a degraded or partial measurement, or a failed
lookup all deny unless you explicitly opt out via
`trustPolicy: "block-only" | "custom"`.

```typescript
const guard = vouch.createSpendGuard({ maxPerTxUsd: 10, dailyBudgetUsd: 50, minPayeeScore: 40 });
const decision = await guard.evaluate({ payee: "0x...", amountUsd: 5 });
if (decision.allow) {
  // hand off to AgentKit / Privy / your own signer
}
```

Full semantics (budget reservations, fail-closed trust lookups): [SDK README](../packages/sdk/README.md).
See `examples/agentkit-spend-guard/` for a runnable demo.

## Score interpretation

| Score | Recommendation | Meaning |
|---|---|---|
| ≥ 70 | `ALLOW` | Proceed with API access |
| 40–69 | `WARN` | Extra scrutiny recommended |
| < 40 | `BLOCK` | Reject or require manual review |

Customer whitelist can override WARN → ALLOW. Blacklist always → BLOCK.

## Score weights

The `trustScore` is a weighted sum of chain signals, plus a manual whitelist/blacklist
policy layer applied afterward:

| Signal | Weight | Source |
|---|---|---|
| Identity | 20% | ERC-8004 Identity Registry (`signals.identity`) |
| Reputation | 30% | ERC-8004 Reputation Registry feedback (`signals.reputation`) |
| Wallet | 20% | Wallet age / tx history / burner heuristics (`signals.wallet`) |
| x402 settlements | 10% | Attested x402 payments (`signals.x402`) |
| Manual (WL/BL) | 20% | Customer whitelist/blacklist policy layer, applied post-score |

Identity, Reputation, Wallet, and x402 sum to the chain-derived score; Manual is a
policy override layer, not blended into that sum.

## Links

- [OpenAPI spec](./openapi.yaml)
- [API page](../src/app/docs/api/page.tsx) (served at `/docs/api`)
- [Requirements v0.1](./requirements-v0.1.md)
- [Brand / naming](./brand.md)
- [x402 Foundation optionality](./ecosystem-x402-foundation.md)
