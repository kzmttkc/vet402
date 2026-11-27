# Listing draft sync (I5)

## Source of truth

`docs/openapi.yaml` is edited in the repository. The generator parses it to the same JSON shape as `https://vet402.com/openapi.json` and writes:

| Output | Path |
| --- | --- |
| OpenAPI snapshot | `data/listings/openapi.json` |
| pay.sh `PAY.md` | `data/listings/pay-sh/PAY.md` |
| pay.sh sidecar OpenAPI | `data/listings/pay-sh/openapi.json` |
| MCP registry draft | `data/listings/mcp/server.json` |
| CDP Bazaar declaration | `data/listings/bazaar/declarations.json` |
| x402.org ecosystem draft | `data/listings/x402-ecosystem/metadata.json` |

Listing-specific fields live under `info.x-vet402-listings` in `docs/openapi.yaml`. Change prices, copy, or targets there, then run `npm run listings:generate`.

## Commands

```bash
npm run listings:generate      # rewrite data/listings/*
npm run listings:check         # compare on-disk drafts; exit 1 when drift > 0
npm run listings:check -- --observe   # print drift counts only; exit 0
```

CI runs `npm run listings:check -- --observe` on every push (observe phase). When drift stays at zero for a release window, flip the job to fail on drift by dropping `--observe`.

## Drift reporting

`--check` prints one line per destination:

```text
pay.sh PAY.md: drift_lines=0 path=data/listings/pay-sh/PAY.md
...
listings: total_drift_lines=0
```

## Planned: external PR drafts (not implemented)

External listings still need owner approval (C4). Automate preparation only inside this repo.

### Job outline (future)

1. **Trigger:** `workflow_dispatch` or weekly schedule; never on every commit.
2. **Steps:**
   - `npm ci`
   - `npm run listings:check` (fail when drift > 0 unless explicitly refreshing)
   - `npm run listings:generate`
   - For each destination, open a **draft** PR in the target repo using a machine account token stored in GitHub Actions secrets (pay-skills fork, MCP registry publish API, x402-foundation ecosystem repo).
3. **Guards:**
   - PRs stay **draft** until a human reviewer marks ready.
   - No publish, merge, or registry write in CI—only branch + PR creation.
   - Secrets: `PAYSH_PR_TOKEN`, `MCP_REGISTRY_TOKEN`, `X402_ECOSYSTEM_PR_TOKEN` (names TBD at implementation).
4. **Artifacts:** attach `data/listings/*` and the drift summary as workflow artifacts for audit.

### Repositories (targets)

| Destination | Upstream | Notes |
| --- | --- | --- |
| pay.sh | `solana-foundation/pay-skills` | `providers/vet402/rwa-facts/` |
| MCP registry | MCP Registry API | `com.vet402/vet402` — `repository.url` must be `vet402/vet402` |
| x402.org | `x402-foundation/x402` (site tree) | `partners-data/vet402/metadata.json` |
| Bazaar | n/a | declaration shipped on the live 402; this repo only validates JSON |

Implementation waits for I1 endpoint approval and uptime evidence for ecosystem submission.