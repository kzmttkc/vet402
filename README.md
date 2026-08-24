# vet402

**Independent Verification of the x402 Agent-Payment Economy**

*We buy. We settle. We publish the measurements.*

vet402 buys what x402 endpoints actually sell, verifies fulfillment against the seller's own declaration, and publishes the results with evidence.

> **Formerly Vouch.** The repository name (`agent-trust`), npm scope (`@vet402/*`) and API key prefix (`vouch_`) retain the old name for backward compatibility.

**Site:** <https://vet402.com> · **Live demo:** <https://vet402.com/playground> · **API reference:** <https://vet402.com/docs/api> · **Accuracy ledger:** <https://vet402.com/accuracy>

> 日本語の概観は [docs/ja/README.md](./docs/ja/README.md)。

This repository is the source of the vet402 service and of the three npm packages published from `packages/`.

## Install

```bash
npm i @vet402/sdk          # TypeScript API client
npm i @vet402/middleware   # x402 transaction gate (Express / Next.js / Hono)
npm i @vet402/mcp-server   # MCP tools for Cursor / Claude Desktop
```

> **Use the scoped names exactly as written above.** The unscoped npm package `vouch-sdk` is an unrelated project published by a different vendor and has nothing to do with vet402. Only `@vet402/*` packages are ours.

