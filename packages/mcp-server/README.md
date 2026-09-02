# @vet402/mcp-server

MCP tools for checking [vet402](https://vet402.com) trust scores from Claude
Desktop, Cursor, or any MCP client — so an agent can ask *"is this wallet safe
to pay?"* before it pays.

Published on npm. No clone, no build: your MCP client launches it with `npx`.

```bash
npm install -g @vet402/mcp-server   # optional — the configs below use npx
```

## Tools

| Tool | Description |
|---|---|
| `check_agent_trust` | Score by agent ID (optional wallet verification) |
| `check_wallet_trust` | Score by wallet (x402 payer path) |
| `check_payee_trust` | Buyer-side: score a payment *recipient* before paying it (score + dataDepth + recommendation + `degraded` / `signalsUnavailable`) |
| `explain_trust_score` | Human-readable score breakdown (includes x402 + dataCoverage) |
| `attest_x402_payment` | Write settlement attestation after payment verification |
| `check_resource_decision` | 0.2.0 — Product spec §9.1: pre-payment decision for one x402 *resource* (`resourceId` = sha256 hex from `/api/v1/resolve?q=<url>`). Returns `decision` (`ALLOW_PAY` \| `REFUSE`), `safe_to_pay`, `refuse_reasons`, and the full `measurement` body (L0–L2 facts, `reason_codes`, `freshness`, `evidence`, `rules_version`). `role=payee` + `payer` asks the seller-side question instead |

### Reading a `check_payee_trust` result

The tool returns the API body verbatim. Two of its fields **override
`recommendation`**, and the tool description tells the model so:

- `degraded: true` — an input could not be read at all; the body is a refusal,
  not a measurement.
- `signalsUnavailable` non-empty — some inputs were not measured
  (`wallet_metrics`, `native_drain`, `usdc_drain`, `outcome_history`); the view
  is partial.

Either one means the payee was not fully checked, and an unchecked payee is not
a safe one. The same goes for a tool error, including `lookup_timeout`: no
answer is not an ALLOW.

## Setup — Claude Desktop

Get a key at [vet402.com/dashboard/keys](https://vet402.com/dashboard/keys),
then add this to `~/Library/Application Support/Claude/claude_desktop_config.json`
(`%APPDATA%\Claude\claude_desktop_config.json` on Windows) and restart the app:

```json
{
  "mcpServers": {
    "vouch": {
      "command": "npx",
      "args": ["-y", "@vet402/mcp-server"],
      "env": {
        "VOUCH_API_URL": "https://vet402.com/api/v1",
        "VOUCH_API_KEY": "vouch_live_your_key_here"
      }
    }
  }
}
```

## Setup — Cursor

Same block in `~/.cursor/mcp.json` (or a project-local `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "vouch": {
      "command": "npx",
      "args": ["-y", "@vet402/mcp-server"],
      "env": {
        "VOUCH_API_URL": "https://vet402.com/api/v1",
        "VOUCH_API_KEY": "vouch_live_your_key_here"
      }
    }
  }
}
```

Confirm it starts before wiring it into a client:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  | VOUCH_API_KEY=vouch_live_your_key_here npx -y @vet402/mcp-server
```

A `serverInfo` line comes back on stdout. The package also installs a
`vet402-mcp` binary, if you prefer `npx -p @vet402/mcp-server vet402-mcp`.

## Environment

| Variable | Default | Description |
|---|---|---|
| `VOUCH_API_KEY` | — | Required. [Create one here](https://vet402.com/dashboard/keys). |
| `VOUCH_API_URL` | `https://vet402.com/api/v1` | API base URL. Override only to point at another deployment. |
| `VOUCH_TIMEOUT_MS` | `10000` | Per-request timeout. Cannot be disabled — a lookup that never returns cannot be failed closed on. A malformed value falls back to the default rather than breaking every tool call. |

> **0.1.0 defaults `VOUCH_API_URL` to `http://localhost:3000/api/v1`** — a
> development default that shipped by accident. The configs above set it
> explicitly, so they are correct on every version; 0.1.1 and later default to
> the hosted API.

## Example prompts

- "Check trust for agent 42 on Base"
- "Is wallet 0xabc... safe to accept x402 payment from?"
- "Is it safe to pay wallet 0xdef...? Check its payee trust first"
- "Explain the trust score for agent 7"

## Building from the repo (contributors)

```bash
git clone https://github.com/kzmttkc/vet402.git
cd agent-trust/packages/mcp-server && npm install && npm run build
# then point your client at "command": "node", "args": ["<abs>/dist/index.js"]
```

## Links

- [MCP setup guide](https://github.com/kzmttkc/vet402/blob/main/docs/mcp-setup.md)
- [API docs](https://vet402.com/docs/api) · [OpenAPI spec](https://github.com/kzmttkc/vet402/blob/main/docs/openapi.yaml)
- [`@vet402/sdk`](https://www.npmjs.com/package/@vet402/sdk) — buyer side (SpendGuard)
- [`@vet402/middleware`](https://www.npmjs.com/package/@vet402/middleware) — seller side (x402 request gate)

MIT · [vet402](https://vet402.com)
