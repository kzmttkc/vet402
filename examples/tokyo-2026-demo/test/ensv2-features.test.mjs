// node --test test/ensv2-features.test.mjs   (Node >= 22.18 strips the types of ../src/**/*.ts)
// admin.ts expiring / nontransferable / agent-context (PLAN_v4.3 section 1.4 U3, U8, U9): the calldata they build and
// the verdicts they print. No network: the chain facts were measured by the dry-runs, these pin the shapes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, encodeAbiParameters, labelhash, parseAbi } from "viem";

globalThis.fetch = async (url) => { throw new Error(`network forbidden in tokyo tests: ${String(url)}`); };

const K_AG2 = "0x6a2bce08AB14123954168C8c030b88FF1c5Bfa97";
const ZERO = "0x0000000000000000000000000000000000000000";
const REG = parseAbi(["function register(string label, address owner, address registry, address resolver, uint256 roleBitmap, uint64 expiry) returns (uint256)"]);
const XFER = parseAbi(["function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)"]);
const TEXT = parseAbi(["function setText(bytes name, string key, string value)"]);
const state = (status, owner) => ({ status, expiry: 100n, latestOwner: owner, tokenId: 1n, resource: 0n });

test("expiring: register agent-tmp with no resolver, no registry, no roles and the given expiry", async () => {
  const k = await import("../src/lib/k1.ts");
  const { functionName, args } = decodeFunctionData({ abi: REG, data: k.expiringRegisterData(K_AG2, 1234n) });
  assert.equal(functionName, "register");
  assert.deepEqual(args, ["agent-tmp", K_AG2, ZERO, ZERO, 0n, 1234n]);
  assert.equal(k.EXPIRING_SECONDS, 120);
});

test("expiring: refuses the live agent names and the reserved labels", async () => {
  const k = await import("../src/lib/k1.ts");
  for (const l of ["agent-1", "agent-2", "atst", "obs"]) assert.throws(() => k.expiringRegisterData(K_AG2, 1n, l), /既存か予約/);
});

test("expiring verdict: REGISTERED + owner before, AVAILABLE + 0x0 (ens_name_unresolved) after", async () => {
  const k = await import("../src/lib/k1.ts");
  assert.equal(k.expiringVerdict(K_AG2, { state: state(2, K_AG2), exact: K_AG2 }, { state: state(0, K_AG2), exact: ZERO }), null);
  assert.match(k.expiringVerdict(K_AG2, { state: state(2, K_AG2), exact: K_AG2 }, { state: state(2, K_AG2), exact: K_AG2 }), /期限の後の status が REGISTERED.*findExactOwner/);
  assert.match(k.expiringVerdict(K_AG2, { state: state(0, ZERO), exact: ZERO }, { state: state(0, ZERO), exact: ZERO }), /期限の前/);
});

test("decodeState reads the getState tuple", async () => {
  const k = await import("../src/lib/k1.ts");
  const ret = encodeAbiParameters(
    [{ type: "tuple", components: [{ type: "uint8" }, { type: "uint64" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }] }],
    [[2, 99n, K_AG2, 7n, 8n]],
  );
  assert.deepEqual(k.decodeState(ret), { status: 2, expiry: 99n, latestOwner: K_AG2, tokenId: 7n, resource: 8n });
  assert.equal(k.getStateData("agent-tmp").slice(-64), labelhash("agent-tmp").slice(2));
});

test("nontransferable: one token, amount 1, empty data; verdict wants TransferDisallowed on agent-1 and a pass on agent-2", async () => {
  const k = await import("../src/lib/k1.ts");
  const { args } = decodeFunctionData({ abi: XFER, data: k.transferData(K_AG2, k.NO_KEY_RECIPIENT, 5n) });
  assert.deepEqual(args, [K_AG2, k.NO_KEY_RECIPIENT, 5n, 1n, "0x"]);
  assert.equal(k.nontransferableVerdict({ ok: false, error: "TransferDisallowed(0x1,0x2)" }, { ok: true }), null);
  assert.match(k.nontransferableVerdict({ ok: true }, { ok: true }), /通ってしまう/);
  assert.match(k.nontransferableVerdict({ ok: false, error: "EACUnauthorizedAccountRoles(0x1,0x10,0x2)" }, { ok: true }), /理由が EACUnauthorized/);
  assert.match(k.nontransferableVerdict({ ok: false, error: "TransferDisallowed(0x1,0x2)" }, { ok: false, error: "X" }), /agent-2 の移転が revert/);
});

test("agent-context: ENSIP-26 key on agent-1.vet402.eth, plain facts, no address or amount in the text", async () => {
  const k = await import("../src/lib/k1.ts");
  const { args } = decodeFunctionData({ abi: TEXT, data: k.agentContextData() });
  assert.equal(args[0], k.dns("agent-1.vet402.eth"));
  assert.equal(args[1], "agent-context");
  assert.equal(args[2], k.AGENT_CONTEXT);
  assert.match(k.AGENT_CONTEXT, /x402-policy/);
  assert.doesNotMatch(k.AGENT_CONTEXT, /0x[0-9a-fA-F]{40}/);
  assert.ok(Buffer.byteLength(k.AGENT_CONTEXT) < 512);
});

test("decodeResolvedTextAndResolver returns the value and the answering resolver", async () => {
  const k = await import("../src/lib/k1.ts");
  const P_AG1 = "0xd3F4818c0bB93e54780525b21380D44D6D06bcd6";
  const inner = encodeAbiParameters([{ type: "string" }], ["hello"]);
  const ret = encodeAbiParameters([{ type: "bytes" }, { type: "address" }], [inner, P_AG1]);
  assert.deepEqual(k.decodeResolvedTextAndResolver(ret), { value: "hello", resolver: P_AG1 });
  assert.deepEqual(k.decodeResolvedTextAndResolver("0x"), { value: undefined, resolver: undefined });
});
