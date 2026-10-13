// @vet402/mcp-server names itself to vet402's API: `User-Agent: vet402-mcp/<version>`.
//
// The server counts key-less calls by client name (`src/lib/api/client-usage.ts`,
// DISTRIBUTED_CLIENTS) and reads the version as three groups of digits. Until this
// change the MCP server arrived as Node's default `node` and was counted as `other`.
//
// Where the name goes:
//   - the server's own lookups (scores, /decision, attest) and pay_if_trusted's
//     /resolve and /decision reads say `vet402-mcp/<version>`
//   - the payment itself is delegated to @vet402/sdk, whose own vet402 calls say
//     `vet402-sdk/<version>`
//   - requests to the seller (the 402 fetch and the paid re-send) carry neither name
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { MCP_VERSION, MCP_USER_AGENT } from "../dist/version.js";
import { fetchDecision, fetchPayeeScore, attestX402Payment } from "../dist/vouch-client.js";
import { payIfTrusted } from "../dist/pay-if-trusted.js";
import { resolveReply } from "./helpers/resolve.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const sdkPkg = JSON.parse(readFileSync(new URL("../../sdk/package.json", import.meta.url), "utf8"));
/** Same shape as the server's VERSION_RE: three groups of 1 to 3 digits. */
const SERVER_ACCEPTS = /^vet402-mcp\/\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const EXPECTED_UA = `vet402-mcp/${pkg.version}`;
const WALLET = "0x1111111111111111111111111111111111111111";

const userAgentOf = (headers = {}) => {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === "user-agent");
  return key === undefined ? undefined : headers[key];
};

/** Swap in a fake global fetch for one test, always restoring the real one. */
async function withFetch(fetchFn, env, body) {
  const realFetch = globalThis.fetch;
  const saved = { ...process.env };
  globalThis.fetch = fetchFn;
  for (const key of ["VOUCH_API_KEY", "VOUCH_API_URL", "VOUCH_TIMEOUT_MS"]) delete process.env[key];
  Object.assign(process.env, env);
  try {
    return await body();
  } finally {
    globalThis.fetch = realFetch;
    for (const key of ["VOUCH_API_KEY", "VOUCH_API_URL", "VOUCH_TIMEOUT_MS"]) {
      if (key in saved) process.env[key] = saved[key];
      else delete process.env[key];
    }
  }
}

test("MCP_VERSION equals package.json's version and has a shape the API reads", () => {
  // The version McpServer reports (the literal in src/index.ts) is pinned to package.json by the
  // repo-level tests/docs-surface-parity.test.ts. This pins the User-Agent's version the same way.
  assert.equal(MCP_VERSION, pkg.version);
  assert.equal(MCP_USER_AGENT, EXPECTED_UA);
  assert.match(MCP_USER_AGENT, SERVER_ACCEPTS);
});

test("the server's own lookups carry User-Agent: vet402-mcp/<version>, with and without a key", async () => {
  for (const env of [{ VOUCH_API_URL: "https://vet402.test/api/v1" }, { VOUCH_API_URL: "https://vet402.test/api/v1", VOUCH_API_KEY: "vouch_live_test" }]) {
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    await withFetch(fetchFn, env, async () => {
      await fetchDecision("a".repeat(64), { role: "payer" });
      await fetchPayeeScore(WALLET);
      await attestX402Payment({ wallet: WALLET, txHash: `0x${"a".repeat(64)}` });
    });
    assert.equal(calls.length, 3);
    for (const c of calls) assert.equal(userAgentOf(c.init.headers), EXPECTED_UA, c.url);
    assert.equal("Authorization" in calls[0].init.headers, "VOUCH_API_KEY" in env, "the key handling is unchanged");
    assert.equal(calls[2].init.headers["Content-Type"], "application/json");
  }
});

test("pay_if_trusted: /resolve and /decision say vet402-mcp, the SDK's own vet402 calls say vet402-sdk, the seller sees neither", async () => {
  const PAYEE = "0x79DC34E41B2b591078d3dE222C43EcaaBD52FcCB";
  const RESOURCE = "https://gateway.thegraph.com/api/x402/subgraphs/id/Cb56epg3EvQ6JRpPfknbkM54QxpzTvLa7mwKNQQfUyoj";
  const accept = { scheme: "exact", network: "eip155:8453", amount: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAYEE, extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" } };
  const b64 = (o) => btoa(JSON.stringify(o));
  const seen = [];
  const r = await payIfTrusted({
    resourceId: "a".repeat(64),
    signer: { address: "0xDB62BD202914609830fA656F87996b91be3Aa673", signTypedData: async () => "0xsig" },
    resource: RESOURCE, payee: PAYEE, amountUsd: 0.01, method: "POST",
    fetch: async (url, init) => {
      const u = String(url);
      const kind = u.includes("/resolve?") ? "resolve" : u.includes("/decision") ? "decision" : u.includes("/payments/x402") ? "attest" : u.startsWith(RESOURCE) ? "seller" : "other";
      seen.push({ kind, u, init });
      const resolved = resolveReply(url);
      if (resolved) return resolved;
      if (kind === "decision") {
        return { ok: true, status: 200, json: async () => ({ recommendation: "ALLOW", reason_codes: ["l0_pass", "l1_delivered"], facts: {}, evidence: [], degraded: false }), headers: new Map() };
      }
      if (kind === "attest") return { ok: true, status: 200, json: async () => ({ ok: true }), headers: new Map() };
      if (kind === "seller") {
        if (!(init?.headers ?? {})["PAYMENT-SIGNATURE"]) {
          return { ok: false, status: 402, json: async () => ({}), headers: new Map([["payment-required", b64({ x402Version: 2, accepts: [accept] })]]) };
        }
        return { ok: true, status: 200, json: async () => ({}), headers: new Map([["PAYMENT-RESPONSE", b64({ success: true, transaction: `0x${"b".repeat(64)}`, network: "eip155:8453" })]]) };
      }
      throw new Error(`unexpected call: ${u}`);
    },
  });
  assert.equal(r.decision, "PAID", r.refuse_reasons.join(","));
  const of = (kind) => seen.filter((s) => s.kind === kind);
  assert.equal(of("resolve").length, 1);
  assert.equal(userAgentOf(of("resolve")[0].init?.headers), EXPECTED_UA);
  // The decision is read twice: once by the MCP gate, once inside the SDK's payOrRefuse.
  assert.deepEqual(of("decision").map((s) => userAgentOf(s.init?.headers)), [EXPECTED_UA, `vet402-sdk/${sdkPkg.version}`]);
  assert.equal(of("attest").length, 1);
  assert.equal(userAgentOf(of("attest")[0].init?.headers), `vet402-sdk/${sdkPkg.version}`);
  assert.equal(of("seller").length, 2, "the 402 fetch and the paid re-send");
  for (const s of of("seller")) {
    assert.equal(userAgentOf(s.init?.headers), undefined, "the seller is not told which client is paying");
    assert.equal(JSON.stringify(s.init ?? {}).includes("vet402-"), false);
  }
});
