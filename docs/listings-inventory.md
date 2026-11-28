# Personal-account listing inventory (I5 / D5)

`retrievedAt`: 2026-11-28T07:30:00+09:00 (JST)  
Sources: unauthenticated `https://api.github.com`, `https://registry.npmjs.org`, `https://pypi.org/pypi/{name}/json`, `https://registry.modelcontextprotocol.io/v0/servers?search=vet402` (no `gh` CLI, no tokens).

## Summary

| Area | Still on personal accounts | Already on `vet402` org |
| --- | --- | --- |
| GitHub (vet402 product) | 9 named repos under `kzmttkc` (see below); registry still cites old URLs for some MCP rows | `vet402/vet402` monorepo + 6 sibling repos |
| npm `@vet402/*` | Metadata still points at `github.com/kzmttkc/vet402` for sdk / middleware / mcp-server | Package scope is org-neutral; republish after repo URL change |
| npm `vet402` | Publisher `vouchscore`, repo `kzmttkc/vet402` | - |
| PyPI `vet402-sdk` | **could not read** (HTTP 404 on `pypi.org/pypi/vet402-sdk/json`) | - |
| MCP Registry `com.vet402` | `repository.url` = `https://github.com/kzmttkc/vet402-plugin` on published rows | Draft in repo uses `vet402/vet402` |

## GitHub: `kzmttkc` (public list API, 26 repos)

Vet402- or x402-related (non-fork product repos):

| Repository | Fork | Archived | Last push (UTC date) |
| --- | --- | --- | --- |
| kzmttkc/vet402-algorand | no | no | 2026-11-27 |
| kzmttkc/vet402-briefs | no | no | 2026-10-07 |
| kzmttkc/vet402-concordium | no | no | 2026-11-25 |
| kzmttkc/vet402-concordium-agent | no | no | 2026-11-19 |
| kzmttkc/vet402-near-thesis | no | no | 2026-11-27 |
| kzmttkc/vet402-observatory-data | no | no | 2026-11-24 |
| kzmttkc/vet402-paypal | no | no | 2026-11-11 |
| kzmttkc/vetgate-celo | no | no | 2026-11-27 |
| kzmttkc/reactive-delivery-court | no | no | 2026-11-24 |

`kzmttkc/vet402-plugin` does **not** appear in the user repo list (26 items, single page), but `GET /repos/kzmttkc/vet402-plugin` resolves to **`vet402/vet402-plugin`** (same `id` `1436955028`, `fork: false`). Treat as **org transfer**, not a fork pair.

Forks of community lists (not product code): `kzmttkc/awesome-x402`, `kzmttkc/x402`, and other `awesome-*` forks - listed in API; migrate only if still needed.

Full enum: see API `https://api.github.com/users/kzmttkc/repos?per_page=100` at `retrievedAt`.

## GitHub: `TakeshiTGAL` (44 public repos)

No repository name matched `vet402` or `vouch` in the public list at `retrievedAt`. Hermes plugins and other personal projects remain under this account by design unless D5 scope expands.

## GitHub: `vet402` org (7 repos)

- vet402/vet402
- vet402/vet402-agent-template
- vet402/vet402-copy-guard
- vet402/vet402-delivery
- vet402/vet402-hermes
- vet402/vet402-mumbai
- vet402/vet402-plugin

## npm (registry.npmjs.org)

| Package | Latest (search) | `_npmUser` | `repository.url` in metadata |
| --- | --- | --- | --- |
| @vet402/sdk | 0.10.4 | vouchscore | git+https://github.com/kzmttkc/vet402.git |
| @vet402/middleware | 0.5.1 | vouchscore | git+https://github.com/kzmttkc/vet402.git |
| @vet402/mcp-server | 0.3.3 | vouchscore | git+https://github.com/kzmttkc/vet402.git |
| @vet402/check | 0.2.0 | *(not re-read on this run)* | git+https://github.com/kzmttkc/vet402-delivery.git |
| vet402 | 0.1.6 | *(search only)* | git+https://github.com/kzmttkc/vet402.git |

`@vet402/vet402` - **could not read** (404 on `/-/v1/search` and no `latest` document in this pass).

## PyPI

- `vet402-sdk` (`packages/python-sdk/pyproject.toml` name) - **could not read** (`pypi.org/pypi/vet402-sdk/json` → 404).
- `vet402` - **could not read** (404).

Whether the package was never published or renamed is **unconfirmed** without owner PyPI login.

## MCP Registry (`com.vet402`)

| Registry name | Status | `repository.url` | Notes |
| --- | --- | --- | --- |
| com.vet402/vet402 | active (latest 1.0.2) | https://github.com/kzmttkc/vet402-plugin | Hosted remote `https://vet402.com/mcp` |
| io.github.kzmttkc/vet402-check | active (0.2.0) | https://github.com/kzmttkc/vet402-delivery | stdio npm `@vet402/check` |

`vet402/vet402-delivery` exists on the org; registry row still points at `kzmttkc/vet402-delivery`.

## kzmttkc/vet402-plugin vs vet402/vet402-plugin

| Check | Result |
| --- | --- |
| `GET /repos/kzmttkc/vet402-plugin` | Returns `full_name: vet402/vet402-plugin`, `id: 1436955028` |
| `GET /repos/vet402/vet402-plugin` | Same `id` |
| `fork` / `parent` | `false` / `null` on both handles |
| Conclusion | Same repository after transfer; **not** a fork relationship |

## Migration runbook (owner: manual)

The generator and CI use no personal credentials. Run in this order after reviewing each asset above.

### GitHub

1. For each remaining `kzmttkc/*` product repo listed in **Summary**, either transfer to `vet402` or archive with reason in this file.
2. Update default branch protection and Vercel/Cursor deploy hooks to `vet402/*` only.
3. Confirm `https://github.com/kzmttkc/vet402-plugin` redirects to `vet402/vet402-plugin` in the browser (already true in API at `retrievedAt`).

### npm

1. Log in as the publishing user (`vouchscore` / owner account - **unconfirmed** which login owns the org).
2. For each `@vet402/*` package, publish a patch release whose `repository.url` is `git+https://github.com/vet402/vet402.git` (and `directory` when applicable). npm cannot rewrite old tarball metadata retroactively.
3. Deprecate or redirect the unscoped `vet402` package if it duplicates `@vet402/sdk`.

### PyPI

1. If `vet402-sdk` should exist, publish from `packages/python-sdk` after fixing `Homepage` / project URLs to `vet402` org; if intentionally private, note **the reason it stays** here.

### MCP Registry

1. Sign in at the official MCP Registry publisher UI (ed25519 key in `public/.well-known/mcp-registry-auth`).
2. Publish an update to `com.vet402/vet402` with `repository.url` = `https://github.com/vet402/vet402`, `directory` = `packages/mcp-server` (match `data/listings/mcp/server.json`).
3. For `io.github.kzmttkc/vet402-check`, either repoint to `vet402/vet402-delivery` or deprecate if superseded by hosted MCP.

### pay.sh / x402.org / Bazaar

1. Regenerate drafts: `npm run listings:generate`.
2. Owner opens draft PRs (C4) using files under `data/listings/` - see `docs/listings-sync.md`.
3. Bazaar indexing follows live x402 settlement; no separate registry login.

### Completion criteria (D5 / I5)

- This table shows **0** personal-account rows without a documented exception and expiry date.
- `npm run listings:check` reports `total_drift_lines=0`.
- MCP registry `repository` fields match org URLs.
