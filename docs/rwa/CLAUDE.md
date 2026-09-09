# CLAUDE.md — vet402 RWA

RWA code lives only under app/rwa, app/api/v1/rwa, app/api/v1/wallets/[address]/rwa, packages/rwa, fixtures/rwa, docs/rwa.
In this repo app/ means src/app/. Do not create a top-level app/ directory.
DB is Neon + drizzle. New tables live in src/lib/db/rwa-schema.ts only. Do not edit src/lib/db/schema.ts. Do not create supabase/.

Do not import RWA into /score or x402 observatory.
Do not multiply uiMultiplier into the Chainlink price.
Do not drop other_unparsed events.
Do not use any cost method except FIFO.
Do not render ALLOW/WARN/BLOCK on public pages.
Do not emit realized_usd until fixtures/rwa/B.md exists and its test passes.
Do not infer that a wallet is an agent.
Do not merge two addresses into one PnL.

Source of truth: docs/rwa/SPEC.md (copy of artifacts/vet402-rwa-spec.md).