- [@vet402/sdk](https://www.npmjs.com/package/@vet402/sdk)
- [@vet402/middleware](https://www.npmjs.com/package/@vet402/middleware)
- [@vet402/mcp-server](https://www.npmjs.com/package/@vet402/mcp-server)

```typescript
import { createVouchClient } from "@vet402/sdk";
```

Get a free API key at <https://vet402.com/signup> (1,000 lookups/month, no card required).

## Verification levels

A result never moves up a level: an L0 probe cannot report settlement, and an L3 opinion is never folded into an L0–L2 fact.

| Level | Question | How | Output |
|---|---|---|---|
| L0 | Liveness — does the endpoint answer correctly? | Probe, no purchase | pass / fail / unverified |
| L1 | Settle-through — does payment settle and a response arrive? | Real purchase | n of m settled, latency |
| L2 | Conformance — does the response match the seller's own declaration? | Purchase + machine diff | conform / mismatch / undeclared |
| L3 | Quality — is the content any good? | Published rubric | opinion — never mixed with L0–L2 |

The 0–100 trust score this API returns today (banded `ALLOW` / `WARN` / `BLOCK`) predates these levels. It stays available to API and SDK callers during the transition, and is never reported as an L0–L2 result. Methodology: <https://vet402.com/#methodology>.

## Docs

Start here, in this order:

- [PRODUCT.md](./PRODUCT.md) — two products, verb glossary, plans
- [DESIGN.md](./DESIGN.md) — public RFC paper vs dashboard operate app
- [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) — system map: data flow, money safety, module boundaries ([日本語](./docs/ja/ARCHITECTURE.md))
- [CONTRIBUTING.md](./CONTRIBUTING.md) — full-stack setup (Docker or local), PR checklist, first issues
- [docs/README.md](./docs/README.md) — which remaining file to open (do not load the rest by default)

Grant / hackathon reviewers: [docs/applications/](./docs/applications/) has the one-page impact summary and per-ecosystem materials.

Customer-facing: [Quickstart](./docs/quickstart.md) · [OpenAPI](./docs/openapi.yaml) · [Deployment](./docs/deployment.md)


# Self-hosting and development

The rest of this file covers running the service yourself. Using vet402 as a customer needs none of it — see [Install](#install) above.

## Stack

- Next.js 16 (App Router) + TypeScript
- viem (Base mainnet)
- Drizzle ORM + PostgreSQL (Neon)
- ERC-8004 Identity & Reputation Registry

## Quick start

```bash
cp .env.example .env.local
# Set DATABASE_URL, secrets, DEV_API_KEY, BASE_RPC_URL

npm install
./scripts/dev-setup.sh   # local Postgres + db:push (Docker or Homebrew)
npm run dev
```

### Health check

```bash
curl http://localhost:3000/api/health
```

### Score an agent (dev)

```bash
curl -H "Authorization: Bearer $DEV_API_KEY" \
  http://localhost:3000/api/v1/agents/1/score
```

### Score by wallet (x402 integration path)

```bash
curl -H "Authorization: Bearer $DEV_API_KEY" \
  http://localhost:3000/api/v1/wallets/0x1234567890123456789012345678901234567890/score
```

### Attest settlement

```bash
curl -X POST -H "Authorization: Bearer $DEV_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"wallet":"0x...","txHash":"0x..."}' \
  http://localhost:3000/api/v1/payments/x402
```

## Database setup (M2)

```bash
# Set DATABASE_URL in .env.local, then push schema
npm run db:push

# Create a production API key
npm run api-key:create -- --plan free --name "my app"
```

**Production:** set `APP_ENV=production` explicitly (do not rely on `NODE_ENV` alone).

**Production required env vars:** `DATABASE_URL`, `API_KEY_PEPPER`, `DASHBOARD_SESSION_SECRET`, `ADMIN_SECRET` (min 32 chars, no placeholders).  
Set `PROXY_HEADER_SOURCE` to name the proxy in front of the app (`vercel` | `generic` | `none`); per-IP rate limits depend on it, and the default `none` believes no forwarded header.  
**Never set in production:** `DEV_API_KEY`, `SKIP_CHAIN_READS`.

Deep health check: `GET /api/health?deep=1` with `Authorization: Bearer $ADMIN_SECRET` (development allows unauthenticated deep checks).

Dashboard uses **httpOnly session cookies only** (Bearer API keys are not accepted on dashboard routes).

Whitelist override: responses include `manualOverride: true` when **customer** WL/BL changed the outcome. Global operator blacklist is applied opaquely (`blockReason: operator_policy`, `signals.manual.list: none`). WL is **not applied** when sybil risk is `high`.

Customer WL/BL lists are shared across all API keys under the same owner account.

Score cache invalidation uses DB-backed epochs (`cache_epochs` table) so list changes propagate across serverless replicas.

After enabling `API_KEY_PEPPER`, recreate API keys (hashes change).

API keys are stored as SHA-256 hashes. Monthly quotas are enforced **per owner** (all API keys under the same account share one quota). Up to **10 active API keys** per owner.

| Plan | Monthly limit |
|---|---|
| free | 1,000 |
| pro | 50,000 |
| scale | 500,000 |

Responses include `X-RateLimit-Limit`, `X-RateLimit-Used`, and `X-RateLimit-Remaining` headers.

## Dashboard (M3)

```bash
npm run dev
# Open http://localhost:3000/dashboard
# Sign in with a database-backed API key (not DEV_API_KEY)
```

Dashboard features:
- **Overview** — monthly usage and plan quota
- **Lookup** — agent / wallet score search (counts against API quota)
- **WL/BL** — customer whitelist/blacklist + CSV import (max 500 rows)
- **Logs** — recent query history
- **API Keys** — create keys (inherits current plan only) and revoke

Sign-in uses httpOnly session cookies (API key is not stored in the browser).

**Signup:** `/signup` creates a free account + API key (invite code required when `BETA_INVITE_CODE` is set).

**Billing:** Dashboard → Billing (Stripe Checkout for Pro/Scale).

## Funder indexer (F-03)

Background job populates `funder_wallets` for sybil cluster detection (read-only from scoring path):

```bash
npm run indexer:funders
# or Vercel cron: GET /api/cron/index-funders (daily 04:00 UTC)
```

## Owner agent indexer (sybil F-03)

Indexes ERC-8004 `Registered` / `Transfer` events into `owner_agents` for `multi_agent_owner` sybil checks:

```bash
npm run indexer:owners
# or Vercel cron: GET /api/cron/index-owners (daily 05:00 UTC)
```

**Partial sync is supported** — scores ship while the indexer catches up. Responses include `dataCoverage.ownerIndexer` (`synced` only at tip; otherwise `partial` + `staleRisk`). Sybil `multi_agent_owner` uses ERC-721 `balanceOf` (authoritative) cross-checked with `max(index, balanceOf)`. Full catch-up can take weeks; do not gate product launch on it.

Monitor critical outages: `GET /api/cron/monitor-health` (503 = env/DB/RPC only). Indexer lag is reported in the payload without forcing 503.

## Log retention

`trust_events` are purged by plan: **90 days** (free) / **1 year** (pro, scale). Expired dashboard sessions and stale IP rate-limit buckets are also cleaned.

```bash
npm run cron:purge-logs
# or Vercel cron: GET /api/cron/purge-logs (daily 03:00 UTC)
```

## MCP Server (M4 / M7)

```bash
cd packages/mcp-server
npm install && npm run build
```

Tools: `check_agent_trust`, `check_wallet_trust`, `explain_trust_score`, `attest_x402_payment`

See [MCP setup](./docs/mcp-setup.md) for Cursor / Claude Desktop configuration.

## TypeScript SDK (M7)

```bash
cd packages/sdk && npm install && npm run build
```

```typescript
import { createVouchClient } from "@vet402/sdk";
```

## x402 sample middleware (M4)

```bash
cd examples/x402-trust-gate
npm install
export VOUCH_API_KEY=your_key
npm run demo
```

Express middleware that blocks `BLOCK` recommendations before serving paid routes. See [x402 integration guide](./docs/x402-integration.md).

## Project structure

```
src/
  app/api/v1/          # REST API routes
  app/docs/api/        # Hosted API reference page
  lib/
    chain/             # viem client, ERC-8004 reads, wallet metrics, agent resolver
    scoring/           # Score engine, sybil detection
    db/                # Drizzle schema
    api/               # Auth, rate limits (M2)
docs/
  README.md            # which remaining file to open
  quickstart.md
  deployment.md
  openapi.yaml
packages/
  mcp-server/          # @vet402/mcp-server — MCP tools for Cursor / Claude
  sdk/                 # @vet402/sdk — thin TypeScript API client
  middleware/          # @vet402/middleware — x402 gate (Express / Next.js / Hono)
examples/
  x402-trust-gate/     # Express middleware sample
```

## Milestones

| Phase | Status | Scope |
|---|---|---|
| M0 | ✅ Done | Base RPC, ERC-8004 reads, API skeleton |
| M1 | ✅ Done | Score engine v1, sybil standard, cache |
| M2 | ✅ Done | API keys, rate limits, DB persistence |
| M3 | ✅ Done | Dashboard, WL/BL |
| M4 | ✅ Done | MCP server, x402 sample, docs |
| M5 | ✅ Done | Closed β deploy, funder indexer, signup + Stripe, log retention |
| M6 | ✅ Done | x402 payment attestations + 10% score weight |
| M7 | ✅ Done | Parallel channels: SDK, MCP attest, settlements UI, API docs |

## License

[MIT](./LICENSE) © KIZUNA Creation. The published `@vet402/*` packages carry the same license.

The **measurements** are licensed separately: [CC BY 4.0](./LICENSE-DATA) — the observatory
snapshot (`/api/v1/observatory/state`), the daily series (`/api/v1/observatory/history`) and the
L1 purchase ledger (`/api/v1/observatory/export.csv`) may be redistributed and built on,
commercially or not, provided the source is named:

> KIZUNA Creation. vet402 observatory. Dataset, retrieved YYYY-MM-DD.
> https://vet402.com/api/v1/observatory/state

The retrieval date is part of the citation — every one of these numbers moves. The JSON carries
`license` / `retrievedAt` / `cite` in the body; the CSV carries them in `x-vet402-*` and `Link`
response headers.
