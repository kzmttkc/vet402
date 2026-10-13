/**
 * How this server names itself to vet402's API.
 *
 * `User-Agent: vet402-mcp/<version>` goes on the server's own requests to vet402
 * (`vouch-client.ts`, and the `/resolve` and `/decision` reads in
 * `pay-if-trusted.ts`). The API counts key-less calls by this name
 * (`src/lib/api/client-usage.ts`, `DISTRIBUTED_CLIENTS`) and reads the version as
 * three groups of digits. The payment itself is delegated to `@vet402/sdk`, which
 * names itself `vet402-sdk/<version>` and sends neither name to a seller.
 */
/**
 * Kept equal to `package.json`'s `version` by `test/user-agent.test.mjs`. The version `McpServer`
 * reports stays a literal in `index.ts` (the repo-level `tests/docs-surface-parity.test.ts` reads it
 * there), so a release bumps three places: `package.json`, `index.ts` and this constant.
 */
export declare const MCP_VERSION = "0.3.1";
export declare const MCP_USER_AGENT = "vet402-mcp/0.3.1";
