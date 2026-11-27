# KPI event log schema (I0 proposal)

Proposal only. **No production migration in I0** (owner approval required). Matches Growth spec v3 §4 I0 step 2 and constraint C7 (no raw IP storage).

## Purpose

Append-only events for:

- External caller subjects (API key, wallet, keyless subject)
- Acquisition path (referer, MCP client, UA family)
- Paid conversion paths (402 overage → subscription, claim → Seller Watch)

Downstream: monthly KPI freeze (`src/lib/kpi/monthly-document.ts`), buyer data pack path counts.

## Table: `kpi_events` (proposed)

| Column | Type | Notes |
|--------|------|--------|
| `id` | `uuid` | Primary key, time-ordered v7 or DB default |
| `occurred_at` | `timestamptz` | Event time (UTC) |
| `day` | `date` | Generated or written UTC day for partitioning |
| `route` | `text` | e.g. `decision`, `check`, `mcp:check_x402_seller`, `x402:rwa_paid_base` |
| `method` | `text` | HTTP method or MCP method name |
| `outcome` | `text` | e.g. `ok`, `402`, `429`, `error` |
| `api_key_id` | `uuid` | Nullable; set when Authorization present |
| `mcp_client_name` | `text` | Nullable; from MCP initialize `clientInfo.name` |
| `user_agent_family` | `text` | Normalized label (not raw UA), same spirit as `clientUsageLabel` |
| `referer_host` | `text` | Nullable; host only, no path/query |
| `ip24_salt_hash` | `text` | Nullable; `HMAC-SHA256(UTC_day + server_secret, canonical_ipv4/24)` (same as below) — **not reversible to IP** |
| `network` | `text` | Nullable CAIP-2 when known (endpoint network) |
| `payment_wallet` | `text` | Nullable; x402 payer when settled |
| `acquisition_channel` | `text` | Nullable enum: `organic`, `referral`, `mcp`, `bazaar`, `unknown` |
| `excluded_reason` | `text` | Nullable; `ci`, `monitor`, `own_wallet`, `d6`, `bot`. Set at write time; the row is kept (C6 needs the excluded count) |
| `result` | `text` | Short machine code (mirrors HTTP/MCP result) |
| `evidence_ref` | `text` | Optional pointer: `settlement:tx`, `stripe:evt`, etc. |

### Indexes (proposed)

- `(day, route)`
- `(day, api_key_id)` where `api_key_id is not null`
- `(day, ip24_salt_hash, user_agent_family)` where keyless

### Retention

No raw IP column. Salt rotates daily (`ip24_salt` stored in KMS/env, not in table). Align with the privacy policy before the log ships.

## IP handling (C7)

- **Do not store** full IP or full /24 literal.
- Store only `ip24_salt_hash = HMAC-SHA256(UTC_day + server_secret, canonical_ipv4/24)`.
- Same subject may hash differently across days (by design for keyless subjects).

## Relationship to `client_usage_daily`

| Aspect | `client_usage_daily` | `kpi_events` (proposed) |
|--------|----------------------|-------------------------|
| Granularity | Daily counts per client label + route | One row per counted event |
| API keys | Not stored | `api_key_id` only |
| IP | Never stored | Salted /24 hash only |
| Referer | Not stored | `referer_host` |
| MCP | Client name in aggregate | `mcp_client_name` per event |
| Use | Public stats, weekly external API | KPI subjects, CAC path proof |

**Migration strategy (future, not I0 SQL):**

1. Dual-write: keep `recordClientUsage` aggregates; add async `kpi_events` insert on same hooks (`src/lib/api/client-usage.ts`, MCP handlers).
2. Backfill: **no** synthetic subjects for days before log start (spec I0 §6 step 6).
3. Cutover month: set `coverage.externalCallerSubjectSince` in first frozen KPI file.

## Writers (future)

- REST: keyed and keyless routes after successful response (200/402 as appropriate).
- MCP: after `tools/call` (not `initialize`), matching `tests/mcp.pg.test.ts` counting rules.
- x402: after verify/settle with payer wallet and `evidence_ref`.

## Exclusions

Rows are written for every call and **marked**, not dropped: `excluded_reason` (nullable text: `ci`, `monitor`, `own_wallet`, `d6`, `bot`). KPI queries filter on it, and the monthly file records the excluded count per reason (C6). Same mechanical filters as KPI definitions.

## Tests (when implemented)

- PG tests mirroring `client-usage.pg.test.ts` parity on totals vs aggregates.
- Property: no column matches IPv4 regex in persisted rows.