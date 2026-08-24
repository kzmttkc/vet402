# MCP Setup Guide

Connect vet402 trust tools to Claude Desktop, Cursor, or any MCP client.

The server is published as [`@vet402/mcp-server`](https://www.npmjs.com/package/@vet402/mcp-server).
There is nothing to clone or build — your MCP client launches it with `npx`.

## Prerequisites

An API key: create one at [vet402.com/dashboard/keys](https://vet402.com/dashboard/keys).
(Self-hosting the API? `npm run api-key:create` mints a database-backed key.)

## Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(`%APPDATA%\Claude\claude_desktop_config.json` on Windows), then restart the app:

```json
{
  "mcpServers": {
    "vouch": {
      "command": "npx",
      "args": ["-y", "@vet402/mcp-server"],
      "env": {
        "VOUCH_API_URL": "https://vet402.com/api/v1",
        "VOUCH_API_KEY": "vouch_live_..."
      }
    }
  }
}
```

## Cursor

1. Open **Cursor Settings → MCP** (or edit `~/.cursor/mcp.json`)
2. Add the same `vouch` block as above
3. Restart Cursor or reload MCP servers
4. In Agent chat, the model can call:
   - `check_agent_trust`
   - `check_wallet_trust`
   - `check_payee_trust`
   - `explain_trust_score`
   - `attest_x402_payment` (after payment verification)

## Verify before wiring it into a client

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  | VOUCH_API_KEY=vouch_live_... npx -y @vet402/mcp-server
```

A `serverInfo` line on stdout means the server starts and speaks MCP.

## Environment variables

| Variable | Required | Default |
|---|---|---|
| `VOUCH_API_KEY` | Yes | — |
| `VOUCH_API_URL` | No | `https://vet402.com/api/v1` |

> Version 0.1.0 defaulted `VOUCH_API_URL` to `http://localhost:3000/api/v1` — a
> development default that shipped by accident, so an installed server pointed
> at a port on the user's own machine. The configs above set the variable
> explicitly and are therefore correct on every version.

## Running against a local API

Point `VOUCH_API_URL` at your dev server and run the server from this repo:

```bash
cd packages/mcp-server && npm install && npm run build
```

```json
{
  "mcpServers": {
    "vouch-local": {
      "command": "node",
      "args": ["/absolute/path/to/agent-trust/packages/mcp-server/dist/index.js"],
      "env": {
        "VOUCH_API_URL": "http://localhost:3000/api/v1",
        "VOUCH_API_KEY": "vouch_live_..."
      }
    }
  }
}
```

## Troubleshooting

| Issue | Fix |
|---|---|
| `VOUCH_API_KEY is required` | The `env` block is missing the key, or the client did not pass it through |
| `invalid_api_key` | Use a database-backed key, not `DEV_API_KEY` in production |
| Connection refused | `VOUCH_API_URL` points at localhost — set it to `https://vet402.com/api/v1`, or start the local API |
| MCP server not listed | Restart the client; verify the JSON parses and `npx -y @vet402/mcp-server` runs standalone |
| Tools return errors | Verify `VOUCH_API_URL` includes `/api/v1` and has no trailing slash |

## Use cases

- **Agent runtime**: check counterparty trust before initiating x402 payment
- **Development**: inspect ERC-8004 agent scores from Cursor without curl
- **Support**: explain why a wallet received WARN or BLOCK
